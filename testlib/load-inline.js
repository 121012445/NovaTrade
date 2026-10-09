'use strict';
// 把 renderer/index.html 里的内联 <script> 放进 vm 沙箱执行，供单元测试直接调用其中的函数。
// 与 bt/backtest.js 的 loadEngine 同思路。后续把评分逻辑拆成独立模块后，这个 helper 可以删掉。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = process.env.NT_HTML || path.resolve(__dirname, '..', 'renderer', 'index.html');

function createStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear()
  };
}

// opts.binanceAPI：注入 window.binanceAPI（模拟主进程暴露的接口）
function loadInline(opts) {
  const o = opts || {};
  const html = fs.readFileSync(HTML, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const localStorage = createStorage();
  const sandbox = {
    window: { addEventListener: () => {}, binanceAPI: o.binanceAPI, localStorage },
    document: {
      addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null,
      querySelector: () => null, createElement: () => ({})
    },
    localStorage,
    console: o.console || { log() {}, warn() {}, error() {}, info() {} },
    Math, JSON, Date, isFinite, parseFloat, parseInt, Number, String, Array, Object, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(blocks.join('\n'), sandbox, { filename: 'novatrade-inline.js' });
  // 与浏览器一致：顶层 function 声明是 window 的属性，detectPatterns 会被增强版覆盖
  vm.runInContext('detectPatterns = window.detectPatterns;', sandbox);
  return {
    ctx: sandbox,
    // 读取沙箱顶层标识符（含 const / let 声明的，如 Indicators）
    get: (name) => vm.runInContext(name, sandbox)
  };
}

// 生成确定性的合成 K 线（币安原始格式：字符串价格 + closeTime 在第 7 项）
// opts: { n, intervalMs, endOpenTime, start, drift, vol, lastOpen: 最后一根是否未收盘, lastCloseMul: 最后一根收盘价倍数 }
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
