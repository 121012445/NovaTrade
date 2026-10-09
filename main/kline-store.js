'use strict';
// 本地历史 K 线库（落盘 + 增量更新），给长周期回测用。
//
// 单次接口最多 1000~1500 根（1h 约 62 天），回测想测几个月 / 几年就必须分页拉取。每次都重拉既慢又浪费限额，
// 所以按「交易对 + 周期」存成一个 JSON 文件（userData/klines/），之后只增量补最新的、按需向前补更早的。
//
// 存储格式：{ v:1, sym, iv, exhausted, rows:[[openTime,o,h,l,c,volume,closeTime], ...] }，数值全部是 number，按 openTime 升序、无重复。
// 返回给渲染层的是同样的数组（与币安原始格式前 7 列一致，渲染层的 parseFloat 对 number 同样适用）。
const fs = require('fs');
const path = require('path');

const IV_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3, '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3 };
const MAX_ROWS = 300000;

// deps: { dir, fetchPage(sym, iv, startTime, limit) -> raw rows, now?, log?, pageSize?, maxPages?, pauseMs? }
function createKlineStore(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || function () {};
  const pageSize = deps.pageSize || 1500;
  const maxPages = deps.maxPages || 200;
  const pauseMs = deps.pauseMs === undefined ? 120 : deps.pauseMs;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const inflight = new Map();

  function fileOf(sym, iv) { return path.join(deps.dir, sym + '_' + iv + '.json'); }

  function readFile(sym, iv) {
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(sym, iv), 'utf8'));
      if (j && j.v === 1 && Array.isArray(j.rows)) return { rows: j.rows, exhausted: !!j.exhausted };
    } catch (e) { /* 没有或已损坏：当作空库重新拉 */ }
    return { rows: [], exhausted: false };
  }

  function writeFile(sym, iv, st) {
    fs.mkdirSync(deps.dir, { recursive: true });
    const f = fileOf(sym, iv), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, sym, iv, exhausted: st.exhausted, rows: st.rows }));
    fs.renameSync(tmp, f);
  }

  const norm = (r) => [Number(r[0]), parseFloat(r[1]), parseFloat(r[2]), parseFloat(r[3]), parseFloat(r[4]), parseFloat(r[5]), Number(r[6])];

  // 合并（同一 openTime 以新数据为准，如还在走的最后一根被收盘版本替换），保持升序
  function merge(rows, add) {
    const map = new Map(rows.map((r) => [r[0], r]));
    for (const a of add) { const n = norm(a); if (Number.isFinite(n[0]) && n[4] > 0) map.set(n[0], n); }
    const out = [...map.values()].sort((x, y) => x[0] - y[0]);
    return out.length > MAX_ROWS ? out.slice(out.length - MAX_ROWS) : out;
  }

  // 从 start 起向后分页拉取，直到没有更多或到达 stopBefore（不含）。返回新增的原始行。
  async function pageForward(sym, iv, start, stopBefore) {
    const got = [];
    let cursor = start;
    for (let p = 0; p < maxPages; p++) {
      const chunk = await deps.fetchPage(sym, iv, cursor, pageSize);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      got.push(...chunk);
      const lastOpen = Number(chunk[chunk.length - 1][0]);
      cursor = lastOpen + 1;
      if (chunk.length < pageSize) break;
      if (stopBefore !== undefined && lastOpen >= stopBefore) break;
      await sleep(pauseMs);
    }
    return got;
  }

  async function doGet(sym, iv, want) {
    const ivMs = IV_MS[iv];
    if (!ivMs) throw new Error('unsupported interval ' + iv);
    const st = readFile(sym, iv);
    const nowMs = now();
    const needStart = nowMs - want * ivMs;
    let changed = false, fetchErr = null;

    try {
      // 1) 向前补到最新：库为空则从 needStart 起拉；否则从最后一根（可能还没收盘）起重拉
      const from = st.rows.length ? st.rows[st.rows.length - 1][0] : needStart;
      const fresh = st.rows.length === 0 || nowMs - st.rows[st.rows.length - 1][6] > 0;   // 最后一根已收盘 → 有新数据可拉
      if (fresh) {
        const add = await pageForward(sym, iv, from);
        if (add.length) { st.rows = merge(st.rows, add); changed = true; }
      }
      // 2) 向前（更早）补：库里最早的一根比需要的起点晚，且之前没有确认过「已经到头」
      if (st.rows.length && !st.exhausted && st.rows[0][0] > needStart + ivMs) {
        const firstOpen = st.rows[0][0];
        const add = await pageForward(sym, iv, needStart, firstOpen - ivMs);
        const older = add.filter((r) => Number(r[0]) < firstOpen);
        if (older.length) { st.rows = merge(st.rows, older); changed = true; }
        // 补完最早一根仍然比需要的晚很多：说明交易对上市时间就是那么晚，之后不用再试
        if (st.rows[0][0] > needStart + 2 * ivMs) { st.exhausted = true; changed = true; }
      }
    } catch (e) {
      fetchErr = e;
      log('[kline-store] fetch failed ' + sym + ' ' + iv + ': ' + e.message);
    }
    if (changed) { try { writeFile(sym, iv, st); } catch (e) { log('[kline-store] write failed: ' + e.message); } }
    if (!st.rows.length) throw fetchErr || new Error('no data for ' + sym + ' ' + iv);
    return { rows: st.rows.slice(-want), stale: !!fetchErr, total: st.rows.length };
  }

  // 同一个 (交易对, 周期) 的并发请求合并成一次，避免重复分页
  function get(sym, iv, want) {
    const w = Math.max(1, Math.min(200000, Math.floor(want) || 1));
    const key = sym + '|' + iv + '|' + w;
    if (inflight.has(key)) return inflight.get(key);
    const p = doGet(sym, iv, w).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { get, _readFile: readFile, _fileOf: fileOf };
}

module.exports = { createKlineStore, IV_MS };
