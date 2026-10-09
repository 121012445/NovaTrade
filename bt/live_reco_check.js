// 实时复刻 App 推荐管线：Top10 USDT(成交额) → 多周期加权分 → 看涨(≥65) / 看跌(<45 且日线 EMA20<EMA50 门控)
// 用法: node live_reco_check.js   —— 回答"现在 AI 推荐会显示什么"
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function ema(arr, n) { const k = 2 / (n + 1); const out = []; let e = null; for (let i = 0; i < arr.length; i++) { e = e === null ? arr[i] : arr[i] * k + e * (1 - k); out.push(e); } return out; }

function loadEngine() {
  const html = fs.readFileSync(path.resolve(__dirname, "../renderer/index.html"), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const sandbox = {
    window: { addEventListener: () => {} },
    document: { addEventListener: () => {}, querySelectorAll: () => [], getElementById: () => null, querySelector: () => null },
    console, Math, JSON, Date, isFinite, parseFloat, parseInt
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(blocks.join("\n"), sandbox, { filename: "novatrade-inline.js" });
  vm.runInContext("detectPatterns = window.detectPatterns;", sandbox);
  return sandbox;
}

(async () => {
  const eng = loadEngine();
  const analyzeCoinEnhanced = eng.analyzeCoinEnhanced;
  if (typeof analyzeCoinEnhanced !== "function") throw new Error("analyzeCoinEnhanced 未找到");

  const tickers = await getJSON("/api/v3/ticker/24hr");
  const top = tickers.filter(s => s.symbol.endsWith("USDT"))
    .map(s => ({ symbol: s.symbol, vol: parseFloat(s.quoteVolume) || 0 }))
    .sort((a, b) => b.vol - a.vol).slice(0, 10).map(s => s.symbol);
  console.log("Top10 成交额:", top.join(", "), "\n");

  const rows = [];
  for (const sym of top) {
    try {
      const ivs = ["15m", "1h", "4h"];
      const weights = { "15m": 0.25, "1h": 0.35, "4h": 0.40 };
      const kls = await Promise.all(ivs.map(iv => getJSON("/api/v3/klines?symbol=" + sym + "&interval=" + iv + "&limit=150")));
      let wSum = 0, ws = 0, s16 = null;
      for (let i = 0; i < ivs.length; i++) {
        const kl = kls[i];
        if (!Array.isArray(kl) || kl.length < 100) continue;
        const closes = kl.map(k => parseFloat(k[4]));
        const ohlc = kl.map(k => [parseFloat(k[0]), parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])]);
        const a = analyzeCoinEnhanced(closes, sym, ohlc);
        const w = weights[ivs[i]];
        wSum += a.score * w; ws += w;
        if (ivs[i] === "1h") s16 = a;
      }
      if (!ws) continue;
      const score = Math.round(wSum / ws);
      // 日线门控：EMA20 < EMA50
      const d1 = await getJSON("/api/v3/klines?symbol=" + sym + "&interval=1d&limit=60");
      const closes1d = (Array.isArray(d1) ? d1 : []).map(k => parseFloat(k[4]));
      let down = true;
      if (closes1d.length >= 50) {
        const e20 = ema(closes1d, 20), e50 = ema(closes1d, 50);
        down = e20[e20.length - 1] < e50[e50.length - 1];
      }
      rows.push({ sym, score, down });
    } catch (e) { console.log(sym, "分析失败:", e.message); }
    await sleep(120);
  }

  const buys = rows.filter(r => r.score >= 65).sort((a, b) => b.score - a.score);
  const sellCand = rows.filter(r => r.score < 45).sort((a, b) => a.score - b.score);
  const sells = sellCand.filter(r => r.down);
  const blocked = sellCand.filter(r => !r.down);
  console.log("看涨推荐（≥65分）:", buys.length ? buys.map(r => r.sym + " " + r.score + "分").join(" | ") : "无");
  console.log("看跌预警（<45分 且 日线趋势下行）:", sells.length ? sells.map(r => r.sym + " " + r.score + "分").join(" | ") : "无");
  console.log("被日线门控拦截的空信号:", blocked.length ? blocked.map(r => r.sym + " " + r.score + "分").join(" | ") : "无");
  console.log("\n全部评分:");
  console.log(rows.map(r => r.sym + "=" + r.score + (r.score >= 65 ? "↑" : r.score < 45 ? (r.down ? "↓(过门控)" : "↓(被拦截)") : "")).join("  "));
})();
