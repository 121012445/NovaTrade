'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));
const P = (symbol, side, notional, lev) => ({ symbol, side, notional, lev: lev || 1 });
const corr = (m) => (a, b) => { const k = [a, b].sort().join('|'); return k in m ? m[k] : null; };

test('空仓返回 null；单笔仓位：有效仓位数为 1，无相关性警告', () => {
  assert.equal(E.prRisk([], null), null);
  const r = plain(E.prRisk([P('BTCUSDT', 'long', 1000, 3)], null));
  assert.equal(r.n, 1);
  assert.equal(r.neff, 1);
  assert.equal(r.avgCorr, null);
  assert.equal(r.avgLev, 3);
  assert.deepEqual(r.warnings, []);
});

test('三笔高度相关的同向多单：有效独立仓位数远小于 3，并给出警告', () => {
  const c = corr({ 'BTCUSDT|ETHUSDT': 0.9, 'BTCUSDT|SOLUSDT': 0.85, 'ETHUSDT|SOLUSDT': 0.88 });
  const r = plain(E.prRisk([P('BTCUSDT', 'long', 1000), P('ETHUSDT', 'long', 1000), P('SOLUSDT', 'long', 1000)], c));
  assert.ok(r.neff < 1.3, 'neff ' + r.neff);
  assert.ok(r.avgCorr > 0.8);
  assert.equal(Math.round(r.netPct), 100);
  assert.ok(r.warnings.some((w) => /平均相关系数/.test(w)));
  assert.ok(r.warnings.some((w) => /独立仓位/.test(w)));
  assert.ok(r.warnings.some((w) => /单边/.test(w)));
});

test('做多 A 同时做空高度相关的 B = 对冲：有效仓位数高、平均（方向调整后）相关为负', () => {
  const c = corr({ 'BTCUSDT|ETHUSDT': 0.9 });
  const r = plain(E.prRisk([P('BTCUSDT', 'long', 1000), P('ETHUSDT', 'short', 1000)], c));
  assert.ok(r.avgCorr < -0.8);
  assert.equal(r.neff, 2, '近乎完全对冲，风险上等价于两笔相互抵消的仓位（上限取 n）');
  assert.ok(Math.abs(r.netPct) < 1e-9);
  assert.ok(!r.warnings.some((w) => /平均相关系数/.test(w)));
});

test('不相关的仓位：有效独立仓位数 ≈ 笔数', () => {
  const c = corr({ 'AUSDT|BUSDT': 0, 'AUSDT|CUSDT': 0, 'BUSDT|CUSDT': 0 });
  const r = plain(E.prRisk([P('AUSDT', 'long', 500), P('BUSDT', 'short', 500), P('CUSDT', 'long', 500)], c));
  assert.ok(Math.abs(r.neff - 3) < 1e-9);
});

test('集中度与杠杆警告；缺相关性数据按 0.5 保守估计并提示', () => {
  const r = plain(E.prRisk([P('AUSDT', 'long', 9000, 10), P('BUSDT', 'long', 1000, 2)], null));
  assert.equal(Math.round(r.top.pct), 90);
  assert.equal(r.top.symbol, 'AUSDT');
  assert.ok(Math.abs(r.avgLev - (9000 * 10 + 1000 * 2) / 10000) < 1e-9);
  assert.equal(r.corrMissing, 1);
  assert.ok(r.warnings.some((w) => /集中度/.test(w)));
  assert.ok(r.warnings.some((w) => /杠杆/.test(w)));
  assert.ok(r.warnings.some((w) => /缺少相关性/.test(w)));
});

test('同一币种的多条记录视为完全相关；非法名义价值被忽略', () => {
  const r = plain(E.prRisk([P('BTCUSDT', 'long', 1000), P('BTCUSDT', 'long', 1000), P('BTCUSDT', 'long', 0), null], null));
  assert.equal(r.n, 2);
  assert.equal(r.neff, 1);
  assert.equal(r.corrMissing, 0);
});
