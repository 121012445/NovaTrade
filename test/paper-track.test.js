'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('ptOpen：按现价入场；现价已越过止损 / 目标时拒绝', () => {
  const r = plain(E.ptOpen({ symbol: 'A', direction: 'long', stopLoss: 95, target: 110, livePrice: 101, btcPrice: 50000, now: 1 }));
  assert.equal(r.ok, true);
  assert.equal(r.track.entry, 101, '入场价 = 点击时的现价');
  assert.equal(r.track.cost, 0.12);
  assert.equal(r.track.btcEntry, 50000);
  assert.match(plain(E.ptOpen({ direction: 'long', stopLoss: 95, target: 110, livePrice: 94 })).reason, /止损/);
  assert.match(plain(E.ptOpen({ direction: 'long', stopLoss: 95, target: 110, livePrice: 111 })).reason, /目标/);
  assert.match(plain(E.ptOpen({ direction: 'short', stopLoss: 105, target: 90, livePrice: 106 })).reason, /止损/);
  assert.match(plain(E.ptOpen({ direction: 'short', stopLoss: 105, target: 90, livePrice: 89 })).reason, /目标/);
  assert.match(plain(E.ptOpen({ direction: 'long', stopLoss: 95, target: 110, livePrice: NaN })).reason, /最新价/);
  assert.equal(plain(E.ptOpen({ direction: 'long', stopLoss: 95, target: 110, livePrice: 100, blocked: true })).track.blocked, true);
});

test('ptUpdate：浮盈 / 净收益 / 最大浮盈浮亏 / 相对 BTC，触及目标或止损时归档', () => {
  const t = E.ptOpen({ symbol: 'A', direction: 'long', stopLoss: 95, target: 110, livePrice: 100, btcPrice: 100, now: 1 }).track;
  assert.equal(E.ptUpdate(t, 97, 98, 2), null);
  assert.ok(Math.abs(t.pnl + 3) < 1e-9);
  assert.ok(Math.abs(t.net + 3.12) < 1e-9);
  assert.ok(Math.abs(t.excess + 1) < 1e-9, '币跌 3%、BTC 跌 2% → 相对 BTC −1%');
  E.ptUpdate(t, 104, 101, 3);
  assert.ok(Math.abs(t.mfe - 4) < 1e-9 && Math.abs(t.mae + 3) < 1e-9);
  assert.equal(E.ptUpdate(t, 110.5, 101, 4), 'target');
  assert.equal(t.status, 'target');
  assert.equal(t.exit, 110.5);
  assert.equal(t.closedAt, 4);
  assert.equal(E.ptUpdate(t, 90, 100, 5), null, '已归档的不再更新');

  const s = E.ptOpen({ symbol: 'B', direction: 'short', stopLoss: 105, target: 90, livePrice: 100, btcPrice: 100 }).track;
  E.ptUpdate(s, 98, 95, 2);
  assert.ok(Math.abs(s.pnl - 2) < 1e-9, '空单价格跌 2% = +2%');
  assert.ok(Math.abs(s.excess + 3) < 1e-9, '币跌 2%、BTC 跌 5% → 空单相对 BTC −3%');
  assert.equal(E.ptUpdate(s, 105, 95, 3), 'invalid');
});

test('ptSummary：只统计已结束的，可排除「暂不交易」信号', () => {
  const mk = (st, net, blocked, excess) => ({ status: st, pnl: net + 0.12, net, blocked, excess });
  const tr = [mk('target', 5, false, 2), mk('invalid', -3, true, -1), mk('invalid', -2, false), { status: 'active', pnl: 1 }, { status: 'cancelled', pnl: 1 }];
  const a = plain(E.ptSummary(tr));
  assert.deepEqual([a.n, a.targets, a.stops, a.blockedN, a.excessN], [3, 1, 2, 1, 2]);
  assert.ok(Math.abs(a.avgNet - 0) < 1e-9);
  assert.ok(Math.abs(a.winRate - 100 / 3) < 1e-9);
  const b = plain(E.ptSummary(tr, { excludeBlocked: true }));
  assert.equal(b.n, 2);
  assert.ok(Math.abs(b.avgNet - 1.5) < 1e-9);
  assert.equal(plain(E.ptSummary([])).n, 0);
});
