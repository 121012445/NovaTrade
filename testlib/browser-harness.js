'use strict';
// 浏览器集成测试的公共设施：用 playwright-core + 本机 Chromium 打开 renderer/index.html，
// 并注入假的 window.binanceAPI / window.electronAPI（preload 暴露的接口），无需 Electron、无需网络。
// 找不到 playwright-core 或 Chromium 时 available() 返回 false，调用方应跳过测试。
const fs = require('fs');
const path = require('path');

const INDEX = path.resolve(__dirname, '..', 'renderer', 'index.html');

function findPlaywright() {
  const cands = [process.env.PLAYWRIGHT_CORE];
  try { cands.push(require.resolve('playwright-core')); } catch (e) { /* 未安装 */ }
  const nvm = path.join(process.env.HOME || '/root', '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm)) cands.push(path.join(nvm, v, 'lib/node_modules/@playwright/mcp/node_modules/playwright-core'));
  } catch (e) { /* 无 nvm */ }
  return cands.find((p) => p && fs.existsSync(p));
}
function findChromium() {
  const cands = [process.env.CHROMIUM_PATH];
  try {
    for (const d of fs.readdirSync('/opt/playwright')) {
      if (d.startsWith('chromium-')) cands.push(path.join('/opt/playwright', d, 'chrome-linux64/chrome'));
    }
  } catch (e) { /* 无 */ }
  return cands.find((p) => p && fs.existsSync(p));
}
function available() { return !!(findPlaywright() && findChromium()); }

// 在页面里运行的假接口。数据完全合成且确定；所有调用记录在 window.__calls。
const MOCK_SCRIPT = `
(function () {
  var calls = window.__calls = [];
  function rec(n, a) { calls.push([n].concat([].slice.call(a))); }
  var IV = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
  function klines(sym, iv, limit, startTime) {
    var step = IV[iv] || 3600e3, n = limit || 100, seed = 0;
    for (var i = 0; i < sym.length; i++) seed = (seed * 31 + sym.charCodeAt(i)) % 100003;
    var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    var endOpen = Math.floor(Date.now() / step) * step, price = 100 + (seed % 50), rows = [];
    for (var k = 0; k < n; k++) {
      var o = price; price = price * (1 + 0.0008 + (rnd() - 0.5) * 0.012);
      var t = endOpen - (n - 1 - k) * step;
      rows.push([t, String(o), String(Math.max(o, price) * 1.002), String(Math.min(o, price) * 0.998), String(price), String(100 + rnd() * 50), t + step - 1, '0', 0, '0', '0', '0']);
    }
    return rows;
  }
  window.__mockKlines = klines;
  var syms = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'TRX', 'LTC'];
  function ticker(s, i) {
    var p = 100 + i * 37.5;
    return { symbol: s + 'USDT', lastPrice: String(p), priceChangePercent: String((i % 5) - 2 + 0.5), quoteVolume: String(5e8 / (i + 1)), highPrice: String(p * 1.02), lowPrice: String(p * 0.97) };
  }
  window.binanceAPI = {
    getTickers: async function () { rec('getTickers', arguments); return syms.map(ticker); },
    getFuturesTickers: async function () { rec('getFuturesTickers', arguments); return syms.slice(0, 8).map(ticker); },
    getKlines: async function (s, iv, l, st) { rec('getKlines', arguments); return klines(s, iv, l, st); },
    getFuturesKlines: async function (s, iv, l) { rec('getFuturesKlines', arguments); return klines(s, iv, l); },
    getPrice: async function (s) { rec('getPrice', arguments); return { price: '100' }; },
    get24hrTicker: async function () { return {}; },
    getExchangeInfo: async function () { return { symbols: [] }; },
    getFuturesSymbols: async function () { return { symbols: [] }; },
    getFuturesPrice: async function () { return { price: '100' }; },
    fwdLoad: async function () { rec('fwdLoad', arguments); return window.__fwdStore || []; },
    fwdSave: async function (d) { rec('fwdSave', arguments); window.__fwdStore = d; return true; },
    derivSnapshot: async function (sym) {
      var oi = [], i;
      for (i = 0; i < 30; i++) oi.push({ sumOpenInterestValue: String(1e9 + i * 1e7), timestamp: Date.now() - (30 - i) * 3600e3 });
      return { symbol: sym, premium: { lastFundingRate: '0.0004', markPrice: '100', nextFundingTime: Date.now() + 3600e3 },
        oi: oi, lsAccount: [{ longShortRatio: '1.1' }], lsTop: [{ longShortRatio: '1.4' }], taker: [{ buySellRatio: '1.08' }] };
    },
    premiumAll: async function () { rec('premiumAll', arguments); return syms.map(function (s, i) { return { symbol: s + 'USDT', lastFundingRate: String((i - 4) * 0.0002), markPrice: '1' }; }); },
    derivLite: async function (s) { rec('derivLite', arguments); var k = s.charCodeAt(0) % 7; return { symbol: s, oi: [{ sumOpenInterestValue: '100' }, { sumOpenInterestValue: String(100 + k * 5) }], ls: [{ longShortRatio: String(0.8 + k * 0.1) }] }; },
    getDataSource: async function () { return window.__dataSourceMock || { name: 'binance', at: Date.now() }; },
    getHistory: async function (s, iv, bars) { rec('getHistory', arguments); return klines(s, iv, Math.min(bars, 3000)); },
    fng: async function () { return { __error: 'mock' }; },
    getFuturesDepth: async function () { return { __error: 'mock' }; },
    getAggTrades: async function () { return { __error: 'mock' }; }
  };
  var noop = function () {};
  window.__pushCfg = { canStore: true, channels: [] };
  window.__llmCfg = { canStore: true, configured: false, baseUrl: '', model: '', apiKey: '', useProxy: false };
  window.__saved = [];
  window.electronAPI = new Proxy({}, {
    get: function (t, name) {
      if (name === 'getProxyStatus') return async function () { return { mode: 'direct', proxy: '', error: '' }; };
      if (name === 'notify') return async function (p) { rec('notify', [p]); return true; };
      if (name === 'pushGetConfig') return async function () { return window.__pushCfg; };
      if (name === 'pushSetConfig') return async function (cfg) {
        rec('pushSetConfig', [cfg]);
        // 模拟主进程：机密字段打码，打码占位符保留原值（这里只检查往返，不做真加密）
        var chans = cfg.channels.map(function (c) {
          var o = Object.assign({}, c);
          ['botToken', 'url', 'secret'].forEach(function (f) { if (typeof o[f] === 'string' && o[f] && o[f].indexOf('••••') !== 0) o[f] = '••••' + o[f].slice(-4); });
          return o;
        });
        window.__pushCfg = { canStore: true, channels: chans };
        return { ok: true, config: window.__pushCfg };
      };
      if (name === 'pushTest') return async function (id) { rec('pushTest', [id]); return { ok: true, results: [{ id: id, ok: true }] }; };
      if (name === 'llmGetConfig') return async function () { return window.__llmCfg; };
      if (name === 'llmSetConfig') return async function (cfg) {
        rec('llmSetConfig', [cfg]);
        window.__llmCfg = { canStore: true, configured: !!(cfg.baseUrl && cfg.model), baseUrl: cfg.baseUrl || '', model: cfg.model || '', apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : '', useProxy: !!cfg.useProxy };
        return { ok: true, config: window.__llmCfg };
      };
      if (name === 'llmAnalyze') return async function (payload) {
        rec('llmAnalyze', [payload]);
        window.__lastLlmPayload = payload;
        if (!window.__llmCfg.configured) return { ok: false, error: '尚未配置 AI 接口（设置 → AI 解读）' };
        return { ok: true, text: '结构偏多。\\n矛盾点：15m 动能转弱。\\n以上为基于所给数据的技术解读，不构成投资建议。', model: window.__llmCfg.model };
      };
      if (name === 'accountGetConfig') return async function () { return window.__acctCfg || { canStore: true, configured: false }; };
      if (name === 'accountSetKey') return async function (k, sec) {
        rec('accountSetKey', [k ? 'k' : '', sec ? 's' : '']);
        if (k === 'TRADEKEY'.repeat(5)) return { ok: false, error: '为安全起见只接受只读 Key：请在币安关闭该 Key 的「现货与杠杆交易」权限后再试' };
        window.__acctCfg = k ? { canStore: true, configured: true, apiKey: '••••' + k.slice(-4), perms: { enableReading: true, ipRestrict: false } } : { canStore: true, configured: false };
        return { ok: true, config: window.__acctCfg };
      };
      if (name === 'accountImport') return async function (o) {
        rec('accountImport', [o]);
        var t0 = Date.now() - 3 * 3600e3;
        return { ok: true, warnings: ['合约成交无法通过只读 Key 读取（币安要求开启合约权限，本应用不接受）。请在币安导出合约成交历史 CSV 后用「导入 CSV」。'], fills: [
          { id: 'spot:SOLUSDT:1', ts: t0, symbol: 'SOLUSDT', market: 'spot', side: 'BUY', price: 100, qty: 2, quote: 200, fee: 0.2, feeAsset: 'USDT', realizedPnl: null, positionSide: 'BOTH' },
          { id: 'spot:SOLUSDT:2', ts: t0 + 3600e3, symbol: 'SOLUSDT', market: 'spot', side: 'SELL', price: 104, qty: 2, quote: 208, fee: 0.2, feeAsset: 'USDT', realizedPnl: null, positionSide: 'BOTH' }
        ] };
      };
      if (name === 'appInfo') return async function () { return { version: '1.2.0', packaged: false, platform: 'linux', softwareRendering: false }; };
      if (name === 'checkUpdate') return async function () { return { ok: true, newer: true, latest: '9.9.9', current: '1.2.0' }; };
      if (name === 'backupExport') return async function (json, nm) { window.__saved.push({ json: json, name: nm }); return { ok: true, path: '/tmp/' + nm }; };
      if (name === 'backupImport') return async function () { return window.__importData ? { ok: true, data: window.__importData } : { ok: false, canceled: true }; };
      if (name === 'exportDiagnostics') return async function () { rec('exportDiagnostics', []); return { ok: true, path: '/tmp/diag.txt' }; };
      return function () { rec('electronAPI.' + String(name), arguments); return Promise.resolve(true); };
    }
  });
  // 假的 WebSocket：记录连接，由测试驱动 open / message / close
  window.__sockets = [];
  window.WebSocket = function (url) {
    var s = { url: url, readyState: 0, closed: false,
      close: function () { s.closed = true; s.readyState = 3; if (s.onclose) s.onclose({}); },
      send: function () {} };
    window.__sockets.push(s);
    return s;
  };
})();
`;

async function launch() {
  const { chromium } = require(findPlaywright());
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  return { browser, ctx };
}

// 打开应用页面。opts.init：额外的页面初始化脚本（在应用脚本之前执行）
async function openApp(ctx, opts) {
  const o = opts || {};
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.addInitScript(MOCK_SCRIPT);
  if (o.init) await page.addInitScript(o.init);
  await page.goto('file://' + INDEX);
  return { page, errors };
}

module.exports = { available, launch, openApp, INDEX };
