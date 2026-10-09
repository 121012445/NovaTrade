'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKlineStore, IV_MS } = require('../main/kline-store');

const H = IV_MS['1h'];
// 假交易所：从 listing 起每小时一根，最后一根（当前小时）未收盘
function exchange(listing, clock) {
  const calls = [];
  const fetchPage = async (sym, iv, start, limit) => {
    calls.push({ start, limit });
    if (exchange.fail) throw new Error('network down');
    const now = clock.t;
    const rows = [];
    let t = Math.max(Math.ceil(start / H) * H, Math.ceil(listing / H) * H);
    for (; t <= Math.floor(now / H) * H && rows.length < limit; t += H) {
      rows.push([t, String(100 + (t / H) % 7), String(101), String(99), String(100 + (t / H) % 5), '10', t + H - 1]);
    }
    return rows;
  };
  return { fetchPage, calls };
}
exchange.fail = false;
const mk = (listingHoursAgo, pageSize, clock) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ks-'));
  const ex = exchange(clock.t - listingHoursAgo * H, clock);
  const store = createKlineStore({ dir, fetchPage: ex.fetchPage, now: () => clock.t, pageSize, pauseMs: 0 });
  return { dir, ex, store };
};
const ascUnique = (rows) => rows.every((r, i) => i === 0 || r[0] === rows[i - 1][0] + H);

test('冷启动：分页拉取足够的根数，升序无重复，并落盘', async () => {
  exchange.fail = false;
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { dir, ex, store } = mk(10000, 1000, clock);
  const r = await store.get('AAAUSDT', '1h', 3000);
  assert.equal(r.rows.length, 3000);
  assert.ok(ascUnique(r.rows));
  assert.ok(ex.calls.length >= 3 && ex.calls.length <= 4, '分页次数 ' + ex.calls.length);
  assert.ok(fs.existsSync(path.join(dir, 'AAAUSDT_1h.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'AAAUSDT_1h.json.tmp')), '不应残留临时文件');
  assert.equal(r.rows[0].length, 7);
  assert.equal(typeof r.rows[0][1], 'number');
});

test('增量更新：只拉最新的；还在走的最后一根被收盘版本替换', async () => {
  exchange.fail = false;
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { ex, store } = mk(10000, 1000, clock);
  const a = await store.get('AAAUSDT', '1h', 500);
  const lastOpen = a.rows[a.rows.length - 1][0];
  assert.ok(a.rows[a.rows.length - 1][6] > clock.t, '最后一根当时未收盘');
  clock.t += 5 * H;                                  // 5 小时后
  ex.calls.length = 0;
  const b = await store.get('AAAUSDT', '1h', 500);
  assert.equal(ex.calls.length, 1, '只需要一次增量请求');
  assert.equal(ex.calls[0].start, lastOpen, '从上次最后一根开始重拉');
  assert.equal(b.rows.length, 500);
  assert.ok(ascUnique(b.rows));
  const replaced = b.rows.find((r) => r[0] === lastOpen);
  assert.ok(replaced[6] < clock.t, '原先未收盘的那根现在已是收盘版本');
});

test('需要更长历史：只向前（更早）补，不重复拉已有部分', async () => {
  exchange.fail = false;
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { ex, store } = mk(10000, 1000, clock);
  await store.get('AAAUSDT', '1h', 1000);
  ex.calls.length = 0;
  const r = await store.get('AAAUSDT', '1h', 4000);
  assert.equal(r.rows.length, 4000);
  assert.ok(ascUnique(r.rows));
  const needStart = clock.t - 4000 * H;
  assert.ok(ex.calls.some((c) => c.start <= needStart + H), '应从更早的起点开始补');
  assert.ok(r.rows[0][0] <= needStart + 2 * H);
});

test('上市时间比需求晚：返回现有全部并标记已到头，之后不再尝试补更早的', async () => {
  exchange.fail = false;
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { ex, store } = mk(700, 1000, clock);
  const r = await store.get('NEWUSDT', '1h', 5000);
  assert.ok(r.rows.length >= 700 && r.rows.length <= 702, '实际 ' + r.rows.length);
  assert.equal(store._readFile('NEWUSDT', '1h').exhausted, true);
  ex.calls.length = 0;
  clock.t += H;
  await store.get('NEWUSDT', '1h', 5000);
  assert.ok(ex.calls.every((c) => c.start >= clock.t - 3 * H), '只允许增量请求，不应再回头补更早的: ' + JSON.stringify(ex.calls));
});

test('网络失败：有缓存则返回缓存（标记 stale），没有缓存则抛错；文件损坏时重新拉取', async () => {
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { dir, store } = mk(10000, 1000, clock);
  exchange.fail = true;
  await assert.rejects(store.get('ZZZUSDT', '1h', 100), /network down/);
  exchange.fail = false;
  await store.get('ZZZUSDT', '1h', 100);
  clock.t += 3 * H;
  exchange.fail = true;
  const r = await store.get('ZZZUSDT', '1h', 100);
  assert.equal(r.stale, true);
  assert.equal(r.rows.length, 100);
  exchange.fail = false;
  fs.writeFileSync(path.join(dir, 'ZZZUSDT_1h.json'), '{"broken');
  const r2 = await store.get('ZZZUSDT', '1h', 100);
  assert.equal(r2.rows.length, 100);
});

test('并发的相同请求合并为一次；不支持的周期被拒绝', async () => {
  exchange.fail = false;
  const clock = { t: Date.UTC(2026, 9, 1, 12, 30) };
  const { ex, store } = mk(10000, 1000, clock);
  await Promise.all([store.get('CCCUSDT', '1h', 2000), store.get('CCCUSDT', '1h', 2000), store.get('CCCUSDT', '1h', 2000)]);
  const n = ex.calls.length;
  assert.ok(n <= 3, '三个并发请求只应分页一次，实际调用 ' + n);
  await assert.rejects(store.get('CCCUSDT', '7m', 10), /unsupported interval/);
});
