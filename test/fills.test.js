'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));
const H = 3600e3;

test('flParseCsv：币安现货导出（Executed 带单位、带引号、BOM）', () => {
  const csv = '\ufeff"Date(UTC)","Pair","Side","Price","Executed","Amount","Fee"\n' +
    '"2026-10-01 08:00:00","BTCUSDT","BUY","60000","0.0100BTC","600USDT","0.6USDT"\n' +
    '"2026-10-01 12:00:00","BTCUSDT","SELL","61,000.5","0.0100BTC","610.005USDT","0.61USDT"\n' +
    '"bad","BTCUSDT","BUY","x","1","1","0"\n';
  const r = plain(E.flParseCsv(csv));
  assert.equal(r.fills.length, 2);
  assert.equal(r.errors.length, 1);
  const f = r.fills[1];
  assert.equal(f.ts, Date.UTC(2026, 9, 1, 12));
  assert.equal(f.market, 'spot');
  assert.equal(f.price, 61000.5);
  assert.equal(f.qty, 0.01);
  assert.equal(f.fee, 0.61);
  assert.equal(f.feeAsset, 'USDT');
});

test('flParseCsv：合约导出（含已实现盈亏 → futures）与中文表头；无法识别时给出提示', () => {
  const fut = 'Date(UTC),Symbol,Side,Price,Quantity,Amount,Fee,Realized Profit\n2026-10-02 01:02:03,ETHUSDT,SELL,2500,1,2500,1,0\n';
  const a = plain(E.flParseCsv(fut));
  assert.equal(a.fills[0].market, 'futures');
  assert.equal(a.fills[0].side, 'SELL');
  const cn = '时间,交易对,方向,价格,数量,成交额,手续费\n2026-10-02 01:02:03,SOL/USDT,买入,150,2,300,0.3\n';
  const b = plain(E.flParseCsv(cn));
  assert.equal(b.fills[0].symbol, 'SOLUSDT');
  assert.equal(b.fills[0].side, 'BUY');
  assert.match(plain(E.flParseCsv('a,b,c\n1,2,3')).errors[0], /无法识别表头/);
});

const F = (o) => Object.assign({ id: String(Math.random()), fee: 0, feeAsset: 'USDT', positionSide: 'BOTH', market: 'futures', symbol: 'ETHUSDT' }, o);

test('flToTrips：现货分批买入、一次卖出 → 一笔加权均价的完整交易；手续费计入盈亏', () => {
  const trips = plain(E.flToTrips([
    F({ market: 'spot', symbol: 'BTCUSDT', ts: 1, side: 'BUY', price: 100, qty: 1, fee: 0.1 }),
    F({ market: 'spot', symbol: 'BTCUSDT', ts: 2, side: 'BUY', price: 110, qty: 1, fee: 0.1 }),
    F({ market: 'spot', symbol: 'BTCUSDT', ts: 3, side: 'SELL', price: 120, qty: 2, fee: 0.2 })
  ]));
  assert.equal(trips.length, 1);
  const t = trips[0];
  assert.equal(t.side, 'long');
  assert.equal(t.entry, 105);
  assert.equal(t.exit, 120);
  assert.ok(Math.abs(t.pnlQuote - (30 - 0.4)) < 1e-9);
  assert.ok(Math.abs(t.pnlPct - (120 / 105 - 1) * 100) < 1e-9);
});

test('flToTrips：合约做空、部分平仓、反手做多', () => {
  const trips = plain(E.flToTrips([
    F({ ts: 1, side: 'SELL', price: 100, qty: 2 }),       // 开空 2
    F({ ts: 2, side: 'BUY', price: 95, qty: 1 }),         // 平 1
    F({ ts: 3, side: 'BUY', price: 90, qty: 3 }),         // 平 1 + 反手开多 2
    F({ ts: 4, side: 'SELL', price: 99, qty: 2 })         // 平多
  ]));
  assert.equal(trips.length, 2);
  assert.equal(trips[0].side, 'short');
  assert.equal(trips[0].exit, 92.5);
  assert.ok(Math.abs(trips[0].pnlQuote - 15) < 1e-9);
  assert.equal(trips[1].side, 'long');
  assert.equal(trips[1].entry, 90);
  assert.ok(Math.abs(trips[1].pnlQuote - 18) < 1e-9);
});

test('flToTrips：双向持仓按 positionSide 分开；没有对应开仓的平仓被跳过；未平仓的不计', () => {
  const trips = plain(E.flToTrips([
    F({ ts: 0, side: 'BUY', price: 1, qty: 1, symbol: 'XUSDT', market: 'spot' }),  // 现货只有买入、未卖出
    F({ ts: 0, side: 'SELL', price: 9, qty: 1, symbol: 'YUSDT', market: 'spot' }), // 现货先卖：没有持仓，跳过
    F({ ts: 1, side: 'BUY', price: 100, qty: 1, positionSide: 'LONG' }),
    F({ ts: 2, side: 'SELL', price: 100, qty: 1, positionSide: 'SHORT' }),
    F({ ts: 3, side: 'SELL', price: 110, qty: 1, positionSide: 'LONG' }),   // 平多
    F({ ts: 4, side: 'BUY', price: 90, qty: 1, positionSide: 'SHORT' })     // 平空
  ]));
  assert.deepEqual(trips.map((t) => [t.side, t.pnlQuote]), [['long', 10], ['short', 10]]);
});

test('flTagTrips / flStats：按信号 / 逆信号 / 自己判断', () => {
  const trips = [
    { symbol: 'A', side: 'long', openTs: 10 * H, pnlQuote: 5, pnlPct: 2 },
    { symbol: 'A', side: 'short', openTs: 20 * H, pnlQuote: -3, pnlPct: -1 },
    { symbol: 'B', side: 'long', openTs: 30 * H, pnlQuote: 1, pnlPct: 0.5 }
  ];
  const recs = [
    { symbol: 'A', dir: 'long', ts: 7 * H, score: 70, gated: true },         // 开仓前 3h，同向
    { symbol: 'A', dir: 'long', ts: 19.9 * H, score: 66, gated: false },     // 第二笔的反向信号
    { symbol: 'B', dir: 'long', ts: 25 * H, score: 70 }                      // 早了 5h，不算
  ];
  const t = plain(E.flTagTrips(trips, recs));
  assert.deepEqual(t.map((x) => x.src), ['signal', 'against', 'manual']);
  assert.equal(t[0].sigScore, 70);
  assert.equal(t[1].sigGated, false);
  const s = plain(E.flStats(t));
  assert.deepEqual([s.signal.n, s.against.n, s.manual.n], [1, 1, 1]);
  assert.equal(s.signal.totalQuote, 5);
  assert.equal(s.against.winRate, 0);
});

test('flMerge：按 id 去重、按时间排序', () => {
  const m = plain(E.flMerge([{ id: 'a', ts: 2 }, { id: 'b', ts: 1 }], [{ id: 'a', ts: 2, x: 1 }, { id: 'c', ts: 0 }]));
  assert.deepEqual(m.map((f) => f.id), ['c', 'b', 'a']);
  assert.equal(m[2].x, 1);
});
