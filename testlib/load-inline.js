'use strict';
// 单元测试用：加载 renderer/lib/*.js + renderer/app.js 到 vm 沙箱（实现见 bt/engine.js）。
const { loadEngine } = require('../bt/engine');

const QUIET = { log() {}, warn() {}, error() {}, info() {} };

// opts.binanceAPI：注入 window.binanceAPI（模拟主进程暴露的接口）
function loadInline(opts) {
  const o = opts || {};
  const ctx = loadEngine({ includeApp: true, binanceAPI: o.binanceAPI, console: o.console || QUIET });
  return { ctx, get: ctx.__get };
}

// 生成确定性的合成 K 线（币安原始格式：字符串价格 + closeTime 在第 7 项）
// opts: { n, intervalMs, endOpenTime, start, drift, vol, lastCloseMul: 最后一根收盘价倍数 }
function makeKlines(opts) {
  const n = opts.n, step = opts.intervalMs;
  let seed = opts.seed || 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let price = opts.start || 100;
  const rows = [];
  const firstOpen = opts.endOpenTime - (n - 1) * step;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + (opts.drift || 0) + (rnd() - 0.5) * (opts.vol || 0.01));
    let close = price;
    if (i === n - 1 && opts.lastCloseMul) close = close * opts.lastCloseMul;
    const high = Math.max(open, close) * (1 + rnd() * 0.004);
    const low = Math.min(open, close) * (1 - rnd() * 0.004);
    const t = firstOpen + i * step;
    rows.push([t, String(open), String(high), String(low), String(close), String(100 + rnd() * 50), t + step - 1, '0', 0, '0', '0', '0']);
  }
  return rows;
}

module.exports = { loadInline, makeKlines };
