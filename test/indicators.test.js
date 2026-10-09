'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadInline } = require('../testlib/load-inline');

const { get } = loadInline();
const Indicators = get('Indicators');

// ---- 独立参考实现（标准定义：SMA 作种子的 EMA；信号线是 MACD 线的 EMA）----
function refEma(values, period) {
  const out = new Array(values.length).fill(null);
  let start = 0;
  while (start < values.length && values[start] === null) start++;
  if (values.length - start < period) return out;
  let e = 0;
  for (let i = start; i < start + period; i++) e += values[i];
  e /= period;
  out[start + period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = start + period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function refMacd(closes) {
  const f = refEma(closes, 12), s = refEma(closes, 26);
  const line = closes.map((_, i) => (f[i] !== null && s[i] !== null ? f[i] - s[i] : null));
  const sig = refEma(line, 9);
  const last = closes.length - 1;
  return { macd: line[last], hist: sig[last] === null ? null : line[last] - sig[last] };
}
function series(n, seed) {
  let s = seed || 7, p = 100;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < n; i++) { p *= 1 + (rnd() - 0.5) * 0.04; out.push(p); }
  return out;
}

test('MACD / MACDHist 与参考实现一致（含序列很短的情形）', () => {
  // 旧实现在 n=40 时柱值严重偏离（-3.75 vs -0.32），这里钉死
  for (const n of [34, 35, 40, 60, 100, 150, 300]) {
    const c = series(n, 11 + n);
    const r = refMacd(c);
    assert.ok(Math.abs(Indicators.MACD(c) - r.macd) < 1e-9, 'MACD n=' + n);
    assert.ok(Math.abs(Indicators.MACDHist(c) - r.hist) < 1e-9, 'MACDHist n=' + n);
  }
});

test('数据不足以算出信号线时返回 null，而不是给出错误数值', () => {
  assert.equal(Indicators.MACD(series(25, 1)), null);        // 不足 slow=26
  assert.equal(Indicators.MACDHist(series(33, 1)), null);    // 不足 slow+signal-1=34
  assert.notEqual(Indicators.MACDHist(series(34, 1)), null);
});

test('_emaArr 返回与输入等长、下标对齐的序列', () => {
  const c = series(50, 3);
  const e = Indicators._emaArr(c, 12);
  assert.equal(e.length, c.length);
  assert.equal(e[10], null);
  const seed = c.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
  assert.ok(Math.abs(e[11] - seed) < 1e-12, '第 period 个值应为 SMA 种子');
  assert.ok(e.slice(11).every((v) => Number.isFinite(v)));
});

test('_emaArr 能跳过开头的 null（MACD 线的前导空洞）', () => {
  const vals = [null, null, null, 1, 2, 3, 4, 5, 6];
  const e = Indicators._emaArr(vals, 3);
  assert.deepEqual(e.slice(0, 5), [null, null, null, null, null]);
  assert.equal(e[5], 2);   // (1+2+3)/3
  assert.equal(Indicators._emaArr([null, 1, 2], 3), null);
});
