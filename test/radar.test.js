'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));
const MIN = 60e3;

test('rdIngest：每 10 秒一个样本，10 秒内只更新最新样本，超过 20 分钟的丢弃', () => {
  const st = E.rdCreate();
  E.rdIngest(st, [{ s: 'A', c: '100', q: '1000' }], 0);
  E.rdIngest(st, [{ s: 'A', c: '101', q: '1001' }], 5000);
  assert.equal(st.s.A.length, 1);
  assert.equal(st.s.A[0][1], 101);
  E.rdIngest(st, [{ s: 'A', c: '102', q: '1002' }, { s: 'B', c: 'x' }, null], 12000);
  assert.equal(st.s.A.length, 2);
  assert.equal(st.s.B, undefined, '脏数据被忽略');
  E.rdIngest(st, [{ s: 'A', c: '103', q: '1003' }], 25 * MIN);
  assert.equal(st.s.A.length, 1, '20 分钟前的样本被丢弃');
});

test('rdCompute：5 / 15 分钟涨跌与成交额放大倍数；数据不够久时为 null；按 |5 分钟涨跌| 排序', () => {
  const st = E.rdCreate();
  // A：16 分钟内从 100 涨到 110，最近 5 分钟从 104 → 110；24h 成交额 288000（平均每 5 分钟 1000），最近 5 分钟新增 5000
  for (let t = 0; t <= 16 * MIN; t += 10000) {
    const p = t <= 11 * MIN ? 100 + (t / (11 * MIN)) * 4 : 104 + ((t - 11 * MIN) / (5 * MIN)) * 6;
    const q = t <= 11 * MIN ? 283000 : 283000 + ((t - 11 * MIN) / (5 * MIN)) * 5000;
    E.rdIngest(st, [{ s: 'A', c: String(p), q: String(q) }], t);
  }
  // B：只有 2 分钟数据
  E.rdIngest(st, [{ s: 'B', c: '50', q: '1' }], 14 * MIN);
  E.rdIngest(st, [{ s: 'B', c: '49', q: '1' }], 16 * MIN);
  const rows = plain(E.rdCompute(st, 16 * MIN));
  assert.equal(rows[0].symbol, 'A');
  assert.ok(Math.abs(rows[0].chg5 - (110 / 104 - 1) * 100) < 0.2, 'chg5 ' + rows[0].chg5);
  assert.ok(Math.abs(rows[0].chg15 - (110 / (100 + 4 / 11) - 1) * 100) < 0.5, 'chg15 ' + rows[0].chg15);
  assert.ok(Math.abs(rows[0].volX - 5000 / (288000 / 288)) < 0.3, 'volX ' + rows[0].volX);
  const b = rows.find((r) => r.symbol === 'B');
  assert.equal(b.chg5, null);
  assert.equal(b.chg15, null);
});

test('rdAlerts：阈值与冷却', () => {
  const last = {};
  const rows = [{ symbol: 'A', chg5: 4 }, { symbol: 'B', chg5: -3.5 }, { symbol: 'C', chg5: 1 }, { symbol: 'D', chg5: null }];
  assert.deepEqual(plain(E.rdAlerts(rows, { pct: 3, cool: 30 }, last, 0)).map((r) => r.symbol), ['A', 'B']);
  assert.deepEqual(plain(E.rdAlerts(rows, { pct: 3, cool: 30 }, last, 10 * MIN)), [], '冷却中');
  assert.deepEqual(plain(E.rdAlerts(rows, { pct: 3, cool: 30 }, last, 31 * MIN)).map((r) => r.symbol), ['A', 'B']);
});

test('rdFundingRank / rdDerivRank', () => {
  const prem = [
    { symbol: 'AUSDT', lastFundingRate: '0.001' }, { symbol: 'BUSDT', lastFundingRate: '-0.0005' },
    { symbol: 'CUSDT', lastFundingRate: '0.0001' }, { symbol: 'DUSDC', lastFundingRate: '0.01' }, { symbol: 'EUSDT', lastFundingRate: '' }
  ];
  const f = plain(E.rdFundingRank(prem, null, 2));
  assert.deepEqual(f.high.map((x) => x.symbol), ['AUSDT', 'CUSDT']);
  assert.deepEqual(f.low.map((x) => x.symbol), ['BUSDT', 'CUSDT']);
  assert.ok(Math.abs(f.high[0].rate - 0.1) < 1e-9 && Math.abs(f.high[0].annual - 109.5) < 1e-9);
  assert.equal(f.n, 3, '非 USDT 与无费率的被过滤');
  assert.deepEqual(plain(E.rdFundingRank(prem, { BUSDT: 1 }, 5)).high.map((x) => x.symbol), ['BUSDT']);

  const d = plain(E.rdDerivRank({
    AUSDT: { oi: [{ sumOpenInterestValue: '100' }, { sumOpenInterestValue: '150' }], ls: [{ longShortRatio: '2.5' }] },
    BUSDT: { oi: [{ sumOpenInterestValue: '100' }, { sumOpenInterestValue: '80' }], ls: [{ longShortRatio: '0.6' }] },
    CUSDT: { oi: [], ls: [] }
  }, 5));
  assert.deepEqual(d.oiUp.map((x) => [x.symbol, Math.round(x.value)]), [['AUSDT', 50], ['BUSDT', -20]]);
  assert.equal(d.oiDown[0].symbol, 'BUSDT');
  assert.equal(d.lsHigh[0].symbol, 'AUSDT');
  assert.equal(d.lsLow[0].symbol, 'BUSDT');
});
