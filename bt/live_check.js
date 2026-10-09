// 实时验证：BTC/ETH 当前多周期结论（技术分析页 与 TrendIQ 页现在共用这条路径）
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const https = require("https");
const http = require("http");

const PROXY = { hostname: "127.0.0.1", port: 7897 };
function getJSON(urlPath, host) {
  return new Promise((resolve, reject) => {
    const hosts = host || ["data-api.binance.vision", "api.binance.com", "api1.binance.com"];
    let idx = 0;
    const tryNext = () => {
      if (idx >= hosts.length) return reject(new Error("all hosts failed"));
      const h = hosts[idx++];
      const full = "https://" + h + urlPath;
      const req = http.get({ hostname: PROXY.hostname, port: PROXY.port, path: full, method: "GET", headers: { "User-Agent": "Mozilla/5.0", Host: h } }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { tryNext(); } });
      });
      req.on("error", tryNext);
      req.setTimeout(12000, () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}

(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../renderer/index.html"), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const sb = { window: { addEventListener: () => {} }, document: { addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null, querySelector: () => null }, console, Math, JSON, Date, isFinite, parseFloat, parseInt };
  sb.window.window = sb.window;
  vm.createContext(sb);
  vm.runInContext(blocks.join("\n"), sb, { filename: "nt.js" });
  vm.runInContext("detectPatterns = window.detectPatterns;", sb);
  sb.window.binanceAPI = {
    getKlines: async (sym, iv, lim) => getJSON("/fapi/v1/klines?symbol=" + encodeURIComponent(sym) + "&interval=" + iv + "&limit=" + (lim || 100), ["fapi.binance.com"]),
    getPrice: async (sym) => getJSON("/fapi/v1/ticker/price?symbol=" + encodeURIComponent(sym), ["fapi.binance.com"])
  };

  for (const sym of ["BTCUSDT", "ETHUSDT"]) {
    const m = await sb.analyzeMultiTimeframe(sym);
    if (!m) { console.log(sym + ": MTF 无数据"); continue; }
    const tfs = m.tfData.map(r => r.interval + "=" + r.analysis.score + "(" + r.analysis.rec + ")").join("  ");
    console.log(sym + "  多周期综合: " + m.score + "分 [" + m.rec + "] 方向=" + m.direction + " 信号=" + m.signal + "  baseTf=" + m.baseTf);
    console.log("   各周期: " + tfs);
    if (m.baseTf) {
      const o = m.tfOhlc[m.baseTf];
      console.log("   结构面板数据(" + m.baseTf + "): " + o.length + " 根, 支撑" + (m.supports || []).length + "个 阻力" + (m.resistances || []).length + "个 RR=" + (m.riskReward ? m.riskReward.direction + " " + m.riskReward.rr : "无"));
    }
  }
  process.exit(0);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
