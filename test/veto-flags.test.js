'use strict';
// 回归测试：多周期合并结果上的否决标记必须与「按最终评分重新计算」一致。
// 旧实现里 merged = Object.assign({}, 4h 单周期分析结果)，会把 4h 单独评分时打上的
// overheatVeto / nearSupportVeto / stopCapVeto 原样带过来；之后按合并评分重算风险回报时只会「置 true」、从不清除，
// 结果是：合并后本该放行的信号，仍因 4h 单周期的旧标记被拦截（信号台账里显示「已拦截」）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInline, makeKlines } = require('../testlib/load-inline');

const IV = { '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
const FLAGS = ['overheatVeto', 'nearSupportVeto', 'stopCapVeto'];

function api(seed) {
  return {
    getKlines: async (sym, iv, limit) => {
      const step = IV[iv];
      const endOpen = Math.floor(Date.now() / step) * step;
      // 不同周期用不同的种子与波动，制造「4h 单周期评分」与「合并评分」不同的情形
      return makeKlines({ n: limit, intervalMs: step, endOpenTime: endOpen, start: 100, drift: iv === '4h' ? 0.004 : -0.0005, vol: iv === '4h' ? 0.03 : 0.012, seed: seed * 7 + step % 97 });
    }
  };
}

test('calcRiskReward 每次都按本次评分重新判定否决标记（先清除旧标记）', () => {
  const { ctx } = loadInline();
  const ohlc = makeKlines({ n: 150, intervalMs: IV['4h'], endOpenTime: 1.7e12, start: 100, drift: 0.001, vol: 0.01, seed: 3 })
    .map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
  const a = { score: 66, signals: [], overheatVeto: true, nearSupportVeto: true, stopCapVeto: true };
  const rr = ctx.calcRiskReward(a, ohlc);
  assert.ok(rr, '66 分不在过热区，应给出风险回报');
  for (const f of FLAGS) assert.equal(a[f], false, f + ' 应被清除');
  const b = { score: 72, signals: [] };
  assert.equal(ctx.calcRiskReward(b, ohlc), null);
  assert.equal(b.overheatVeto, true, '过热区仍应打标');
});

test('applyBtcRegime 每次重新判定 shortVeto', () => {
  const { ctx } = loadInline();
  ctx.window.__btcRegime = { score: 30, adx: 30, ts: Date.now() };   // BTC 偏空：不应否决做空
  const a = { symbol: 'ETHUSDT', score: 30, signals: [], shortVeto: true };
  ctx.applyBtcRegime(a);
  assert.equal(a.shortVeto, false);
  ctx.window.__btcRegime = null;                                      // 没有 BTC 数据：也不应保留旧标记
  const b = { symbol: 'ETHUSDT', score: 30, signals: [], shortVeto: true };
  ctx.applyBtcRegime(b);
  assert.equal(b.shortVeto, false);
});

test('analyzeMultiTimeframe：合并结果的否决标记 = 按合并评分与同一份数据重新计算的结果', async () => {
  let checked = 0, flagged = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { ctx } = loadInline({ binanceAPI: api(seed) });
    const m = await ctx.analyzeMultiTimeframe('S' + seed);
    if (!m) continue;
    const ohlc = m.tfOhlc[m.baseTf] || m.tfOhlc['1h'] || m.tfOhlc['4h'];
    const fresh = { score: m.score, signals: [], shortVeto: m.shortVeto };
    ctx.calcRiskReward(fresh, ohlc, m.livePrice);
    for (const f of FLAGS) {
      assert.equal(!!m[f], !!fresh[f], 'seed=' + seed + ' ' + f + ' 不一致（合并评分 ' + m.score + '）');
      if (fresh[f]) flagged++;
    }
    checked++;
  }
  assert.ok(checked > 40, '应有足够多的样本被检查，实际 ' + checked);
});
