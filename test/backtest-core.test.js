'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');
const { makeKlines } = require('../testlib/load-inline');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));   // vm 沙箱里的对象与主上下文不同 realm

const H = 3600e3;
// 手工构造 K 线：[openTime, open, high, low, close, volume]，价格全部显式给出
function bars(rows) {
  return rows.map((r, i) => [i * H, String(r[0]), String(r[1]), String(r[2]), String(r[3]), '1', i * H + H - 1]);
}
const NO_COST = { fee: 0, slip: 0, funding: 0 };
const FULL = { tpR: 2, maxHold: 5, useDaily: false, noOverlap: true };
const longSig = (i, extra) => Object.assign({ i, ts: i * H, score: 70, dir: 'long', entry: 100, stop: 99, risk: 1, atr: 1 }, extra);
const shortSig = (i, extra) => Object.assign({ i, ts: i * H, score: 30, dir: 'short', entry: 100, stop: 101, risk: 1, atr: 1 }, extra);

test('多单止盈：按 tpR 倍数出场，毛收益 = +tpR', () => {
  const kl = bars([[100, 100, 100, 100], [100, 101, 99.5, 100.5], [100.5, 102.5, 100, 102], [102, 103, 101, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102]]);
  const r = plain(E.btRunSignals([longSig(0)], kl, null, '1h', FULL, NO_COST));
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, '止盈');
  assert.equal(r.trades[0].exit, 102);
  assert.equal(r.trades[0].grossR, 2);
  assert.equal(r.trades[0].bars, 2);
});

test('同一根 K 线内止损与止盈都被触及：按先止损（保守）', () => {
  const kl = bars([[100, 100, 100, 100], [100, 103, 98.5, 101], [101, 101, 101, 101], [101, 101, 101, 101], [101, 101, 101, 101], [101, 101, 101, 101], [101, 101, 101, 101]]);
  const r = plain(E.btRunSignals([longSig(0)], kl, null, '1h', FULL, NO_COST));
  assert.equal(r.trades[0].reason, '止损');
  assert.equal(r.trades[0].grossR, -1);
});

test('跳空越过止损价：按开盘价成交，亏损大于 1R', () => {
  const kl = bars([[100, 100, 100, 100], [97, 98, 96, 97], [97, 97, 97, 97], [97, 97, 97, 97], [97, 97, 97, 97], [97, 97, 97, 97], [97, 97, 97, 97]]);
  const r = plain(E.btRunSignals([longSig(0)], kl, null, '1h', FULL, NO_COST));
  assert.equal(r.trades[0].reason, '止损(跳空)');
  assert.equal(r.trades[0].exit, 97);
  assert.equal(r.trades[0].grossR, -3);
  // 空单对称：向上跳空越过止损
  const kl2 = bars([[100, 100, 100, 100], [104, 105, 103, 104], [104, 104, 104, 104], [104, 104, 104, 104], [104, 104, 104, 104], [104, 104, 104, 104], [104, 104, 104, 104]]);
  const r2 = plain(E.btRunSignals([shortSig(0)], kl2, null, '1h', FULL, NO_COST));
  assert.equal(r2.trades[0].reason, '止损(跳空)');
  assert.equal(r2.trades[0].grossR, -4);
});

test('空单止盈与到期出场', () => {
  const kl = bars([[100, 100, 100, 100], [100, 100.5, 97.5, 98], [98, 98, 98, 98], [98, 98, 98, 98], [98, 98, 98, 98], [98, 98, 98, 98], [98, 98, 98, 98]]);
  const r = plain(E.btRunSignals([shortSig(0)], kl, null, '1h', FULL, NO_COST));
  assert.equal(r.trades[0].reason, '止盈');
  assert.equal(r.trades[0].grossR, 2);
  // 到期：窗口内既没到止损也没到止盈 → 按最后一根收盘价
  const flat = bars([[100, 100, 100, 100], [100, 100.4, 99.6, 100.2], [100.2, 100.4, 99.6, 100.1], [100.1, 100.4, 99.6, 100.3], [100.3, 100.4, 99.6, 100.5], [100.5, 100.6, 99.8, 100.6], [100.6, 100.6, 100.6, 100.6]]);
  const r2 = plain(E.btRunSignals([longSig(0)], flat, null, '1h', FULL, NO_COST));
  assert.equal(r2.trades[0].reason, '到期');
  assert.equal(r2.trades[0].bars, 5);
  assert.ok(Math.abs(r2.trades[0].grossR - 0.6) < 1e-9);
});

test('成本模型：手续费 / 滑点 / 资金费率按 R 折算', () => {
  const kl = bars([[100, 100, 100, 100], [100, 100.4, 99.6, 100], [100, 100.4, 99.6, 100], [100, 102.5, 99.6, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102]]);
  const r = plain(E.btRunSignals([longSig(0)], kl, null, '1h', FULL, { fee: 0.08, slip: 0.02, funding: 0.01 }));
  const t = r.trades[0];
  // risk = 1, entry = 100 → riskPct = 1%
  assert.ok(Math.abs(t.feeR - 0.08) < 1e-9, 'feeR ' + t.feeR);                    // 0.08% / 1%
  assert.ok(Math.abs(t.slipR - 0.04) < 1e-9, 'slipR ' + t.slipR);                 // 2 × 0.02% / 1%
  assert.ok(Math.abs(t.fundR - 0.01 / 100 * (3 / 8) / 0.01) < 1e-9, 'fundR ' + t.fundR);   // 持有 3 根 1h
  assert.ok(Math.abs(t.netR - (2 - t.feeR - t.slipR - t.fundR)) < 1e-9);
});

test('同一币种不重叠持仓：持仓期内的新信号被跳过；关闭开关则全部计入', () => {
  const kl = bars([[100, 100, 100, 100], [100, 100.4, 99.6, 100], [100, 100.4, 99.6, 100], [100, 102.5, 99.6, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102], [102, 102, 102, 102]]);
  const sigs = [longSig(0), longSig(1), longSig(2), longSig(4, { entry: 102, stop: 101, ts: 4 * H })];
  const a = plain(E.btRunSignals(sigs, kl, null, '1h', FULL, NO_COST));
  assert.equal(a.trades.length, 2, '第 0 笔在 3 号 K 线出场，其间的 1、2 被跳过，4 号可以开仓');
  assert.equal(a.overlapSkipped, 2);
  const b = plain(E.btRunSignals(sigs, kl, null, '1h', Object.assign({}, FULL, { noOverlap: false }), NO_COST));
  assert.equal(b.trades.length, 4);
});

test('持仓窗口超出数据末尾的信号不计入', () => {
  const kl = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const r = plain(E.btRunSignals([longSig(1)], kl, null, '1h', FULL, NO_COST));
  assert.equal(r.trades.length, 0);
  assert.equal(r.truncated, 1);
});

test('btFullStats：期望的 95% 置信区间；样本太少时为 null', () => {
  const mk = (arr) => arr.map((x) => ({ netR: x, bars: 1, reason: '止盈' }));
  const st = plain(E.btFullStats(mk([2, -1, 2, -1, 2, -1, 2, -1, 2, -1])));
  assert.ok(st.avgLo < st.avgR && st.avgR < st.avgHi);
  assert.ok(st.avgLo < 0, '10 笔样本下区间应跨过 0');
  assert.equal(plain(E.btFullStats(mk([1]))).avgLo, null);
});

test('btWindows / btMergeTrades / btBlockBootstrap', () => {
  const trades = Array.from({ length: 40 }, (_, i) => ({ ts: i, netR: i % 3 === 0 ? -1 : 1, bars: 1, reason: 'x' }));
  const w = plain(E.btWindows(trades, 4));
  assert.equal(w.length, 4);
  assert.equal(w.reduce((a, x) => a + x.stats.n, 0), 40);
  assert.deepEqual(plain(E.btWindows(trades.slice(0, 5), 4)), [], '样本太少不分窗');

  const merged = plain(E.btMergeTrades([{ sym: 'A', trades: [{ ts: 3 }, { ts: 1 }] }, { sym: 'B', trades: [{ ts: 2 }] }]));
  assert.deepEqual(merged.map((t) => t.sym + t.ts), ['A1', 'B2', 'A3']);

  const bb = plain(E.btBlockBootstrap(trades, 200, 5));
  assert.equal(bb.block, 5);
  assert.ok(bb.finalP5 <= bb.finalP50 && bb.finalP50 <= bb.finalP95);
  assert.equal(E.btBlockBootstrap(trades.slice(0, 5), 100), null);
});

test('btCollectSignals + btSweep：信号只算一次，各参数组合可比', async () => {
  const IV = 3600e3;
  const kl = makeKlines({ n: 700, intervalMs: IV, endOpenTime: 1.7e12, start: 100, drift: 0.0004, vol: 0.02, seed: 4242 });
  const cfg = { tf: '1h', bars: 400, step: 4, sym: 'TESTUSDT' };
  const sc = await E.btCollectSignals(kl, cfg, 96, {});
  const sig = plain(sc.signals);
  assert.ok(sig.length > 5, '合成数据上应能产生一些信号，实际 ' + sig.length);
  for (const s of sig) {
    assert.ok(['long', 'short'].includes(s.dir));
    assert.ok(s.risk > 0 && s.entry > 0);
    assert.equal((s.i - sc.start) % cfg.step, 0, '采样步长应均匀');
    assert.equal(s.dir === 'long' ? s.stop < s.entry : s.stop > s.entry, true);
  }
  const rows = plain(E.btSweep(sc.signals, kl, null, '1h', { useDaily: false, noOverlap: true }, NO_COST, [1, 2], [12, 48]));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.tpR + '/' + r.maxHold), ['1/12', '1/48', '2/12', '2/48']);
  // 中止钩子
  await assert.rejects(E.btCollectSignals(kl, cfg, 96, { isAborted: () => true }), /__aborted__/);
});
