'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInline, makeKlines } = require('../testlib/load-inline');

const MIN = 60e3;
const IV = { '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN };

// 以「现在」为基准造 K 线：最后一根的开盘时间 = 当前周期起点，closeTime 在未来（未收盘）
function klinesFor(iv, n, extra) {
  const step = IV[iv];
  const endOpen = Math.floor(Date.now() / step) * step;
  return makeKlines(Object.assign({ n, intervalMs: step, endOpenTime: endOpen, start: 100, drift: 0.001, vol: 0.012, seed: 99 }, extra));
}

test('dropOpenCandle：未收盘的最后一根被剔除，已收盘的保留', () => {
  const { ctx } = loadInline();
  const rows = klinesFor('1h', 10);
  const last = rows[rows.length - 1];
  assert.ok(last[6] > Date.now(), '构造的最后一根应当未收盘');
  const out = ctx.dropOpenCandle(rows);
  assert.equal(out.length, rows.length - 1);
  assert.equal(out[out.length - 1][0], rows[rows.length - 2][0]);

  // 全部已收盘：原样返回
  const closed = rows.slice(0, -1);
  assert.equal(ctx.dropOpenCandle(closed).length, closed.length);
  // 空数组 / 非数组：不抛错
  assert.deepEqual(ctx.dropOpenCandle([]), []);
  assert.equal(ctx.dropOpenCandle(null), null);
});

test('dropOpenCandle：用缓存兜底时按「缓存写入时刻」判断，当时没走完的那根不能当成已收盘', () => {
  const { ctx } = loadInline();
  // 缓存写入于 1 小时前；那时最后一根的 closeTime 在写入时刻之后 → 当时是未收盘的
  const cachedAt = Date.now() - 3600e3;
  const rows = makeKlines({ n: 10, intervalMs: 15 * MIN, endOpenTime: cachedAt - 5 * MIN, start: 100, seed: 5 });
  assert.ok(rows[rows.length - 1][6] >= cachedAt);
  assert.equal(ctx.dropOpenCandle(rows, cachedAt).length, 9);
  // 如果拿「现在」判断，它会被误认成已收盘
  assert.equal(ctx.dropOpenCandle(rows).length, 10);
});

function mockApi(lastCloseMul) {
  return {
    getKlines: async (sym, iv, limit) => klinesFor(iv, limit, { lastCloseMul })
  };
}

test('analyzeMultiTimeframe：评分与未收盘 K 线无关，现价则跟随最新一笔', async () => {
  const a1 = loadInline({ binanceAPI: mockApi(1.0) });
  const a2 = loadInline({ binanceAPI: mockApi(1.2) });   // 未收盘那根被拉高 20%
  const r1 = await a1.ctx.analyzeMultiTimeframe('AAA');
  const r2 = await a2.ctx.analyzeMultiTimeframe('AAA');
  assert.ok(r1 && r2, '应能得到分析结果');
  assert.equal(r1.score, r2.score, '未收盘 K 线的波动不应改变评分');
  // vm 沙箱里的数组与主上下文不同 realm，先转成 JSON 再比较
  assert.equal(JSON.stringify(r1.signals.map((s) => s.n)), JSON.stringify(r2.signals.map((s) => s.n)));
  assert.ok(Math.abs(r2.price / r1.price - 1.2) < 1e-9, 'price 应为最新价（含未收盘那根）');
  assert.equal(r2.livePrice, r2.price);
  // 用于分析的 K 线都是已收盘的
  for (const tf of Object.keys(r1.tfOhlc)) {
    const rows = r1.tfOhlc[tf];
    assert.ok(rows[rows.length - 1][0] + IV[tf] <= Date.now(), tf + ' 周期的最后一根应已收盘');
  }
});

test('calcRiskReward：入场价取最新价而不是最后一根已收盘 K 线的收盘价', () => {
  const { ctx } = loadInline();
  const ohlc = klinesFor('4h', 150).slice(0, -1).map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
  const lastClose = ohlc[ohlc.length - 1][4];
  const live = lastClose * 1.01;
  const analysis = { score: 66, signals: [] };
  const withLive = ctx.calcRiskReward(analysis, ohlc, live);
  const without = ctx.calcRiskReward({ score: 66, signals: [] }, ohlc);
  assert.ok(withLive && without, '应给出风险回报');
  assert.equal(withLive.direction, 'long');
  assert.equal(withLive.entry, live);
  assert.equal(without.entry, lastClose);
  assert.ok(withLive.stopLoss < withLive.entry, '多单止损应低于入场价');
});
