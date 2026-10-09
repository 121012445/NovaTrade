#!/usr/bin/env node
// NovaTrade 信号回测器 —— 验证 renderer/index.html 里的 analyzeCoin 评分在历史上的每笔期望
// 用法:
//   node backtest.js                          默认: 1h, Top60, 2000 根
//   node backtest.js --top 30 --bars 2000 --interval 1h
//   node backtest.js --baseline bt/last_run.json   与基线做 A/B 对比（唯一变量原则）
// 设计参照 BinanceGUI backtestall: 固定宇宙+窗口+内置手续费+K线缓存+保守撮合(同bar先止损)
// 信号只用已收盘 K 线，下一根开盘入场；默认数据源为合约（与应用一致），--market spot 可切到现货。
// 阈值默认值直接取自应用常量（SIGNAL_LONG_MIN / SHORT_SCORE_MIN），避免与应用漂移。
"use strict";
const fs = require("fs");
const path = require("path");
const { loadEngine } = require("./engine");   // 共享评分引擎（renderer/lib/*.js），不再从 index.html 里抠内联脚本
const https = require("https");
const http = require("http");

// ---------- 参数 ----------
const ENG = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const args = process.argv.slice(2);
function argOf(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const TOP = parseInt(argOf("--top", "60"), 10);
const BARS = parseInt(argOf("--bars", "2000"), 10);
const INTERVAL = argOf("--interval", "1h");
const BASELINE = argOf("--baseline", null);
const OUT = path.resolve(__dirname, argOf("--out", "last_run.json"));
const CACHE_DIR = path.resolve(__dirname, argOf("--cache", "cache"));
const PROXY = argOf("--proxy", process.env.NOVATRADE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "none"); // none = 直连；也可用环境变量 NOVATRADE_PROXY / HTTPS_PROXY
const MARKET = argOf("--market", "futures"); // futures（默认，与应用一致）| spot
const FEE = 0.0004;            // 单边手续费（吃单），往返 0.08%
const SL_ATR = 1.5, TP_ATR = 3.0, TIME_STOP = 24, COOLDOWN = 12, WINDOW = 300;
const LONG_TH = parseInt(argOf("--long-th", String(ENG.SIGNAL_LONG_MIN)), 10);          // 默认 = 应用的多头门槛
const SHORT_TH = parseInt(argOf("--short-th", String(ENG.SHORT_SCORE_MIN - 1)), 10);       // 默认 = 应用的空头门槛（score < SHORT_SCORE_MIN）
const SHORT_HTF = argOf("--short-htf", "none"); // 如 4h：做空需高周期趋势同向下行(EMA20<EMA50)；none=关闭

// ---------- 高周期趋势确认 ----------
function msOf(iv) { const m = iv.match(/^(\d+)([mhd])$/); if (!m) throw new Error("bad interval " + iv); return +m[1] * ({ m: 60e3, h: 3600e3, d: 86400e3 })[m[2]]; }
function ema(arr, n) { const k = 2 / (n + 1); const out = new Array(arr.length).fill(null); let e = null; for (let i = 0; i < arr.length; i++) { e = e === null ? arr[i] : arr[i] * k + e * (1 - k); out[i] = i >= n - 1 ? e : null; } return out; }
// 返回函数：给定 1h 已收盘 bar 的开盘时间，返回该时刻最近一根"已收盘"HTF bar 的趋势(1多/-1空/0不足)
function makeHtfGate(htfBars, htfInterval) {
  const htfMs = msOf(htfInterval);
  const ohlcH = htfBars.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
  const closesH = ohlcH.map(k => k[4]);
  const e20 = ema(closesH, 20), e50 = ema(closesH, 50);
  return function (oneHourBarOpenTime) {
    const closeBy = oneHourBarOpenTime + 3600e3; // 信号 bar 收盘时刻
    let j = ohlcH.length - 1;
    while (j >= 0 && ohlcH[j][0] + htfMs > closeBy) j--; // 最近一根已收盘 HTF bar
    if (j < 0 || e20[j] === null || e50[j] === null) return 0;
    return e20[j] < e50[j] ? -1 : 1;
  };
}

// ---------- 网络 ----------
const PROXY_URL = /^none$/i.test(PROXY) ? null : new URL(PROXY);
function getJSON(urlPath, host) {
  return new Promise((resolve, reject) => {
    const hosts = host || (MARKET === "futures"
      ? ["fapi.binance.com", "fapi1.binance.com", "fapi2.binance.com", "fapi3.binance.com"]
      : ["data-api.binance.vision", "api.binance.com", "api1.binance.com", "api2.binance.com"]);
    let idx = 0, rateRetries = 0;
    const tryNext = () => {
      if (idx >= hosts.length) return reject(new Error("all hosts failed: " + urlPath));
      const h = hosts[idx++];
      const full = "https://" + h + urlPath;
      const opts = PROXY_URL
        ? { hostname: PROXY_URL.hostname, port: +PROXY_URL.port || 80, path: full, method: "GET", headers: { "User-Agent": "Mozilla/5.0", Host: h } }
        : { hostname: h, port: 443, path: urlPath, method: "GET", headers: { "User-Agent": "Mozilla/5.0" } };
      const req = (PROXY_URL && PROXY_URL.protocol === "https:" ? https : http).get(opts, (res) => {
        let data = ""; res.on("data", c => data += c);
        res.on("end", () => {
          const st = res.statusCode;
          if (st >= 200 && st < 300) { try { return resolve(JSON.parse(data)); } catch (e) { return tryNext(); } }
          // 限流：按 Retry-After 等待后重试同一主机（最多 5 次），不要换主机继续猛打
          if ((st === 429 || st === 418) && rateRetries++ < 5) {
            const wait = Math.min(120, parseInt(res.headers["retry-after"], 10) || (st === 418 ? 60 : 10));
            console.log("  限流 HTTP " + st + "，等待 " + wait + "s…");
            idx--; return setTimeout(tryNext, wait * 1000);
          }
          // 4xx（参数 / 非法交易对 / 地区限制）换主机也不会好：直接报错
          if (st >= 400 && st < 500) return reject(new Error("HTTP " + st + " " + String(data).slice(0, 120) + " " + urlPath));
          tryNext();   // 5xx：换主机
        });
      });
      req.on("error", tryNext);
      req.setTimeout(12000, () => { req.destroy(); tryNext(); });
    };
    tryNext();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 宇宙与K线 ----------
const STABLE = new Set(["USDC","BUSD","DAI","FDUSD","TUSD","USDP","USD1","RLUSD","USDS","UST","USTC","USDL","USDG","USDK","SUSD","USDX","MIM","FEI","USDF","BRLR"]);
async function universe() {
  const t = await getJSON(MARKET === "futures" ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr");
  if (!Array.isArray(t)) throw new Error("tickers failed");
  return t.filter(s => s.symbol.endsWith("USDT") && !STABLE.has(s.symbol.slice(0, -4)))
    .map(s => ({ symbol: s.symbol, vol: parseFloat(s.quoteVolume) || 0 }))
    .filter(s => s.vol > 0).sort((a, b) => b.vol - a.vol).slice(0, TOP).map(s => s.symbol);
}
function cacheFile(sym, iv) { return path.join(CACHE_DIR, MARKET + "_" + sym + "_" + (iv || INTERVAL) + ".json"); }
async function klines(sym, iv) {
  const want = iv || INTERVAL;
  const cf = cacheFile(sym, want);
  if (fs.existsSync(cf)) {
    try { const c = JSON.parse(fs.readFileSync(cf, "utf8"));
      if (Date.now() - c.ts < 6 * 3600e3 && c.bars.length >= Math.min(BARS, 1000)) return c.bars; } catch (e) {}
  }
  const PAGE = MARKET === "futures" ? 1500 : 1000;
  let bars = [], start = null, guard = 0;
  // 无 startTime 时返回最近 PAGE 根；之后用上一页最后一根的时间向后翻页直到取够 BARS 根。
  // 为了「取最近 BARS 根」，先按需要的根数反推起点。
  const ivMs = msOf(want);
  start = Date.now() - (BARS + 5) * ivMs;
  while (bars.length < BARS && guard++ < 40) {
    const base = MARKET === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
    const p = base + "?symbol=" + encodeURIComponent(sym) + "&interval=" + want + "&limit=" + PAGE + "&startTime=" + start;
    const chunk = await getJSON(p);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    bars = bars.concat(chunk);
    start = chunk[chunk.length - 1][0] + 1;
    if (chunk.length < PAGE) break;
    await sleep(120);
  }
  bars = bars.filter(k => +k[6] < Date.now()).slice(-BARS);   // 只保留已收盘的 K 线
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cf, JSON.stringify({ ts: Date.now(), bars })); } catch (e) {}
  return bars;
}

// ---------- 指标 ----------
function atr14(ohlc, i, n = 14) {
  if (i < n) return null;
  let atr = 0;
  const tr = (k) => Math.max(ohlc[k][2] - ohlc[k][3], Math.abs(ohlc[k][2] - ohlc[k - 1][4]), Math.abs(ohlc[k][3] - ohlc[k - 1][4]));
  for (let k = i - n + 1; k <= i; k++) atr += tr(k);
  atr /= n;
  return atr;
}

// ---------- 回测主循环 ----------
async function run() {
  console.log(`加载评分引擎... (market=${MARKET} interval=${INTERVAL} top=${TOP} bars=${BARS} fee=${(FEE * 2 * 100).toFixed(2)}%往返 阈值: 空≤${SHORT_TH} 多≥${LONG_TH})`);
  const analyzeCoin = ENG.analyzeCoin;
  if (typeof analyzeCoin !== "function") throw new Error("analyzeCoin 未找到");
  const syms = await universe();
  console.log(`宇宙: ${syms.length} 个币 (按成交额 Top${TOP})`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const trades = [];
  let htfBlocked = 0, htfPassed = 0;
  for (const sym of syms) {
    let bars;
    try { bars = await klines(sym); } catch (e) { console.log("  " + sym + " klines失败: " + e.message); continue; }
    if (!Array.isArray(bars) || bars.length < WINDOW + TIME_STOP + 5) { console.log("  " + sym + " 数据不足(" + (bars ? bars.length : 0) + ")"); continue; }
    let htfGate = null;
    if (!/^none$/i.test(SHORT_HTF)) {
      try {
        const htfBars = await klines(sym, SHORT_HTF);
        if (Array.isArray(htfBars) && htfBars.length >= 60) htfGate = makeHtfGate(htfBars, SHORT_HTF);
      } catch (e) { /* HTF 拉取失败则不启用门控 */ }
    }
    const ohlc = bars.map(k => [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]]);
    const closes = ohlc.map(k => k[4]);
    let pos = null, coolUntil = 0;
    for (let i = WINDOW; i < ohlc.length - 1; i++) {
      // ---- 持仓管理（当根bar）----
      if (pos) {
        const bar = ohlc[i];
        let exit = null, px = 0;
        if (pos.dir === 1) {
          if (bar[3] <= pos.sl) { exit = "SL"; px = pos.sl; }          // 同bar双触保守先止损
          else if (bar[2] >= pos.tp) { exit = "TP"; px = pos.tp; }
        } else {
          if (bar[2] >= pos.sl) { exit = "SL"; px = pos.sl; }
          else if (bar[3] <= pos.tp) { exit = "TP"; px = pos.tp; }
        }
        if (!exit && i - pos.openIdx >= TIME_STOP) { exit = "TIME"; px = bar[4]; }
        if (exit) {
          const gross = pos.dir * (px / pos.entry - 1);
          const pnlU = 100 * gross - 100 * FEE * 2; // 固定100U名义，往返手续费
          trades.push({ symbol: sym, dir: pos.dir, entry: pos.entry, exitPx: px, reason: exit, bars: i - pos.openIdx, score: pos.score, pnlU: +pnlU.toFixed(3) });
          pos = null; coolUntil = i + COOLDOWN;
          continue;
        }
        continue; // 有持仓不加新仓
      }
      if (i < coolUntil) continue;
      // ---- 信号评估（用已收盘bar i 的评分，下一根开盘入场）----
      const w0 = Math.max(0, i - WINDOW + 1);
      const wc = closes.slice(w0, i + 1), wo = ohlc.slice(w0, i + 1);
      let score;
      try { score = analyzeCoin(wc, sym, wo).score; } catch (e) { continue; }
      if (!isFinite(score)) continue;
      const a = atr14(ohlc, i);
      if (!a || a <= 0) continue;
      const entry = ohlc[i + 1][1]; // 下一根开盘
      if (score >= LONG_TH) pos = { dir: 1, entry, sl: entry - SL_ATR * a, tp: entry + TP_ATR * a, openIdx: i + 1, score };
      else if (score <= SHORT_TH) {
        if (htfGate && htfGate(ohlc[i][0]) !== -1) { htfBlocked++; continue; } // HTF 未同向下行，放弃空信号
        if (htfGate) htfPassed++;
        pos = { dir: -1, entry, sl: entry + SL_ATR * a, tp: entry - TP_ATR * a, openIdx: i + 1 };
      }
    }
  }

  // ---------- 统计 ----------
  const n = trades.length;
  const wins = trades.filter(t => t.pnlU > 0), losses = trades.filter(t => t.pnlU <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlU, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlU, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const totalU = grossWin - grossLoss;
  let peak = 0, maxDD = 0, eq = 0;
  for (const t of trades) { eq += t.pnlU; if (eq > peak) peak = eq; if (peak - eq > maxDD) maxDD = peak - eq; }
  const breakevenWR = (avgWin + avgLoss) > 0 ? avgLoss / (avgWin + avgLoss) * 100 : null;
  const result = {
    meta: { market: MARKET, interval: INTERVAL, top: TOP, bars: BARS, fee: FEE, slAtr: SL_ATR, tpAtr: TP_ATR, timeStop: TIME_STOP, cooldown: COOLDOWN, window: WINDOW, thresholds: [SHORT_TH, LONG_TH], shortHtf: SHORT_HTF, htfBlocked, htfPassed, generatedAt: new Date().toISOString() },
    metrics: { trades: n, winRate: n ? +(wins.length / n * 100).toFixed(1) : null,
      avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2), payoff: avgLoss ? +(avgWin / avgLoss).toFixed(2) : null,
      breakevenWR: breakevenWR === null ? null : +breakevenWR.toFixed(1),
      pf: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
      expPerTrade: n ? +(totalU / n).toFixed(2) : null, totalU: +totalU.toFixed(1), maxDD: +maxDD.toFixed(1),
      recovery: maxDD ? +(totalU / maxDD).toFixed(2) : null,
      exits: { SL: trades.filter(t => t.reason === "SL").length, TP: trades.filter(t => t.reason === "TP").length, TIME: trades.filter(t => t.reason === "TIME").length } },
    perSymbol: {}, trades
  };
  for (const t of trades) {
    const s = result.perSymbol[t.symbol] || (result.perSymbol[t.symbol] = { n: 0, u: 0 });
    s.n++; s.u = +(s.u + t.pnlU).toFixed(2);
  }

  console.log("\n===== 回测结果 =====");
  console.log(`交易笔数: ${n}   胜率: ${result.metrics.winRate}%   PF: ${result.metrics.pf}   赔率(均盈/均亏): ${result.metrics.payoff}`);
  console.log(`均盈 +${result.metrics.avgWin}U / 均亏 -${result.metrics.avgLoss}U   平衡胜率: ${result.metrics.breakevenWR}%`);
  console.log(`每笔期望: ${result.metrics.expPerTrade}U   合计: ${result.metrics.totalU}U   最大回撤: ${result.metrics.maxDD}U   收益/回撤: ${result.metrics.recovery}`);
  console.log(`出场分布: ${JSON.stringify(result.metrics.exits)}`);
  if (!/^none$/i.test(SHORT_HTF)) console.log(`HTF门控(${SHORT_HTF}): 空信号放行 ${htfPassed} 笔 / 拦截 ${htfBlocked} 笔`);
  const ps = Object.entries(result.perSymbol).sort((a, b) => b[1].u - a[1].u);
  if (ps.length) {
    console.log("最好3个: " + ps.slice(0, 3).map(([s, v]) => `${s} ${v.u}U(${v.n}笔)`).join("  "));
    console.log("最差3个: " + ps.slice(-3).map(([s, v]) => `${s} ${v.u}U(${v.n}笔)`).join("  "));
  }
  const rec = result.metrics.recovery;
  console.log(`\n结论: ${n < 30 ? "样本不足(n<30)，不评" : rec === null ? "无数据" : rec >= 2 ? "收益/回撤 ≥ 2.0，可用线以上" : rec >= 1 ? "有边际但低于可用线(2.0)" : "不可用"}`);

  // ---------- A/B 基线对比 ----------
  if (BASELINE) {
    try {
      const base = JSON.parse(fs.readFileSync(path.resolve(BASELINE), "utf8"));
      const bm = base.metrics, nm = result.metrics;
      console.log("\n===== A/B 对比（基线: " + path.basename(BASELINE) + " @ " + (base.meta && base.meta.generatedAt) + "）=====");
      const row = (k, label, fmt) => {
        const b = bm[k], nn = nm[k];
        const d = (typeof b === "number" && typeof nn === "number") ? +(nn - b).toFixed(2) : null;
        console.log(`${label}: ${b} -> ${nn}  ${d === null ? "" : (d >= 0 ? "+" : "") + d}`);
      };
      row("trades", "笔数"); row("winRate", "胜率%"); row("payoff", "赔率"); row("pf", "PF");
      row("expPerTrade", "每笔期望U"); row("totalU", "合计U"); row("maxDD", "最大回撤U"); row("recovery", "收益/回撤");
      console.log("判定: 每笔期望与收益/回撤同时改善 → 采用；任一明显恶化 → 拒绝。");
    } catch (e) { console.error("基线读取失败: " + e.message); }
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log("\n已写出: " + OUT);
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
