"use strict";
// 在 Node 里加载应用的评分 / 回测引擎（renderer/lib/*.js）。
// 这些文件是浏览器里的经典脚本（共享全局作用域），所以用 vm 按与 index.html 相同的顺序执行；
// 不再像以前那样从 index.html 里用正则抠内联脚本。顺序由 test/engine-order.test.js 与 index.html 对齐校验。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RENDERER = path.resolve(__dirname, "..", "renderer");
const LIB_ORDER = ["lib/indicators.js", "lib/analysis-core.js", "lib/scoring.js", "lib/backtest-core.js", "lib/alerts-core.js", "lib/realtime.js", "lib/shadow-model.js", "lib/portfolio-risk.js", "lib/fwd-attribution.js", "lib/signal-marks.js", "lib/paper-track.js"];

function createStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear()
  };
}

// opts.includeApp：同时加载 app.js（含 DOM 相关逻辑，测试用）；opts.binanceAPI：注入 window.binanceAPI
function loadEngine(opts) {
  const o = opts || {};
  const files = LIB_ORDER.concat(o.includeApp ? ["app.js"] : []);
  const localStorage = createStorage();
  const sandbox = {
    window: { addEventListener: () => {}, binanceAPI: o.binanceAPI, localStorage },
    document: {
      addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null,
      querySelector: () => null, createElement: () => ({})
    },
    localStorage,
    console: o.console || console,
    Math, JSON, Date, isFinite, parseFloat, parseInt, Number, String, Array, Object, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(RENDERER, f), "utf8"), sandbox, { filename: f });
  }
  // 与浏览器一致：顶层 function 声明是 window 的属性，detectPatterns 会被增强版覆盖
  vm.runInContext("detectPatterns = window.detectPatterns;", sandbox);
  // 读取沙箱顶层标识符（含 const / let 声明的，如 Indicators）
  sandbox.__get = (name) => vm.runInContext(name, sandbox);
  return sandbox;
}

module.exports = { loadEngine, LIB_ORDER, RENDERER };
