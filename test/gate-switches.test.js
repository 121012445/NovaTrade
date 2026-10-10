'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInline, makeKlines } = require('../testlib/load-inline');

const ohlc = makeKlines({ n: 150, intervalMs: 14400e3, endOpenTime: 1.7e12, start: 100, drift: 0.001, vol: 0.01, seed: 3 })
  .map((k) => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('默认全部开启：与原行为一致（过热区拦截、空头门槛 39）', () => {
  const { ctx } = loadInline();
  assert.deepEqual(plain(ctx.gateCfg()), { overheat: true, daily: true, stopCap: true, score39: true, btcVeto: true, nearSup: true });
  assert.equal(ctx.__get('SHORT_SCORE_MIN'), 39);
  const a = { score: 72, signals: [] };
  assert.equal(ctx.calcRiskReward(a, ohlc), null);
  assert.equal(a.overheatVeto, true);
  assert.equal(a.gateHits.overheat, true);
});

test('关闭过热区：72 分照常给出风险回报，但仍记录「本来会被拦」', () => {
  const { ctx } = loadInline();
  ctx.saveGateCfg({ overheat: false });
  const a = { score: 72, signals: [] };
  const rr = ctx.calcRiskReward(a, ohlc);
  assert.ok(rr && rr.direction === 'long');
  assert.equal(a.overheatVeto, false);
  assert.equal(a.gateHits.overheat, true);
});

test('关闭空头评分门槛：做空阈值放宽到 45', () => {
  const { ctx } = loadInline();
  ctx.saveGateCfg({ score39: false });
  assert.equal(ctx.__get('SHORT_SCORE_MIN'), 45);
  const a = { score: 42, signals: [] };
  const rr = ctx.calcRiskReward(a, ohlc);
  if (rr) assert.equal(rr.direction, 'short');
  else assert.ok(a.gateHits.nearSup || a.gateHits.stopCap, '只可能被其他门控拦下');
  ctx.saveGateCfg({});
  assert.equal(ctx.__get('SHORT_SCORE_MIN'), 39, '恢复默认后阈值回到 39');
});

test('关闭 BTC 否决：只记录命中，不再否决做空', () => {
  const { ctx } = loadInline();
  ctx.window.__btcRegime = { score: 80, adx: 30, ts: Date.now() };
  const on = { symbol: 'ETHUSDT', score: 20, signals: [] };
  ctx.applyBtcRegime(on);
  assert.equal(on.shortVeto, true);
  ctx.saveGateCfg({ btcVeto: false });
  const off = { symbol: 'ETHUSDT', score: 20, signals: [] };
  ctx.applyBtcRegime(off);
  assert.equal(off.shortVeto, false);
  assert.equal(off.btcHit, true);
});

test('台账记录：gates 记录原始命中、gated 按开关判定，并带评分版本与当时的门控配置', () => {
  const { ctx, get } = loadInline();
  require('vm').runInContext('fwdLoaded = true; fwdRecords = [];', ctx);
  const mk = (sym) => ({ symbol: sym, score: 72, price: 100, gateHits: { overheat: true, stopCap: false }, riskReward: null });
  ctx.recordFwdSignals([mk('AUSDT')], new Set(), new Set(), {}, {});
  ctx.saveGateCfg({ overheat: false });
  ctx.recordFwdSignals([mk('BUSDT')], new Set(), new Set(), {}, {});
  const recs = plain(get('fwdRecords'));
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => [r.symbol, r.gates.overheat, r.gated]), [['AUSDT', true, false], ['BUSDT', true, true]]);
  assert.ok(recs.every((r) => r.ver === get('SCORING_VERSION')));
  assert.ok(!recs[1].gcfg.split(',').includes('overheat'));
  assert.ok(recs[0].gcfg.split(',').includes('overheat'));
});
