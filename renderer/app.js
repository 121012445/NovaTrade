// MARKER_FINAL_v2_XYZ789
// NovaTrade AI 智能分析 - 主脚本
// NovaTrade AI 智能分析平台 - 主应用脚本
let allCoins = [];
let allPrices = {};
let selectedCoin = "BTC";
let priceChart = null, macdChart = null, rsiChart = null, adxChart = null;
let currentFilter = "all";
let btcAnalysis = null;
let lastAnalysisSymbol = null;
let currentRange = "1d";

// ===== 全局状态容器 =====
// index.html 由 4 段独立 <script> 组成，段间只能通过 window 共享，因此保留 window 互操作；
// 此处把散落的 window.__* 收敛到一个命名空间，并保留同名属性作为兼容别名
// （bt/backtest.js 的 vm 沙箱依赖 window.detectPatterns 等顶层引用，不可移除）。
const AppState = {
  // 图表实例
  priceChartSeries: {},   // 主图 series 引用（candle/ma7/ma25/vol）
  srLines: [],            // 当前绘制的支撑/阻力价格线
  chartRO: null,          // 主图 ResizeObserver
  btcRegime: null,        // BTC 联动状态 {score, adx, ts}
  // TrendIQ 模块
  trendIQCoins: [],
  trendIQChart: null,
  trendIQSeries: {},
  trendIQResize: null,
  trendIQReady: false,
  trendIQRendered: false
};
window.AppState = AppState;
// 双向绑定：在 window 上定义访问器属性，读写都直接打到 AppState，
// 这样即使旧代码执行 `window.__priceChartSeries = {}` 也不会与 AppState 脱钩。
// （bt/backtest.js 的 vm 沙箱依赖 window.detectPatterns 等顶层引用，故保留 window 路径。）
function bindStateAlias(key, stateKey) {
  Object.defineProperty(window, key, {
    get() { return AppState[stateKey]; },
    set(v) { AppState[stateKey] = v; },
    configurable: true,
    enumerable: true
  });
}
bindStateAlias('__priceChartSeries', 'priceChartSeries');
bindStateAlias('__srLines', 'srLines');
bindStateAlias('__chartRO', 'chartRO');
bindStateAlias('__btcRegime', 'btcRegime');
bindStateAlias('__trendIQCoins', 'trendIQCoins');
bindStateAlias('__trendIQChart', 'trendIQChart');
bindStateAlias('__trendIQSeries', 'trendIQSeries');
bindStateAlias('__trendIQResize', 'trendIQResize');
bindStateAlias('__trendIQReady', 'trendIQReady');
bindStateAlias('__trendIQRendered', 'trendIQRendered');

// 定时器句柄集中管理：可统一清理，避免重复初始化时任务叠加
const appTimers = [];
function clearAppTimers() {
  while (appTimers.length) { try { clearInterval(appTimers.pop()); } catch (e) {} }
}

window.addEventListener("error", function(e) { console.error("[ERR]", e.message, e.lineno); });
window.addEventListener("unhandledrejection", function(e) { console.error("[UNHANDLED]", e.reason); e.preventDefault(); });

// HTML 转义：所有来自 API / 计算结果的字符串在拼进 innerHTML 前统一走这里
function escapeHtml(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
// JS 字符串字面量转义（用于 onclick="fn('...')" 这类内联处理器属性）
function escapeJsAttr(v) {
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, "\\&quot;")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "&amp;");
}

// 滑动窗口 SMA 序列（O(n)），供主图/TrendIQ 共用；结尾点与 Indicators.SMA 一致
function smaSeries(values, times, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out.push({ time: times[i], value: sum / period });
  }
  return out;
}

function getScoreColor(score) {
  if (score >= 70) return "#10b981";
  if (score >= SIGNAL_LONG_MIN) return "#22c55e";
  if (score >= SHORT_SCORE_MIN) return "#f59e0b";
  if (score >= 30) return "#f97316";
  return "#ef4444";
}

const STABLECOINS=new Set(["USDC","BUSD","DAI","FDUSD","TUSD","USDP","USD1","RLUSD","USDS","UST","USTC","USDL","USDG"]);;
async function loadAllCoins() {
  try {
    const t = await window.binanceAPI.getTickers();
    if (!t || t.__error) { console.error("[app] loadAllCoins API error:", t && t.__error); return []; }
    allCoins = []; allPrices = {};
    const validSuffs = ['USDT']; // 只保留 USDT 交易对（USDC/BUSD/FDUSD 等与 USDT 重复且会污染推荐与统计）
    const stableBases = new Set(['USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'USD1', 'USDS', 'UST', 'USTC', 'USDK', 'SUSD', 'USDX', 'MIM', 'FEI', 'VALOR', 'USDF', 'XSGD', 'BRLR', 'RLUSD', 'USDG', 'PYUSD', 'FRAX', 'USDE', 'AEUR', 'EURI', 'EUR', 'XUSD', 'GUSD', 'VAI', 'USDO']);
    
    for (const s of t) {
      if (!s.symbol) continue;
      let valid = false;
      let base = s.symbol;
      for (const suf of validSuffs) {
        if (s.symbol.endsWith(suf)) {
          base = s.symbol.slice(0, -suf.length);
          valid = true;
          break;
        }
      }
      if (!valid) continue;
      if (stableBases.has(base)) continue;
      const p = parseFloat(s.lastPrice);
      if (!p || p <= 0.0001) continue;
      allPrices[s.symbol] = p;
      allCoins.push({ symbol: s.symbol, price: p, change: parseFloat(s.priceChangePercent) || 0, volume: parseFloat(s.quoteVolume) || 0, high: parseFloat(s.highPrice) || 0, low: parseFloat(s.lowPrice) || 0, hasFutures: false });
    }
    // Merge futures prices (prioritize futures for coins that have contracts)
    try {
      const ft = await window.binanceAPI.getFuturesTickers();
      if (ft && Array.isArray(ft)) {
        const futuresMap = {};
        for (const f of ft) { if (f.symbol) futuresMap[f.symbol] = f; }
        for (const coin of allCoins) {
          const fp = futuresMap[coin.symbol];
          if (fp) {
            coin.hasFutures = true;
            const fPrice = parseFloat(fp.lastPrice);
            if (fPrice > 0) { coin.price = fPrice; allPrices[coin.symbol] = fPrice; }
            const fChg = parseFloat(fp.priceChangePercent);
            if (!isNaN(fChg)) coin.change = fChg;
            const fVol = parseFloat(fp.quoteVolume);
            if (fVol > 0) coin.volume = fVol;
          }
        }
      }
    } catch(e) { console.error("[app] futures tickers merge error:", e.message); }
    allCoins.sort((a, b) => b.volume - a.volume);
    window.__trendIQCoins = allCoins; window.allCoins = allCoins;
    console.log("[app] loadAllCoins:", allCoins.length);
    const el = document.getElementById("coinCount");
    if (el) el.textContent = allCoins.length;
    return allCoins;
  } catch (e) { console.error("[app] loadAllCoins error:", e.message); return []; }
}
async function fetchBTCAnalysis() {
  try {
    // 1009 性能优化：BTC 复用多周期缓存（analyzeMultiTimeframe 写 __mtfCache），
    // 随后 init 的 loadAnalysis("BTC") 直接命中缓存，省去独立的 1h 单周期请求
    const mtf = await analyzeMultiTimeframe("BTC");
    if (mtf && mtf.score !== undefined) return mtf;
    // 兜底：多周期失败时退回原单周期 1h 分析
    const kl = await window.binanceAPI.getKlines("BTCUSDT", "1h", 100).then(r => Array.isArray(r) ? dropOpenCandle(r) : r);
    if (!kl || kl.__error || kl.length < 50) return null;
    const closes = kl.map(k => parseFloat(k[4]));
    return analyzeCoin(closes, "BTC", kl);
  } catch (e) { console.error("[app] fetchBTCAnalysis error:", e.message); return null; }
}
/* ===== 本地 K 线缓存 / 离线兜底（2026-10-09 第十批 ⑨）=====
   目的：① 断网或接口限频时，用上一次成功的数据继续渲染，而不是整页空白；
        ② 降低重复请求量。
   存储：localStorage。一份数据一个 key（避免每次写入都全量序列化），
        另有一个索引 key 记录 {k, ts, n}，按「最久未更新」淘汰。
   容量：最多 80 份 / 约 4MB；超过 7 天的缓存视为过期直接丢弃（避免拿到几周前的旧价）。
   位置：localStorage 由 Electron 管理在应用用户数据目录中，不写入项目目录。 */
const KLINE_CACHE_PREFIX = "novatrade_kline_v1::";
const KLINE_CACHE_IDX = "novatrade_kline_idx_v1";
const KLINE_CACHE_MAX = 80;
const KLINE_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const KLINE_CACHE_TTL = 7 * 24 * 3600 * 1000;

function klineCacheIdxRead() {
  try {
    const raw = localStorage.getItem(KLINE_CACHE_IDX);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function klineCacheIdxWrite(idx) {
  try { localStorage.setItem(KLINE_CACHE_IDX, JSON.stringify(idx)); return true; }
  catch (e) { return false; }
}
function klineCacheDrop(key) {
  try { localStorage.removeItem(KLINE_CACHE_PREFIX + key); } catch (e) {}
}
// 淘汰：先清过期项，再按最旧优先删到「份数 / 字节数」双上限以内
function klineCachePrune(idx, now) {
  const keep = [];
  idx.forEach(function (it) {
    if (!it || typeof it.k !== "string") return;
    if (now - (it.ts || 0) > KLINE_CACHE_TTL) klineCacheDrop(it.k); else keep.push(it);
  });
  keep.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  let bytes = 0;
  keep.forEach(function (it) { bytes += it.n || 0; });
  while (keep.length > KLINE_CACHE_MAX || bytes > KLINE_CACHE_MAX_BYTES) {
    const gone = keep.shift();
    if (!gone) break;
    bytes -= gone.n || 0;
    klineCacheDrop(gone.k);
  }
  return keep;
}
function klineCachePut(key, rows) {
  const stamp = Date.now();
  const text = JSON.stringify({ ts: stamp, data: rows });
  try {
    localStorage.setItem(KLINE_CACHE_PREFIX + key, text);
  } catch (e) {
    // 多半是配额满：按最旧优先腾掉 10 份再试一次，仍失败就放弃（缓存不是必需品）
    try {
      const idx = klineCachePrune(klineCacheIdxRead(), stamp);
      idx.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      for (let i = 0; i < 10 && idx.length; i++) klineCacheDrop(idx.shift().k);
      klineCacheIdxWrite(idx);
      localStorage.setItem(KLINE_CACHE_PREFIX + key, text);
    } catch (e2) { return false; }
  }
  try {
    let idx = klineCacheIdxRead().filter(function (it) { return it && it.k !== key; });
    idx.push({ k: key, ts: stamp, n: text.length });
    klineCacheIdxWrite(klineCachePrune(idx, stamp));
  } catch (e3) {}
  return true;
}
function klineCacheGet(key) {
  try {
    const raw = localStorage.getItem(KLINE_CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.data) || !obj.data.length) return null;
    if (Date.now() - (obj.ts || 0) > KLINE_CACHE_TTL) { klineCacheDrop(key); return null; }
    return { data: obj.data, ts: obj.ts || 0 };
  } catch (e) { return null; }
}
/* ---- 数据源新鲜度指示：实时 / 离线数据 ----
   只在「当前展示的是缓存」时才醒目提示；正常时显示一个低调的「实时」。
   沙箱环境没有 DOM，所有 DOM 操作都包在 try 里，取不到就静默跳过。 */
window.__klineFresh = window.__klineFresh || { stale: false, at: 0, key: null };
function klineFreshBadge() {
  try {
    if (typeof document === "undefined" || !document.createElement) return null;
    let el = document.getElementById("dataFreshBadge");
    if (el) return el;
    const host = document.querySelector(".rail-bottom") || document.querySelector(".topbar-tools");
    if (!host) return null;
    el = document.createElement("div");
    el.id = "dataFreshBadge";
    el.className = "fresh-badge ok";
    host.appendChild(el);
    return el;
  } catch (e) { return null; }
}
function klineFreshAge(ts) {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  return Math.round(s / 86400) + " 天前";
}
function klinePaintFresh() {
  const el = klineFreshBadge();
  if (!el) return;
  const st = window.__klineFresh;
  if (st.stale) {
    el.className = "fresh-badge stale";
    el.textContent = "离线数据 · " + klineFreshAge(st.at);
    el.title = "行情接口暂时不可用，当前展示的是本地缓存（更新于 " +
      new Date(st.at).toLocaleString() + "）";
  } else {
    el.className = "fresh-badge ok";
    el.textContent = "实时";
    el.title = "行情接口正常";
  }
}
function klineMarkFresh() {
  window.__klineFresh.stale = false;
  window.__klineFresh.at = Date.now();
  klinePaintFresh();
}
function klineMarkStale(key, ts) {
  window.__klineFresh.stale = true;
  window.__klineFresh.at = ts || Date.now();
  window.__klineFresh.key = key;
  klinePaintFresh();
}
window.klineCachePut = klineCachePut;
window.klineCacheGet = klineCacheGet;
window.klineCachePrune = klineCachePrune;
window.klineMarkFresh = klineMarkFresh;
window.klineMarkStale = klineMarkStale;
window.klinePaintFresh = klinePaintFresh;
// opts.closedOnly：只返回已收盘的 K 线（用于指标 / 筛选 / 信号）；默认保留最后一根未收盘 K 线（用于图表实时显示）
async function fetchKlines(t, e, i, opts) { const sym = t.endsWith("USDT") ? t : t + "USDT";
  // 2026-10-09 第十批：本地缓存 + 离线兜底。成功就写缓存，失败就回退到上一次的缓存并打「离线数据」标。
  const tf = e || "1h", lim = i || 100;
  const closedOnly = !!(opts && opts.closedOnly);
  const cacheKey = sym + "|" + tf + "|" + lim;
  const toResult = function (rows, extra) {
    const o = rows.map(k => [parseFloat(k[0]), parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])]);
    return Object.assign({ closes: o.map(k => k[4]), ohlc: o, timestamps: o.map(k => k[0]) }, extra || {});
  };
  try {
    const s = await window.binanceAPI.getKlines(sym, tf, lim);
    if (!s || s.__error || !Array.isArray(s) || s.length === 0) throw new Error((s && s.__error) || "空数据");
    klineCachePut(cacheKey, s);   // 缓存存原始数据（含未收盘那根），读取时再按 asOf 过滤
    klineMarkFresh();
    return toResult(closedOnly ? dropOpenCandle(s) : s);
  } catch (err) {
    const hit = klineCacheGet(cacheKey);
    if (hit) {
      klineMarkStale(cacheKey, hit.ts);
      console.warn("[app] fetchKlines 回退本地缓存:", cacheKey, err && err.message);
      return toResult(closedOnly ? dropOpenCandle(hit.data, hit.ts) : hit.data, { stale: true, cachedAt: hit.ts });
    }
    console.error("[app] fetchKlines error:", err.message);
    return { closes: [], ohlc: [], timestamps: [] };
  }
}
async function analyzeMultiTimeframe(symbol){
  try{
    const sym=symbol.endsWith("USDT")?symbol:symbol+"USDT";
    // 30s 结果缓存：主区风险回报标签页与右侧分析栏共用同一份多周期结论，保证数字一致
    window.__mtfCache=window.__mtfCache||{};
    const __c=window.__mtfCache[sym];
    if(__c&&Date.now()-__c.ts<120000)return __c.data;
    const intervals=["15m","1h","4h"];
    const fetchList=intervals.concat(["1d"]); // 1d 仅用于支撑阻力结构，不参与评分加权
    const weights={"15m":0.25,"1h":0.35,"4h":0.40};
    const rawKl=await Promise.all(fetchList.map(iv=>window.binanceAPI.getKlines(sym,iv,iv==="1d"?120:150)));
    // 评分 / 形态 / 支撑阻力只用「已收盘」K 线（与回测同口径，且不随未走完的那根来回重绘）；
    // 现价单独取自最短周期最新一根（含未收盘），入场价 / 止损 / 前向验证记录都以它为准。
    const allKl=rawKl.map(kl=>Array.isArray(kl)?dropOpenCandle(kl):kl);
    let livePrice=NaN;
    for(let q=0;q<rawKl.length&&!(livePrice>0);q++){ const r=rawKl[q]; if(Array.isArray(r)&&r.length) livePrice=parseFloat(r[r.length-1][4]); }
    const results=[];
    for(let i=0;i<intervals.length;i++){
      const kl=allKl[i];
      if(!kl||kl.__error||!Array.isArray(kl)||kl.length<100)continue;
      const closes=kl.map(k=>parseFloat(k[4]));
      const ohlc=kl.map(k=>[parseFloat(k[0]),parseFloat(k[1]),parseFloat(k[2]),parseFloat(k[3]),parseFloat(k[4]),parseFloat(k[5])]);
      const a=analyzeCoinEnhanced(closes,symbol,ohlc);
      results.push({interval:intervals[i],analysis:a});
    }
    if(results.length===0)return null;
    // 加权聚合：4h 40% / 1h 35% / 15m 25%，缺周期时按剩余权重归一
    let wSum=0,ws=0;
    for(const r of results){const w=weights[r.interval]||0.3;wSum+=r.analysis.score*w;ws+=w;}
    const aggScore=Math.round(wSum/ws);
    // 以权重最高的周期为基底（S/R、趋势线、形态、盈亏比等结构信息取高周期）
    const best=results.reduce((b,r)=>(weights[r.interval]||0.3)>(weights[b.interval]||0.3)?r:b);
    const merged=Object.assign({},best.analysis,{tfData:results});
    merged.symbol=symbol;
    merged.baseTf=best.interval;
    merged.tfOhlc={};
    for(let k=0;k<allKl.length;k++){ const ivn=fetchList[k]; if(Array.isArray(allKl[k])&&allKl[k].length>0) merged.tfOhlc[ivn]=allKl[k].map(kk=>[+kk[0],+kk[1],+kk[2],+kk[3],+kk[4],+kk[5]]); }
    merged.score=aggScore;
    deriveLevels(merged);
    merged.signals=results.flatMap(r=>r.analysis.signals.map(s=>Object.assign({},s,{n:"["+r.interval+"] "+s.n})));
    merged.bullish=merged.signals.filter(s=>s.t==="bull").length;
    merged.bearish=merged.signals.filter(s=>s.t==="bear").length;
    merged.totalSignals=merged.signals.length;
    merged.dominance=Math.abs(aggScore-50)/50;
    merged.reasons=merged.signals.filter(s=>s.t!=="neutral").slice(0,5).map(s=>s.n);
    // 24h 涨跌幅用 1h 数据第 24 根近似
    const kl1h=rawKl[1];   // 24h 涨跌幅要的是「此刻 vs 24 根前」，用含未收盘的原始数据
    if(Array.isArray(kl1h)&&kl1h.length>=25){merged.change=(parseFloat(kl1h[kl1h.length-1][4])/parseFloat(kl1h[kl1h.length-25][4])-1)*100;}
    applyBtcRegime(merged);
    // 文案以 BTC 联动修正后的最终 score 为准，门槛用统一常量（与头部评级/方向同源）
    merged.text=merged.score>=SIGNAL_LONG_MIN
      ? "多周期加权结论看涨（4h/1h/15m加权"+merged.score+"分），综合"+merged.totalSignals+"个信号中"+merged.bullish+"个看涨、"+merged.bearish+"个看跌。"
      : merged.score>=SHORT_SCORE_MIN
      ? "多周期信号均衡（加权"+merged.score+"分），建议观望等待更明确的信号。"
      : "多周期加权结论看跌（加权"+merged.score+"分），注意风险控制，谨慎操作。";
    // 风险回报必须与页面展示的聚合评分同源：以最终 score 在基底周期 OHLC 上重算方向与点位。
    // 否则 merged.riskReward 残留基底周期的单方结论（其方向由 4h 单独评分决定），
    // 会出现"头部 34 分卖出、风险回报却给做多"的自相矛盾。结构位/ATR 仍取自高周期基底。
    const __rrOhlc=(merged.tfOhlc&&(merged.tfOhlc[merged.baseTf]||merged.tfOhlc["1h"]||merged.tfOhlc["4h"]))||null;
    if(livePrice>0){ merged.price=livePrice; merged.livePrice=livePrice; }
    merged.riskReward=__rrOhlc?calcRiskReward(merged,__rrOhlc,livePrice>0?livePrice:undefined):null;
    merged.fetchedAt=Date.now();
    window.__mtfCache[sym]={ts:Date.now(),data:merged};
    return merged;
  }catch(e){console.error("[app] analyzeMultiTimeframe error:",e.message);return null}
}

function updateStatus(t) {
  const e = document.querySelector(".status-dot");
  if (e) e.style.background = t ? "var(--positive)" : "var(--negative)";
}
function notifyWidget() {
  if (!window.electronAPI) return;
  try {
    const scored = allCoins.filter(c => c.score !== undefined);
    const t = scored.slice(0, 20).map(c => {
      return Object.assign({}, c, { score: Math.round(c.score) });
    }).sort((a,b) => b.score - a.score);
    window.electronAPI.widgetUpdate({ coins: t, total: allCoins.length });
  } catch (e) { console.error("[app] notifyWidget error:", e.message); }
}

// ===== 代理状态提示：主进程检测到代理不可用时，在界面上明确告知用户 =====
function renderProxyStatus(s) {
  const banner = document.getElementById("proxyBanner");
  const msg = document.getElementById("proxyBannerMsg");
  const detail = document.getElementById("proxyDetail");
  if (!banner || !msg) return;
  if (!s || !s.error) {
    banner.className = "proxy-banner";
    return;
  }
  banner.className = "proxy-banner show err";
  msg.textContent = "⚠ " + s.error;
  detail.textContent = s.proxy ? ("当前代理: " + s.proxy) : "当前为直连模式";
}
async function refreshProxyStatus() {
  if (!window.electronAPI || !window.electronAPI.getProxyStatus) return;
  try {
    const s = await window.electronAPI.getProxyStatus();
    renderProxyStatus(s);
  } catch (e) { console.warn("[app] getProxyStatus failed:", e && e.message); }
}
function setupProxyUI() {
  const btn = document.getElementById("proxyRetryBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "检测中...";
      try {
        const s = await window.electronAPI.redetectProxy();
        renderProxyStatus(s);
        if (!s.error) { btn.textContent = "已修复"; setTimeout(() => loadAllCoins(), 300); }
        else btn.textContent = "重新检测代理";
      } catch (e) { btn.textContent = "重新检测代理"; }
      btn.disabled = false;
    });
  }
  if (window.electronAPI && window.electronAPI.onProxyStatus) {
    window.electronAPI.onProxyStatus(renderProxyStatus);
  }
  refreshProxyStatus();
}

// ===== 信号前向验证：记录每个推荐信号，1h/4h 后用真实价格结算方向命中率 =====
let fwdRecords = [];
let fwdLoaded = false;
const FWD_1H = 3600e3, FWD_4H = 4 * 3600e3;

async function initFwdValidation() {
  try { fwdRecords = (window.binanceAPI && await window.binanceAPI.fwdLoad()) || []; } catch(e) { fwdRecords = []; }
  fwdLoaded = true;
  await resolveFwdSignals();
  renderFwdStats();
}
async function saveFwd() { try { if (window.binanceAPI) await window.binanceAPI.fwdSave(fwdRecords); } catch(e) {} }

function recordFwdSignals(analyses, skipShortSyms, skipLongSyms, sellGateDetail, buyGateDetail) {
  if (!fwdLoaded || !Array.isArray(analyses)) return;
  const now = Date.now();
  let added = 0;
  for (const a of analyses) {
    const dir = a.score >= SIGNAL_LONG_MIN ? "long" : a.score < SIGNAL_SHORT_MAX ? "short" : null; // 原始口径 65/45：45 以下都记，用 gated 字段区分是否放行
    if (!dir || !a.price || !isFinite(a.price) || a.price <= 0) continue;
    // 1006 做空门控记账：空单不再被门控直接丢弃，而是记录 gated/gates 字段，
    // "原始空(<45 全记) vs 门控空(score<39 且过全部否决)" 并行前向验证，n≥30 后数据裁决
    // 1007 多头对称记账：过热区 [70,75) 过滤（裁决B）+ 日线 regime 门控，原始多(≥65 全记)继续留档
    // 1007b gates 细化：emaOK(EMA 交叉)/priceOK(收盘价破 EMA20) 分开记，前向验证可拆分两种放行口径的质量
    let gated = true, gates = null;
    if (dir === "short") {
      const det = (sellGateDetail || {})[a.symbol] || {};
      gates = {
        score39: a.score < SHORT_SCORE_MIN,          // 门槛收紧 45→39
        btcVeto: !!a.shortVeto,                       // BTC 偏多一票否决
        nearSupVeto: !!a.nearSupportVeto,             // 距最近支撑 <1ATR 否决
        stopCapVeto: !!a.stopCapVeto,                         // 1010：止损距离超上限否决
        dailyOK: !(skipShortSyms && skipShortSyms.has(a.symbol)), // 日线门控（EMA死叉 或 价破EMA20）
        emaOK: det.emaOK, priceOK: det.priceOK        // 1007b：两种放行依据分记
      };
      gated = gates.score39 && gates.dailyOK && !gates.btcVeto && !gates.nearSupVeto && !gates.stopCapVeto;
    } else {
      const det = (buyGateDetail || {})[a.symbol] || {};
      gates = {
        overheat: a.score >= OVERHEAT_MIN && a.score < OVERHEAT_MAX, // 70-74 过热区过滤
        stopCapVeto: !!a.stopCapVeto,                                         // 1010：止损距离超上限否决
        dailyOK: !(skipLongSyms && skipLongSyms.has(a.symbol)),       // 日线门控（EMA金叉 或 价在EMA20上）
        emaOK: det.emaOK, priceOK: det.priceOK
      };
      gated = !gates.overheat && gates.dailyOK && !gates.stopCapVeto;
    }
    // 去重：同币同方向 4 小时内已有未结算记录则不重复
    const dup = fwdRecords.some(r => !r.resolved && r.symbol === a.symbol && r.dir === dir && now - r.ts < FWD_4H);
    if (dup) continue;
    const rec = { ts: now, symbol: a.symbol, dir: dir, score: Math.round(a.score), price: a.price, r1h: null, r4h: null, resolved: false };
    rec.gated = gated; rec.gates = gates;
    fwdRecords.push(rec);
    added++;
  }
  // 已结算记录最多保留 2000 条，防止文件无限增长
  const resolvedList = fwdRecords.filter(r => r.resolved);
  if (resolvedList.length > 2000) {
    const drop = new Set(resolvedList.slice(0, resolvedList.length - 2000));
    fwdRecords = fwdRecords.filter(r => !drop.has(r));
  }
  if (added > 0) saveFwd();
}

// 取目标时刻的历史价格（5m K线开盘价），结算不依赖 App 是否在线
// 结算价的时间容差：K 线开盘时间离目标时刻超过这个值就不采用（新上市 / 停牌 / 下架后会取到很远的 K 线）
const FWD_PRICE_TOLERANCE = 10 * 60e3;
// 只有「目标时刻就在刚才」时才允许用现价顶替历史价；App 关闭了几小时再打开时，现价≠当时的价格
const FWD_LIVE_FALLBACK_MAX_LAG = 10 * 60e3;
// 超过这个时间仍取不到结算价的记录判定为「无数据」，不再重试，避免永远挂在待结算
const FWD_EXPIRE_AFTER = 7 * 24 * 3600e3;
async function fwdPriceAt(symbol, targetTs) {
  const sym = symbol.endsWith("USDT") ? symbol : symbol + "USDT";
  const kl = await window.binanceAPI.getKlines(sym, "5m", 1, targetTs);
  if (Array.isArray(kl) && !kl.__error && kl.length > 0 && Math.abs(Number(kl[0][0]) - targetTs) <= FWD_PRICE_TOLERANCE) {
    const px = parseFloat(kl[0][1]);
    return px > 0 ? px : null;
  }
  return null;
}
async function resolveFwdSignals() {
  if (!fwdLoaded) return;
  const now = Date.now();
  let changed = false;
  // 迁移修复：旧记录 1h/4h 曾同刻结算（App 离线所致），用 K 线回填真实 1h 价
  for (const r of fwdRecords.filter(r => r.resolved && r.r1h && r.r4h && r.r1h.price === r.r4h.price && !r.r1h.backfilled)) {
    try {
      const px = await fwdPriceAt(r.symbol, r.ts + FWD_1H);
      if (px) { const pct = (px / r.price - 1) * 100; r.r1h = { price: px, pct: +pct.toFixed(3), hit: r.dir === "long" ? px > r.price : px < r.price, backfilled: true }; changed = true; }
    } catch(e) {}
  }
  for (const r of fwdRecords.filter(r => !r.resolved)) {
    const age = now - r.ts;
    const need = [];
    if (r.r1h === null && age >= FWD_1H) need.push("r1h");
    if (r.r4h === null && age >= FWD_4H) need.push("r4h");
    for (const key of need) {
      const targetTs = key === "r1h" ? r.ts + FWD_1H : r.ts + FWD_4H;
      try {
        let px = await fwdPriceAt(r.symbol, targetTs);
        // 兜底：仅当目标时刻就在刚才（现价≈当时价）才用现价；否则宁可留着下个周期再取，也不拿现在的价冒充过去的价
        if (!px && now - targetTs <= FWD_LIVE_FALLBACK_MAX_LAG) {
          const t = await window.binanceAPI.getPrice(r.symbol.endsWith("USDT") ? r.symbol : r.symbol + "USDT");
          if (t && t.price && !t.__error) px = parseFloat(t.price);
        }
        if (px) {
          const pct = (px / r.price - 1) * 100;
          const hit = r.dir === "long" ? px > r.price : px < r.price;
          r[key] = { price: px, pct: +pct.toFixed(3), hit: hit };
          changed = true;
        }
      } catch(e) {}
    }
    if (r.r1h !== null && r.r4h !== null) r.resolved = true;
    else if (age > FWD_EXPIRE_AFTER) { r.resolved = true; r.expired = true; changed = true; }   // 取不到结算价：标记无数据，不计入命中率
  }
  if (changed) await saveFwd();
}

function fwdStatsCalc() {
  const calc = (key) => {
    const rs = fwdRecords.filter(r => r[key] !== null);
    if (rs.length === 0) return { n: 0, hitRate: null, avgPct: null };
    const longs = rs.filter(r => r.dir === "long");
    const shorts = rs.filter(r => r.dir === "short");
    return {
      n: rs.length,
      hitRate: rs.filter(r => r[key].hit).length / rs.length * 100,
      longN: longs.length, shortN: shorts.length,
      avgPct: rs.reduce((s, r) => s + r[key].pct * (r.dir === "long" ? 1 : -1), 0) / rs.length
    };
  };
  return { h1: calc("r1h"), h4: calc("r4h"), pending: fwdRecords.filter(r => !r.resolved).length };
}

function fwdQualityStatus() {
  const stats = fwdStatsCalc();
  const enough = stats.h1.n >= FWD_QUALITY_MIN_N;
  const weak = enough && (stats.h1.hitRate < FWD_QUALITY_MIN_HIT || stats.h1.avgPct <= 0);
  return {
    stats, enough, weak, actionable: enough && !weak,
    label: !enough ? "样本积累中 · 仅观察" : weak ? "前向表现偏弱 · 仅观察" : "前向验证达标"
  };
}

function renderFwdStats() {
  const el = document.getElementById("fwdStats");
  if (!el) return;
  const quality = fwdQualityStatus();
  const s = quality.stats;
  const fmt = (v) => v === null ? "--" : v.toFixed(1) + "%";
  const cls = (v, base) => v === null ? "" : (v >= (base === undefined ? 50 : base) ? "hit-good" : "hit-bad");
  el.innerHTML =
    "<span class=\"fwd-title\">信号前向验证</span>" +
    "<span>1h 方向命中<b class=\"" + cls(s.h1.hitRate) + "\">" + fmt(s.h1.hitRate) + "</b> (n=" + s.h1.n + (s.h1.n ? "，多" + s.h1.longN + "/空" + s.h1.shortN : "") + ")</span>" +
    "<span>4h 方向命中<b class=\"" + cls(s.h4.hitRate) + "\">" + fmt(s.h4.hitRate) + "</b> (n=" + s.h4.n + ")</span>" +
    (s.h1.avgPct !== null ? "<span>1h 方向均值收益<b class=\"" + cls(s.h1.avgPct, 0) + "\">" + (s.h1.avgPct >= 0 ? "+" : "") + s.h1.avgPct.toFixed(2) + "%</b></span>" : "") +
    "<span>待结算<b>" + s.pending + " 条</b></span>" +
    "<span class=\"fwd-health " + (quality.actionable ? "healthy" : "weak") + "\">策略状态<b>" + quality.label + "</b></span>";
  // 台账与统计同源，跟着一起刷新
  try { renderFwdLedger(); } catch (e) { console.error("[app] ledger:", e); }
}

// 交易对计价后缀（修复 USDC 等交易对被硬编码显示为 /USDT 的标签错误）
const KNOWN_QUOTES = ["USDT","USDC","FDUSD","TUSD","USDP","USD1","BUSD","DAI","EUR","EURI","AEUR","TRY","BRL"];
function quoteOf(symbol) { const q = KNOWN_QUOTES.find(q => symbol.endsWith(q)); return q || "USDT"; }
function splitSymbol(symbol) {
  const quote = quoteOf(symbol);
  return { base: symbol.endsWith(quote) ? symbol.slice(0, -quote.length) : symbol, quote: quote };
}
// ---------- 2026-10-09 第四步新增：自选列表 ----------
// 纯本地（localStorage），用于把常看的币置顶；同时是选币扫描「仅看自选」的数据源。
const WATCH_KEY = "novatrade.watchlist.v1";
function loadWatchlist() {
  try { const a = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; }
  catch (e) { return []; }
}
function saveWatchlist(a) { try { localStorage.setItem(WATCH_KEY, JSON.stringify(a.slice(0, 300))); } catch (e) {} }
function isWatched(sym) { return loadWatchlist().indexOf(sym) !== -1; }
function toggleWatch(sym) {
  if (!sym) return;
  const a = loadWatchlist();
  const i = a.indexOf(sym);
  if (i === -1) { a.unshift(sym); linkedToast(splitSymbol(sym).base + " 已加入自选"); }
  else { a.splice(i, 1); linkedToast(splitSymbol(sym).base + " 已移出自选"); }
  saveWatchlist(a);
  __marketSig = "";                      // 强制重建卡片（否则差量刷新不会更新星标）
  try { renderMarket(currentFilter); } catch (e) {}
  try { renderSidebar(); } catch (e) {}
  try { if (typeof renderAnalysis === "function" && window.__lastAnalysisData) { /* 星标在头部，下面单独刷新 */ } } catch (e) {}
  const star = document.getElementById("analysisStar");
  if (star) { const on = isWatched(selectedCoin); star.textContent = on ? "★" : "☆"; star.classList.toggle("on", on); }
}
window.toggleWatch = toggleWatch;
window.isWatched = isWatched;
window.loadWatchlist = loadWatchlist;
function coinCardHtml(co) {
  const act = co.symbol===selectedCoin ? " active" : "";
  const up = co.change>=0;
  const w = isWatched(co.symbol);
  return `<div class="coin-card${act}" data-coin="${escapeHtml(co.symbol)}">
    <span class="coin-star${w ? " on" : ""}" title="${w ? "移出自选" : "加入自选"}" onclick="event.stopPropagation();toggleWatch('${escapeJsAttr(co.symbol)}')">${w ? "★" : "☆"}</span>
    <div class="coin-name">${escapeHtml(co.symbol)}${co.hasFutures ? ' <span class="futures-tag">合约</span>' : ''}</div><div class="coin-symbol">/${quoteOf(co.symbol)}</div>
    <div class="coin-price">${formatPrice(co.price)}</div>
    <div class="coin-change ${up?"up":"down"}">${up?"▲":"▼"} ${Math.abs(co.change).toFixed(2)}%</div>
  </div>`;
}
let __marketSig = "";
function renderMarket(filter) { const grid = document.getElementById("coinGrid"); if(!grid) return;
  let coins = [...allCoins];
  if (filter==="watch") coins = coins.filter(c => isWatched(c.symbol));
  if (filter==="gainers") coins.sort((a,b)=>b.change-a.change);
  else if (filter==="losers") coins.sort((a,b)=>a.change-b.change);
  else if (filter==="volume") coins.sort((a,b)=>b.volume-a.volume);
  // 自选置顶：任何视图下都把自选币排在最前，方便盯盘（V8 的 sort 是稳定的，不会打乱原有次序）
  if (filter !== "watch") {
    const w = loadWatchlist();
    if (w.length) {
      const rank = new Map(w.map((s, i) => [s, i]));
      coins.sort((a, b) => (rank.has(a.symbol) ? rank.get(a.symbol) : 9999) - (rank.has(b.symbol) ? rank.get(b.symbol) : 9999));
    }
  }
  const top = coins.slice(0, 80);
  if (top.length === 0) {
    grid.innerHTML = filter === "watch"
      ? "<div class=\"recommend-placeholder\"><p>自选列表还是空的。在市场卡片右上角点 ☆ 即可加入自选，也可以直接把自选当盯盘清单。</p></div>"
      : "<div class=\"recommend-placeholder\"><p>行情数据暂不可用，请检查网络后重试</p></div>";
    __marketSig = "";
    return;
  }
  // 性能：币种集合不变时只差量刷新价格/涨跌文本，不重建 DOM（消除 30s 定时刷新的整块重排与闪烁）
  const sig = top.map(c=>c.symbol).join(",");
  if (sig !== __marketSig || grid.children.length !== top.length) {
    __marketSig = sig;
    grid.innerHTML = top.map(coinCardHtml).join("");
    return;
  }
  const cards = grid.children;
  for (let i=0;i<cards.length;i++) {
    const co = top[i], up = co.change>=0;
    const priceEl = cards[i].querySelector(".coin-price");
    const chEl = cards[i].querySelector(".coin-change");
    if (priceEl) priceEl.textContent = formatPrice(co.price);
    if (chEl) { chEl.textContent = (up?"▲ ":"▼ ")+Math.abs(co.change).toFixed(2)+"%"; chEl.className = "coin-change "+(up?"up":"down"); }
  }
}

function renderSidebar() { const list = document.getElementById("coinList"); if(!list) return;
  const top = allCoins.slice(0, 30);
  const cnt = document.getElementById("sbCount"); if (cnt) cnt.textContent = top.length;
  list.innerHTML = top.map(c => {
    const act = c.symbol===selectedCoin ? " active" : "";
    return `<div class="coin-item${act}" data-coin="${escapeHtml(c.symbol)}">
      <span class="coin-item-name">${escapeHtml(c.symbol)}</span>
      <span class="coin-item-price">${formatPrice(c.price)}</span>
    </div>`;
  }).join("");
  filterCoinList();
}
function filterCoinList() {
  const inp = document.getElementById("sbSearch");
  const q = (inp && inp.value ? inp.value : "").trim().toLowerCase();
  document.querySelectorAll("#coinList .coin-item").forEach(el => {
    el.style.display = (!q || (el.dataset.coin || "").toLowerCase().includes(q)) ? "" : "none";
  });
}
window.filterCoinList = filterCoinList;

let __searchTimer = null;
function searchCoin() {
  clearTimeout(__searchTimer);
  __searchTimer = setTimeout(() => { // 150ms 防抖，避免逐键重建 DOM
    const q = document.getElementById("searchInput").value.toUpperCase();
    const filtered = allCoins.filter(c => c.symbol.includes(q));
    const grid = document.getElementById("coinGrid");
    grid.innerHTML = filtered.slice(0,80).map(coinCardHtml).join("");
    __marketSig = ""; // 搜索结果为临时视图，清空签名以便下一次全量恢复
  }, 150);
}

function filterMarket(f) {
  currentFilter = f;
  // 用 data-filter 匹配而不是 textContent：新增「自选」按钮后，按文字匹配会漏判
  document.querySelectorAll(".filters .filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === f));
  renderMarket(f);
}

// ---------- 2026-10-10 修复：分析渲染的「过期结果」闸门 ----------
// 症状：市场页点击币种跳转技术分析，有概率显示上一个（已缓存）币种的数据。
// 根因：renderAnalysis 共 6 个调用点，且都是异步落地（点击 / 10s 定时刷新 / 周期按钮 / 联动跳转 / 视图切换）。
//       其中「10s 定时刷新」与「周期按钮」是在 await 之后才去读全局 selectedCoin ——
//       等待期间用户切了币，就会用「新币的名字 + 旧币的数据」渲染；反之慢的旧请求后到也会覆盖新请求。
//       K 线本地缓存命中时几乎瞬时返回，让先后顺序随机化，所以表现为「有概率」而不是必现。
// 修法：任何渲染前先核对「渲染目标是否仍是当前选中的币」，不是就丢弃。
//       比较前双方都归一化（去掉 USDT 后缀 + 转大写）：启动时 selectedCoin 是 "BTC"，
//       点击市场卡片后会变成 "BTCUSDT"，不归一化会把同一个币判成两个。
function anaSymKey(s) {
  return String(s == null ? "" : s).replace(/USDT$/i, "").toUpperCase();
}
function anaIsCurrentTarget(symbol) {
  const want = anaSymKey(symbol);
  if (!want) return true;                                    // 目标币种未知：不拦，宁可渲染也不留白
  if (typeof selectedCoin === "undefined" || !selectedCoin) return true;
  return anaSymKey(selectedCoin) === want;
}
window.anaSymKey = anaSymKey;
window.anaIsCurrentTarget = anaIsCurrentTarget;

async function selectCoin(symbol) {
  selectedCoin = symbol;
  renderMarket(currentFilter);
  document.querySelectorAll("#coinGrid .coin-card").forEach(el => el.classList.toggle("active", el.dataset.coin === symbol));
  renderSidebar();
  await loadAnalysis(symbol);
  if (window.showView) showView("analysis");
  // 联动 TrendIQ
  if (window.selectTrendIQCoin) {
    window.selectTrendIQCoin(symbol);
  }
}
// ===== 视图路由（桌面外壳） =====
const VIEW_TITLES = { market: "市场概览", recommend: "AI 智能推荐", analysis: "AI 深度分析", linkage: "联动全景", screener: "选币扫描", alerts: "价格预警", mine: "持仓与复盘" };
function showView(name) {
  window.__currentView = name;
  document.querySelectorAll(".views .view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  document.querySelectorAll(".rail-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  const t = document.getElementById("topbarTitle"); if (t) t.textContent = VIEW_TITLES[name] || name;
  // 图表在隐藏视图中以兜底宽度创建；切回时用最近一次分析数据按真实尺寸重建
  if (name === "analysis" && window.__lastAnalysisData) {
    const d = window.__lastAnalysisData;
    // 2026-10-10：只重建「当前选中币」的图表 —— 快照若还是上一个币，重建出来就是上一个币
    if (anaIsCurrentTarget(d.symbol)) {
      try { renderAnalysis(d.symbol, d.a, d.klines); } catch(e) { console.error("[app] view chart re-init:", e); }
    }
  }
  // 联动全景：首次进入才拉相关性数据（懒加载，避免拖慢启动）
  if (name === "linkage") { try { renderLinkageView(); } catch(e) { console.error("[app] linkage view:", e); } }
  // 选币扫描：首次进入才构建条件表单（避免启动时多一次 DOM 构建）
  if (name === "screener") { try { initScreenerForm(); } catch(e) { console.error("[app] screener view:", e); } }
  // 2026-10-09 第十批：价格预警 / 我的交易（同样是懒渲染）
  if (name === "alerts") { try { renderAlerts(); } catch(e) { console.error("[app] alerts view:", e); } }
  if (name === "mine") { try { renderMine(); } catch(e) { console.error("[app] mine view:", e); } }
}
window.showView = showView;
// 分析区标签页切换（事件委托，绑定一次）
document.addEventListener("click", function(e) {
  const b = e.target.closest(".ana-tab"); if (!b) return;
  const am = document.getElementById("analysisMain"); if (!am || !am.contains(b)) return;
  window.__anaActivePane = b.dataset.pane; // 记住选择，定时刷新重建后恢复
  am.querySelectorAll(".ana-tab").forEach(t => t.classList.toggle("active", t === b));
  am.querySelectorAll(".ana-pane").forEach(p => p.classList.toggle("active", p.id === b.dataset.pane));
  // 资金面页签的数据源独立（衍生品接口），切到时才懒加载，避免每次分析都多发 5 个请求
  if (b.dataset.pane === "p_deriv") { try { renderDerivatives(); } catch (err) { console.error("[app] deriv pane:", err); } }
  // 阈值回测页签：只重建表单/结果，不自动跑（一次遍历要 1-2 秒，应由用户点按钮触发）
  if (b.dataset.pane === "p_bt") { try { renderBacktest(); } catch (err) { console.error("[app] bt pane:", err); } }
  // 2026-10-09 第十批：盘口与强平（实时数据，懒加载）/ 仓位计算（纯本地计算）
  if (b.dataset.pane === "p_flow") { try { renderFlowPane(); } catch (err) { console.error("[app] flow pane:", err); } }
  if (b.dataset.pane === "p_size") { try { renderSizeCalc(); } catch (err) { console.error("[app] size pane:", err); } }
});

async function loadAnalysis(symbol) { 
  const main = document.getElementById("analysisMain");
  main.innerHTML = "<div class=\"analysis-placeholder\"><p>正在多周期分析...</p></div>";
  const [analysis, klines] = await Promise.all([analyzeMultiTimeframe(symbol), fetchKlines(symbol)]);
  // 2026-10-10：等待期间用户已切到别的币 → 本次结果作废。注意要在改占位符之前返回，
  // 否则会把新币正在加载的「正在多周期分析...」覆盖成「暂无数据」。
  if (!anaIsCurrentTarget(symbol)) return;
  if (!analysis) { main.innerHTML = "<div class=\"analysis-placeholder\"><p>暂无数据</p></div>"; return; }
  renderAnalysis(symbol, analysis, klines);
}

// ---------- 2026-10-09 第一步新增：量价结构 + 三维投票 ----------
// 设计原则：新增指标一律先以「独立展示 + 三维投票」形式接入，**不改动 analyzeCoin 的主 score，
// 也不动 SIGNAL_LONG_MIN / SHORT_SCORE_MIN / OVERHEAT 阈值**。理由见路线图「不建议做」第 3 条：
// 阈值调整必须等历史回测引擎（P0-02）就绪，否则等于在小样本上对历史噪声过拟合。
function computeVolumeStats(ohlc) {
  if (!ohlc || ohlc.length < 20) return null;
  const closes = ohlc.map(function (k) { return k[4]; });
  return {
    bb: Indicators.BB(closes),
    obv: Indicators.OBV(ohlc, 20),
    kdj: Indicators.KDJ(ohlc, 9),
    vwap: Indicators.VWAP(ohlc, 96),
    vp: Indicators.VolumeProfile(ohlc, 24)
  };
}
// 三维投票：趋势维（ADX + DI±）、均值回归维（布林 %B + RSI）、量价维（OBV）。
// 与主 score 相互独立——三票一致时结论更可信；互相矛盾时明确提示观望，而不是硬凑一个方向。
function computeVotes(a, vs) {
  const ind = (a && a.indicators) || {};
  const adx = parseFloat(ind.adx), pdi = parseFloat(ind.pdi), mdi = parseFloat(ind.mdi);
  let trend = 0;
  if (isFinite(pdi) && isFinite(mdi)) {
    const dir = pdi > mdi ? 1 : -1;
    trend = (isFinite(adx) && adx > 25) ? dir : dir * 0.5; // ADX<=25 视为弱趋势，票权减半
  }
  let meanRevert = 0;
  const rsi = parseFloat(ind.rsi);
  const pctB = (vs && vs.bb) ? vs.bb.pctB : null;
  if (pctB !== null || isFinite(rsi)) {
    const lowHit = (pctB !== null && pctB < 0.2) || (isFinite(rsi) && rsi < 30);
    const highHit = (pctB !== null && pctB > 0.8) || (isFinite(rsi) && rsi > 70);
    meanRevert = lowHit ? 1 : highHit ? -1 : 0;
  }
  let volume = 0;
  if (vs && vs.obv) volume = vs.obv.state === "bull" ? 1 : vs.obv.state === "bear" ? -1 : 0;
  return { trend: trend, meanRevert: meanRevert, volume: volume };
}
function renderVotesAndVolume(a, vs) {
  const voteBox = document.getElementById("votePanel");
  if (voteBox) {
    const v = computeVotes(a, vs);
    const items = [
      { name: "趋势维", hint: "ADX / DI±", val: v.trend },
      { name: "均值回归维", hint: "布林 %B / RSI", val: v.meanRevert },
      { name: "量价维", hint: "OBV", val: v.volume }
    ];
    const bull = items.filter(function (i) { return i.val > 0; }).length;
    const bear = items.filter(function (i) { return i.val < 0; }).length;
    let concl = "维度中性", cls = "neutral";
    if (bull >= 2 && bear === 0) { concl = "三维共振偏多"; cls = "buy"; }
    else if (bear >= 2 && bull === 0) { concl = "三维共振偏空"; cls = "sell"; }
    else if (bull > 0 && bear > 0) { concl = "维度分歧，建议观望"; cls = "neutral"; }
    else if (bull > 0) { concl = "偏多（票数不足）"; cls = "buy"; }
    else if (bear > 0) { concl = "偏空（票数不足）"; cls = "sell"; }
    voteBox.innerHTML = "<div class=\"vote-head\"><span class=\"vote-title\">三维投票</span><span class=\"vote-concl " + cls + "\">" + concl + "</span></div>" +
      "<div class=\"vote-rows\">" + items.map(function (i) {
        const lbl = i.val > 0 ? "看涨" : i.val < 0 ? "看跌" : "中性";
        const c = i.val > 0 ? "buy" : i.val < 0 ? "sell" : "neutral";
        return "<div class=\"vote-row\"><span class=\"vote-name\">" + i.name + "</span><span class=\"vote-hint\">" + i.hint + "</span><span class=\"vote-val " + c + "\">" + lbl + "</span></div>";
      }).join("") + "</div>";
  }
  const wrap = document.getElementById("vpWrap");
  if (!wrap) return;
  if (!vs) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">K 线数据不足，无法计算量价结构</div>"; return; }
  const fmt = function (x) { return formatPrice(x); };
  let html = "";
  if (vs.vp) {
    const vp = vs.vp;
    const maxV = Math.max.apply(null, vp.vols.concat([1]));
    const bars = vp.vols.map(function (vol, i) {
      const price = vp.lo + vp.step * (i + 0.5);
      const w = Math.max(2, Math.round((vol / maxV) * 100));
      const isPoc = Math.abs(price - vp.poc) < vp.step / 2;
      const inVA = price >= vp.vaLow && price <= vp.vaHigh;
      const cls = isPoc ? "poc" : inVA ? "va" : "out";
      return "<div class=\"vp-bar-row\" title=\"" + fmt(price) + " · 成交量 " + Math.round(vol) + "\">" +
        "<span class=\"vp-price\">" + fmt(price) + "</span>" +
        "<span class=\"vp-bar " + cls + "\" style=\"width:" + w + "%\"></span></div>";
    }).join("");
    const posCls = (vp.price > vp.vaHigh) ? "buy" : (vp.price < vp.vaLow) ? "sell" : "neutral";
    const posTxt = (vp.price > vp.vaHigh) ? "价值区上方（偏强）" : (vp.price < vp.vaLow) ? "价值区下方（偏弱）" : "价值区内（均衡）";
    html += "<div class=\"vp-card\"><div class=\"vp-head\">成交量分布 · Volume Profile（" + vp.bins + " 箱）</div>" +
      "<div class=\"vp-summary\">" +
        "<div class=\"vp-item\"><span class=\"vp-label\">POC 最大量价区</span><span class=\"vp-value\">" + fmt(vp.poc) + "</span></div>" +
        "<div class=\"vp-item\"><span class=\"vp-label\">价值区 VA (70%)</span><span class=\"vp-value\">" + fmt(vp.vaLow) + " – " + fmt(vp.vaHigh) + "</span></div>" +
        "<div class=\"vp-item\"><span class=\"vp-label\">当前价位置</span><span class=\"vp-value " + posCls + "\">" + posTxt + "</span></div>" +
      "</div>" +
      "<div class=\"vp-bars\">" + bars + "</div>" +
      "<div class=\"vp-note\">POC 与价值区是历史筹码最密集的价格带。价格在价值区上方运行偏强、下方偏弱；回到 POC 附近常有支撑/阻力作用，可与「多周期与支撑阻力」页交叉印证。</div></div>";
  }
  let extra = "";
  if (vs.obv) extra += "<div class=\"vp-item\"><span class=\"vp-label\">OBV 量价（近 20 根）</span><span class=\"vp-value " + (vs.obv.state === "bull" ? "buy" : vs.obv.state === "bear" ? "sell" : "neutral") + "\">" + vs.obv.note + "</span></div>";
  if (vs.vwap) extra += "<div class=\"vp-item\"><span class=\"vp-label\">VWAP(96) 机构成本线</span><span class=\"vp-value " + (vs.vwap.above ? "buy" : "sell") + "\">" + fmt(vs.vwap.value) + " · 现价" + (vs.vwap.above ? "在上方 +" : "在下方 ") + vs.vwap.dev.toFixed(2) + "%</span></div>";
  if (vs.kdj) extra += "<div class=\"vp-item\"><span class=\"vp-label\">KDJ(9,3,3)</span><span class=\"vp-value " + (vs.kdj.j > 100 ? "sell" : vs.kdj.j < 0 ? "buy" : "neutral") + "\">K " + vs.kdj.k.toFixed(1) + " / D " + vs.kdj.d.toFixed(1) + " / J " + vs.kdj.j.toFixed(1) + "</span></div>";
  if (vs.bb) extra += "<div class=\"vp-item\"><span class=\"vp-label\">布林 %B / 带宽</span><span class=\"vp-value " + (vs.bb.pctB < 0.2 ? "buy" : vs.bb.pctB > 0.8 ? "sell" : "neutral") + "\">" + vs.bb.pctB.toFixed(2) + " / " + vs.bb.width.toFixed(2) + "%</span></div>";
  if (extra) html += "<div class=\"vp-card\"><div class=\"vp-head\">量价与动能辅助</div><div class=\"vp-summary\">" + extra + "</div>" +
    "<div class=\"vp-note\">OBV 看「量能是否跟上价格」，VWAP 看「现价相对机构成本的位置」，KDJ 是比 RSI 更敏感的超买超卖读数，%B 表示现价在布林通道中的相对位置（0 = 下轨，1 = 上轨）；带宽收窄常预示变盘。</div></div>";
  wrap.innerHTML = html;
}
// ==================== 2026-10-09 联动全景（纯数据分析，不涉及任何交易执行）====================
// 三个子视图：市场热力图（全市场结构）/ 联动网络（币种相关性）/ 信号传导链（领先滞后与补涨空间）
// 数据全部来自既有接口（allCoins 全市场 ticker + getKlines），不新增 IPC 端点，不产生任何下单动作。
let linkageCache = { ts: 0, coins: [], rets: {}, corr: null };
function openLinkedCoin(symbol) {
  // 热力图 / 网络图 / 传导链点击 → 与市场列表一致：切到技术分析并载入该币
  try { selectCoin(symbol); } catch (e) { console.error("[app] openLinkedCoin:", e); }
}
function switchLinkagePane(pane) {
  document.querySelectorAll("#linkageTabs .ana-tab").forEach(function (b) { b.classList.toggle("active", b.dataset.lpane === pane); });
  ["l_heat", "l_net", "l_chain", "l_sector", "l_cmp"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("active", id === pane);
  });
  // 板块与多币对比要现算（多币对比还会拉 K 线），所以切到才渲染，避免进联动全景就多打请求
  if (pane === "l_sector") { try { renderSectors(); } catch (e) { console.error("[app] sector:", e); } }
  if (pane === "l_cmp") { try { renderCmpPicker(); renderMultiCompare(); } catch (e) { console.error("[app] compare:", e); } }
}
async function renderLinkageView() {
  renderHeatmap();                 // 热力图只用 allCoins，立即可画，不必等网络请求
  await ensureLinkageData();
  renderNetwork();
  renderChain();
}
async function refreshLinkage() {
  const note = document.getElementById("linkageNote");
  if (note) note.textContent = "正在刷新联动数据...";
  linkageCache.ts = 0;             // 强制过期
  await renderLinkageView();
  if (note) note.textContent = "面积 = 24h 成交额 · 颜色 = 24h 涨跌幅（绿涨红跌）· 点击任意格子或节点可直达该币技术分析";
}
// ---------- 通用：Pearson 相关系数 / 对数收益率 ----------
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 8) return 0;
  const xs = x.slice(x.length - n), ys = y.slice(y.length - n);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx <= 0 || vy <= 0) return 0;
  return cov / Math.sqrt(vx * vy);
}
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    out.push((a > 0 && b > 0) ? Math.log(b / a) : 0);
  }
  return out;
}
function coinChange(symbol) {
  const c = (allCoins || []).find(function (x) { return x.symbol === symbol; });
  return (c && isFinite(c.change)) ? c.change : 0;
}
// ---------- ① 市场热力图：面积 = 成交额，颜色 = 24h 涨跌幅（与应用主体一致：绿涨红跌）----------
function heatColor(chg) {
  const c = Math.max(-15, Math.min(15, chg || 0)) / 15;   // 归一到 -1..1
  const mag = Math.abs(c);
  const base = c >= 0 ? [30, 132, 73] : [192, 57, 43];    // 绿（涨） / 红（跌）
  // 用 alpha 叠加到页面底色：亮色主题得到浅色底、暗色主题得到深色底，文字色（--text-primary）自然可读
  return "rgba(" + base[0] + "," + base[1] + "," + base[2] + "," + (0.16 + mag * 0.56).toFixed(3) + ")";
}
// 二分树图：按权重递归对半切，交替横竖。比 squarify 简单，视觉上已足够稳定
function treemapLayout(items, x, y, w, h, out, depth) {
  if (!items || !items.length) return out;
  depth = depth || 0;
  if (items.length === 1 || depth > 24 || w <= 0.5 || h <= 0.5) {
    items.forEach(function (it) { out.push({ symbol: it.symbol, change: it.change, volume: it.value, x: x, y: y, w: w, h: h }); });
    return out;
  }
  const total = items.reduce(function (a, b) { return a + b.value; }, 0);
  if (total <= 0) return out;
  let acc = 0, i = 0;
  while (i < items.length - 1 && acc + items[i].value < total / 2) { acc += items[i].value; i++; }
  const left = items.slice(0, i + 1), right = items.slice(i + 1);
  if (!right.length) {
    out.push({ symbol: items[0].symbol, change: items[0].change, volume: items[0].value, x: x, y: y, w: w, h: h });
    return out;
  }
  const leftSum = left.reduce(function (a, b) { return a + b.value; }, 0);
  const frac = Math.max(0.08, Math.min(0.92, leftSum / total));
  if (w >= h) {
    treemapLayout(left, x, y, w * frac, h, out, depth + 1);
    treemapLayout(right, x + w * frac, y, w * (1 - frac), h, out, depth + 1);
  } else {
    treemapLayout(left, x, y, w, h * frac, out, depth + 1);
    treemapLayout(right, x, y + h * frac, w, h * (1 - frac), out, depth + 1);
  }
  return out;
}
function renderHeatmap() {
  const wrap = document.getElementById("heatmapWrap");
  if (!wrap) return;
  const coins = (allCoins || []).filter(function (c) { return c && c.volume > 0; })
    .sort(function (a, b) { return b.volume - a.volume; }).slice(0, 60);
  if (!coins.length) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">市场数据未加载，请先到「市场」页等待行情加载完成</div>"; return; }
  const W = 1000, H = 520;
  const items = coins.map(function (c) { return { symbol: c.symbol, value: c.volume, change: c.change }; });
  const cells = treemapLayout(items, 0, 0, W, H, []);
  const totalVol = items.reduce(function (a, b) { return a + b.value; }, 0);
  const inner = cells.map(function (o) {
    const area = o.w * o.h;
    const label = String(o.symbol).replace(/USDT$/, "");
    const chg = (o.change >= 0 ? "+" : "") + (o.change || 0).toFixed(2) + "%";
    return "<div class=\"hm-cell\" style=\"left:" + (o.x / W * 100).toFixed(3) + "%;top:" + (o.y / H * 100).toFixed(3) +
      "%;width:" + (o.w / W * 100).toFixed(3) + "%;height:" + (o.h / H * 100).toFixed(3) + "%;background:" + heatColor(o.change) + "\"" +
      " onclick=\"openLinkedCoin('" + escapeJsAttr(o.symbol) + "')\" title=\"" + escapeHtml(o.symbol) + " · 24h " + chg + " · 成交额 " + (o.volume / 1e6).toFixed(1) + "M\">" +
      "<span class=\"hm-sym\">" + escapeHtml(label) + "</span>" +
      (area > 3200 ? "<span class=\"hm-chg\">" + chg + "</span>" : "") + "</div>";
  }).join("");
  const up = coins.filter(function (c) { return c.change > 0; }).length;
  const down = coins.filter(function (c) { return c.change < 0; }).length;
  const sortedChg = coins.map(function (c) { return c.change; }).sort(function (a, b) { return a - b; });
  const medChg = sortedChg.length ? sortedChg[Math.floor(sortedChg.length / 2)] : 0;
  wrap.innerHTML = "<div class=\"heatmap-wrap\">" + inner + "</div>" +
    "<div class=\"net-legend\"><span>样本：成交额前 " + coins.length + " 币</span>" +
    "<span>上涨 <strong style=\"color:var(--positive)\">" + up + "</strong> / 下跌 <strong style=\"color:var(--negative)\">" + down + "</strong></span>" +
    "<span>中位涨跌 <strong>" + (medChg >= 0 ? "+" : "") + medChg.toFixed(2) + "%</strong></span>" +
    "<span>合计成交额 " + (totalVol / 1e9).toFixed(1) + "B</span></div>";
}
// ---------- ② 联动数据：BTC + ETH + 成交额前 N 币的 1h K 线 → 相关矩阵 ----------
async function ensureLinkageData() {
  const TTL = 5 * 60 * 1000;
  if (linkageCache.ts && (Date.now() - linkageCache.ts) < TTL && linkageCache.coins.length >= 3) return linkageCache;
  const byVol = (allCoins || []).filter(function (c) { return c && c.symbol && c.volume > 0; })
    .sort(function (a, b) { return b.volume - a.volume; });
  const picks = [];
  ["BTCUSDT", "ETHUSDT"].forEach(function (s) {
    if (byVol.some(function (c) { return c.symbol === s; })) picks.push(s);
  });
  for (let i = 0; i < byVol.length && picks.length < 18; i++) {
    if (picks.indexOf(byVol[i].symbol) < 0) picks.push(byVol[i].symbol);
  }
  if (picks.length < 3) return linkageCache;
  const kl = await Promise.all(picks.map(function (s) {
    return window.binanceAPI.getKlines(s, "1h", 120).catch(function () { return null; });
  }));
  const coins = [], rets = {};
  for (let i = 0; i < picks.length; i++) {
    const arr = kl[i];
    if (!arr || arr.__error || !Array.isArray(arr) || arr.length < 40) continue;
    const closes = arr.map(function (k) { return parseFloat(k[4]); });
    coins.push({ symbol: picks[i], volume: ((byVol.find(function (c) { return c.symbol === picks[i]; })) || {}).volume || 0 });
    rets[picks[i]] = logReturns(closes);
  }
  const corr = {};
  for (let i = 0; i < coins.length; i++) {
    const a = coins[i].symbol;
    corr[a] = corr[a] || {};
    for (let j = i; j < coins.length; j++) {
      const b = coins[j].symbol;
      const c = (a === b) ? 1 : pearson(rets[a], rets[b]);
      corr[a][b] = c;
      corr[b] = corr[b] || {};
      corr[b][a] = c;
    }
  }
  linkageCache = { ts: Date.now(), coins: coins, rets: rets, corr: corr };
  return linkageCache;
}
// ---------- ② 联动网络：BTC 居中，连线粗细/深浅 = |相关系数| ----------
function renderNetwork() {
  const wrap = document.getElementById("networkWrap");
  if (!wrap) return;
  const d = linkageCache;
  if (!d || !d.coins || d.coins.length < 3) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">相关性数据不足（需要至少 3 个币的 1h K 线）</div>"; return; }
  const coins = d.coins;
  const btc = coins.find(function (c) { return c.symbol === "BTCUSDT"; }) || coins[0];
  const others = coins.filter(function (c) { return c.symbol !== btc.symbol; });
  const W = 760, H = 560, cx = W / 2, cy = H / 2, R = 200;
  const maxVol = Math.max.apply(null, coins.map(function (c) { return c.volume || 1; }));
  const rOf = function (c) { return 13 + 17 * Math.sqrt((c.volume || 1) / maxVol); };
  const pos = {};
  pos[btc.symbol] = { x: cx, y: cy, r: rOf(btc) + 9 };
  others.forEach(function (c, i) {
    const ang = (Math.PI * 2 * i) / others.length - Math.PI / 2;
    pos[c.symbol] = { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), r: rOf(c) };
  });
  let edges = "";
  others.forEach(function (c) {
    const v = (d.corr[btc.symbol] || {})[c.symbol] || 0;
    const abs = Math.abs(v);
    if (abs < 0.15) return;                    // 弱相关不画，避免糊成一团
    const p = pos[c.symbol];
    edges += "<line x1=\"" + cx + "\" y1=\"" + cy + "\" x2=\"" + p.x.toFixed(1) + "\" y2=\"" + p.y.toFixed(1) +
      "\" stroke=\"" + (v >= 0 ? "var(--accent-text)" : "var(--warning)") + "\" stroke-width=\"" + (0.6 + abs * 5).toFixed(2) +
      "\" opacity=\"" + (0.14 + abs * 0.5).toFixed(2) + "\"" + (v < 0 ? " stroke-dasharray=\"5 4\"" : "") + " />";
  });
  let nodes = "";
  coins.forEach(function (c) {
    const p = pos[c.symbol];
    const isBtc = c.symbol === btc.symbol;
    const cb = isBtc ? 1 : ((d.corr[btc.symbol] || {})[c.symbol] || 0);
    const stroke = isBtc ? "var(--accent-text)" : cb >= 0.6 ? "var(--accent-line)" : cb >= 0.3 ? "var(--border)" : "var(--warning)";
    nodes += "<g class=\"net-node\" onclick=\"openLinkedCoin('" + escapeJsAttr(c.symbol) + "')\">" +
      "<circle cx=\"" + p.x.toFixed(1) + "\" cy=\"" + p.y.toFixed(1) + "\" r=\"" + p.r.toFixed(1) + "\" fill=\"" + (isBtc ? "var(--accent-soft)" : "var(--bg-primary)") + "\" stroke=\"" + stroke + "\" stroke-width=\"2\" />" +
      "<text x=\"" + p.x.toFixed(1) + "\" y=\"" + (p.y + 3.5).toFixed(1) + "\" text-anchor=\"middle\" font-size=\"11\" font-weight=\"700\" fill=\"var(--text-primary)\" style=\"pointer-events:none\">" +
      escapeHtml(String(c.symbol).replace(/USDT$/, "")) + "</text></g>";
  });
  const pairs = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = i + 1; j < coins.length; j++) {
      pairs.push({ a: coins[i].symbol, b: coins[j].symbol, v: (d.corr[coins[i].symbol] || {})[coins[j].symbol] || 0 });
    }
  }
  pairs.sort(function (x, y) { return Math.abs(y.v) - Math.abs(x.v); });
  const topPairs = pairs.slice(0, 6).map(function (p) {
    return "<div class=\"chain-row\"><span class=\"chain-sym\" onclick=\"openLinkedCoin('" + escapeJsAttr(p.a) + "')\">" +
      escapeHtml(p.a.replace(/USDT$/, "")) + " ↔ " + escapeHtml(p.b.replace(/USDT$/, "")) + "</span>" +
      "<span class=\"chain-val " + (p.v >= 0 ? "up" : "down") + "\">" + p.v.toFixed(3) + "</span></div>";
  }).join("");
  const btcAvg = others.length ? others.reduce(function (a, c) { return a + ((d.corr[btc.symbol] || {})[c.symbol] || 0); }, 0) / others.length : 0;
  wrap.innerHTML = "<div class=\"net-wrap\"><svg class=\"net-svg\" viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"xMidYMid meet\">" + edges + nodes + "</svg>" +
    "<div class=\"net-legend\"><span>中心 = " + escapeHtml(btc.symbol.replace(/USDT$/, "")) + " · 节点大小 = 成交额</span>" +
    "<span>连线粗细/深浅 = |相关系数|（1h 对数收益 · 120 根）</span><span>实线 = 正相关，虚线 = 负相关</span>" +
    "<span>BTC 平均相关度 <strong>" + btcAvg.toFixed(3) + "</strong></span></div></div>" +
    "<div class=\"chain-card\" style=\"margin-top:var(--sp-3)\"><h4>相关性最强的币对（点币名跳转分析）</h4>" + topPairs +
    "<div class=\"vp-note\" style=\"margin-top:8px\">相关系数越接近 1，表示两者 1 小时级别走势越同步。高相关意味着分散风险的作用有限，也意味着可用一个币的走势去推断另一个。</div></div>";
}
// ---------- ③ 信号传导链：beta 补涨空间 + 领先/同步/滞后分层 ----------
function renderChain() {
  const wrap = document.getElementById("chainWrap");
  if (!wrap) return;
  const d = linkageCache;
  if (!d || !d.coins || d.coins.length < 3) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">数据不足，无法计算传导关系</div>"; return; }
  const btc = d.coins.find(function (c) { return c.symbol === "BTCUSDT"; }) || d.coins[0];
  const br = d.rets[btc.symbol] || [];
  const btcChg = coinChange(btc.symbol);
  const rows = [];
  d.coins.forEach(function (c) {
    if (c.symbol === btc.symbol) return;
    const ar = d.rets[c.symbol] || [];
    const n = Math.min(ar.length, br.length);
    if (n < 30) return;
    const A = ar.slice(ar.length - n), B = br.slice(br.length - n);
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += A[i]; mb += B[i]; }
    ma /= n; mb /= n;
    let cov = 0, vb = 0;
    for (let i = 0; i < n; i++) { cov += (A[i] - ma) * (B[i] - mb); vb += (B[i] - mb) * (B[i] - mb); }
    const beta = vb > 0 ? cov / vb : 0;
    const corrSync = pearson(A, B);
    const btcLeads = pearson(A.slice(1), B.slice(0, B.length - 1));   // BTC 今日 vs 该币昨日
    const coinLeads = pearson(B.slice(1), A.slice(0, A.length - 1));  // 该币今日 vs BTC 昨日
    const actual = coinChange(c.symbol);
    const expected = beta * btcChg;
    rows.push({
      symbol: c.symbol, beta: beta, corr: corrSync, btcLeads: btcLeads, coinLeads: coinLeads,
      actual: actual, expected: expected, gap: expected - actual
    });
  });
  if (!rows.length) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">数据不足，无法计算传导关系</div>"; return; }
  const lead = [], sync = [], lag = [];
  rows.forEach(function (r) {
    if (r.btcLeads > r.corr + 0.03 && r.btcLeads >= r.coinLeads) lag.push(r);       // BTC 领先 → 该币滞后
    else if (r.coinLeads > r.corr + 0.03 && r.coinLeads > r.btcLeads) lead.push(r);  // 该币领先
    else sync.push(r);
  });
  const listOf = function (arr, emptyTxt) {
    if (!arr.length) return "<div class=\"vp-note\">" + emptyTxt + "</div>";
    return arr.sort(function (a, b) { return b.corr - a.corr; }).map(function (r) {
      return "<div class=\"chain-row\"><span class=\"chain-sym\" onclick=\"openLinkedCoin('" + escapeJsAttr(r.symbol) + "')\">" +
        escapeHtml(r.symbol.replace(/USDT$/, "")) + "</span>" +
        "<span class=\"chain-val " + (r.actual >= 0 ? "up" : "down") + "\">" + (r.actual >= 0 ? "+" : "") + r.actual.toFixed(2) + "%</span></div>";
    }).join("");
  };
  const sortedGap = rows.slice().sort(function (a, b) { return b.gap - a.gap; });
  const maxAbs = Math.max.apply(null, sortedGap.map(function (r) { return Math.abs(r.gap); }).concat([0.01]));
  const gapRows = sortedGap.slice(0, 14).map(function (r) {
    const pos = r.gap >= 0;
    const w = Math.max(1, Math.round(Math.abs(r.gap) / maxAbs * 50));
    return "<div class=\"chain-row\"><span class=\"chain-sym\" onclick=\"openLinkedCoin('" + escapeJsAttr(r.symbol) + "')\">" +
      escapeHtml(r.symbol.replace(/USDT$/, "")) + "<em style=\"font-style:normal;color:var(--text-muted);font-size:var(--fs-xs)\"> β " + r.beta.toFixed(2) + "</em></span>" +
      "<span class=\"chain-val " + (pos ? "up" : "down") + "\">" + (pos ? "+" : "") + r.gap.toFixed(2) + "%</span>" +
      "<span class=\"chain-bar\"><i style=\"background:" + (pos ? "var(--positive)" : "var(--negative)") +
      ";left:" + (pos ? "50%" : (50 - w) + "%") + ";width:" + w + "%\"></i></span></div>";
  }).join("");
  wrap.innerHTML = "<div class=\"chain-grid\">" +
    "<div class=\"chain-card\"><h4>" + escapeHtml(btc.symbol.replace(/USDT$/, "")) + " 状态（传导源）</h4>" +
      "<div class=\"chain-row\"><span class=\"chain-sym\">24h 涨跌</span><span class=\"chain-val " + (btcChg >= 0 ? "up" : "down") + "\">" + (btcChg >= 0 ? "+" : "") + btcChg.toFixed(2) + "%</span></div>" +
      "<div class=\"chain-row\"><span class=\"chain-sym\">参与统计币数</span><span class=\"chain-val\">" + rows.length + "</span></div>" +
      "<div class=\"vp-note\" style=\"margin-top:8px\">以 BTC 作为传导源：先算每个币相对 BTC 的 β（波动放大倍数），再按「预期涨幅 = β × BTC 涨幅」与实际涨幅比较。</div></div>" +
    "<div class=\"chain-card\"><h4>领先于 BTC（" + lead.length + "）</h4>" + listOf(lead, "无（当前没有币明显领先 BTC）") +
      "<div class=\"vp-note\" style=\"margin-top:8px\">自身走势先于 BTC 变动，可作为 BTC 方向的早期参照。</div></div>" +
    "<div class=\"chain-card\"><h4>与 BTC 同步（" + sync.length + "）</h4>" + listOf(sync, "无") +
      "<div class=\"vp-note\" style=\"margin-top:8px\">与 BTC 同期共振，方向基本由大盘决定。</div></div>" +
    "<div class=\"chain-card\"><h4>滞后于 BTC（" + lag.length + "）</h4>" + listOf(lag, "无（当前没有币明显滞后）") +
      "<div class=\"vp-note\" style=\"margin-top:8px\">BTC 变动后 1 小时才反应，行情末段常由这类币补涨/补跌。</div></div>" +
    "</div>" +
    "<div class=\"chain-card\" style=\"margin-top:var(--sp-3)\"><h4>补涨 / 超涨空间（β 推算，前 14）</h4>" +
      "<div class=\"vp-note\" style=\"margin-bottom:8px\">正值 = 按 β 推算「还没涨够」，负值 = 「已经涨过头」。β 是 1 小时收益对 BTC 的敏感度，仅作横向比较参考。</div>" +
      gapRows + "</div>";
}
// ---------- ④ 结论互证：多周期 / 量价 / 结构 / 形态 四路并列 ----------
function renderCrossCheck(a, vs, ohlc) {
  const box = document.getElementById("xcheckWrap");
  if (!box) return;
  const V = function (v) { return v > 0 ? "buy" : v < 0 ? "sell" : "neutral"; };
  const L = function (v) { return v > 0 ? "看涨" : v < 0 ? "看跌" : "中性"; };
  const rows = [];
  // ① 多周期共振
  const tfs = (a && a.tfData) || [];
  let tfVote = 0, tfDetail = "无多周期数据";
  if (tfs.length) {
    let up = 0, dn = 0, neu = 0;
    const parts = [];
    tfs.forEach(function (t) {
      const s = (t.analysis && typeof t.analysis.score === "number") ? t.analysis.score : null;
      parts.push(String(t.interval).toUpperCase() + " " + (s === null ? "--" : s + "分"));
      if (s === null) return;
      if (s >= SIGNAL_LONG_MIN) up++; else if (s < SHORT_SCORE_MIN) dn++; else neu++;
    });
    tfVote = up > dn ? 1 : dn > up ? -1 : 0;
    tfDetail = parts.join(" · ") + "（" + up + " 涨 / " + neu + " 中性 / " + dn + " 跌）";
  }
  rows.push({ name: "多周期共振", detail: tfDetail, v: tfVote });
  // ② 量价结构
  const votes = vs ? computeVotes(a, vs) : null;
  let vpVote = 0, vpDetail = "量价数据不足";
  if (votes) {
    const raw = (votes.volume + votes.meanRevert) / 2;
    vpVote = raw > 0.25 ? 1 : raw < -0.25 ? -1 : 0;
    vpDetail = "OBV " + (votes.volume > 0 ? "看涨" : votes.volume < 0 ? "看跌" : "中性") +
      " · 均值回归维 " + (votes.meanRevert > 0 ? "看涨" : votes.meanRevert < 0 ? "看跌" : "中性") +
      (vs && vs.vwap ? " · 现价在 VWAP " + (vs.vwap.above ? "上方" : "下方") : "");
  }
  rows.push({ name: "量价结构", detail: vpDetail, v: vpVote });
  // ③ 支撑阻力（现价到最近支撑/阻力的空间对比）
  let srVote = 0, srDetail = "无支撑阻力数据";
  if (a && a.supports && a.resistances && a.price) {
    const sup = a.supports[0], res = a.resistances[0];
    const dSup = sup ? (a.price - sup.price) / a.price * 100 : null;
    const dRes = res ? (res.price - a.price) / a.price * 100 : null;
    if (dSup !== null && dRes !== null) {
      srVote = dRes > dSup * 1.4 ? 1 : dSup > dRes * 1.4 ? -1 : 0;
      srDetail = "距支撑 +" + dSup.toFixed(2) + "% · 距阻力 +" + dRes.toFixed(2) + "%（" + (dRes > dSup ? "上行空间更大" : "下行空间更大") + "）";
    }
  }
  rows.push({ name: "支撑阻力", detail: srDetail, v: srVote });
  // ④ 形态识别
  let ptVote = 0, ptDetail = "未识别到明确形态";
  if (a && a.signals) {
    const pats = a.signals.filter(function (s) {
      return /形态|双底|双顶|头肩|三角|楔形|杯柄|旗形|吞没|锤子|流星|吊颈|十字星|三阳|三阴|倒锤/.test(s.n || "");
    });
    const pb = pats.filter(function (s) { return s.t === "bull"; }).length;
    const ps = pats.filter(function (s) { return s.t === "bear"; }).length;
    if (pats.length) {
      ptVote = pb > ps ? 1 : ps > pb ? -1 : 0;
      ptDetail = pats.map(function (s) { return s.n; }).slice(0, 3).join(" · ") + "（多 " + pb + " / 空 " + ps + "）";
    }
  }
  rows.push({ name: "形态识别", detail: ptDetail, v: ptVote });
  // 汇总
  const bull = rows.filter(function (r) { return r.v > 0; }).length;
  const bear = rows.filter(function (r) { return r.v < 0; }).length;
  const neu = rows.length - bull - bear;
  let sum = "四路中性", cls = "neutral";
  if (bull >= 3 && bear === 0) { sum = "多路共振偏多（" + bull + "/4）"; cls = "buy"; }
  else if (bear >= 3 && bull === 0) { sum = "多路共振偏空（" + bear + "/4）"; cls = "sell"; }
  else if (bull > 0 && bear > 0) { sum = "路数分歧（" + bull + " 涨 / " + neu + " 中性 / " + bear + " 跌）"; cls = "neutral"; }
  else if (bull > 0) { sum = "偏多但未共振（" + bull + "/4）"; cls = "buy"; }
  else if (bear > 0) { sum = "偏空但未共振（" + bear + "/4）"; cls = "sell"; }
  box.innerHTML = "<div class=\"xcheck-sum\"><span class=\"t\">四路结论互证</span><span class=\"xcheck-verdict " + cls + "\">" + sum + "</span></div>" +
    rows.map(function (r) {
      return "<div class=\"xcheck-row\"><span class=\"xcheck-name\">" + r.name + "</span><span class=\"xcheck-detail\">" + escapeHtml(r.detail) + "</span>" +
        "<span class=\"xcheck-verdict " + V(r.v) + "\">" + L(r.v) + "</span></div>";
    }).join("") +
    "<div class=\"vp-note\" style=\"margin-top:10px\">「共振」= 多路独立方法给出一致方向，可信度更高；「分歧」= 方法之间互相矛盾，通常对应震荡或转折期，宜观望而非强行择向。四路各自独立计算，<strong>不参与主评分</strong>。</div>";
}
// ---------- 2026-10-09 第二步新增：衍生品资金面（纯只读展示，不参与主评分） ----------
// 数据来源：主进程 deriv:snapshot 一次取齐 5 组
//   premiumIndex                        标记价 / 指数价 / 资金费率 / 下次结算时间
//   openInterestHist                    持仓量（币数 + 名义价值 USD）
//   globalLongShortAccountRatio         全市场账户多空比
//   topLongShortPositionRatio           大户持仓多空比
//   takerlongshortRatio                 主动买入 / 主动卖出量比
// 设计原则与量价结构一致：**只做独立展示 + 人话解读，不改 analyzeCoin 的 score，不动任何阈值**。
// 它回答的是"这波涨跌背后是真买盘还是杠杆/空头挤压"，与价格类指标互补。
window.__derivCache = window.__derivCache || {};
const DERIV_TTL = 120000;
function derivNum(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }
function derivCol(arr, key) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) { const v = derivNum(x && x[key]); if (v !== null) out.push(v); }
  return out;
}
function derivLast(arr) { return arr.length ? arr[arr.length - 1] : null; }
// 取"24 个周期前"的值做变化率（数据不足时退化为首值）
function derivAgo(arr, back) { if (!arr.length) return null; return arr[Math.max(0, arr.length - 1 - back)]; }
function derivChg(arr, back) {
  // 语义：末值与「back 个周期前」的值比较。单元素时无变化可言，返回 null 而不是 0，
  // 否则界面上会把"没有历史数据"显示成"变化 0.00%"（看起来像真的没变）。
  if (!arr || arr.length < 2) return null;
  const last = derivLast(arr), old = derivAgo(arr, back);
  if (last === null || old === null || !old) return null;
  return (last / old - 1) * 100;
}
function derivFmtBig(v) {
  if (v === null) return "--";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(2);
}
// 迷你走势（纯 SVG，无依赖）；数值全相等时画一条水平线
function derivSpark(vals, color) {
  if (!vals || vals.length < 2) return "";
  const W = 120, H = 30, pad = 2;
  let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (hi === lo) { hi = lo + 1; lo = lo - 1; }
  const step = (W - pad * 2) / (vals.length - 1);
  const pts = vals.map(function (v, i) {
    const x = pad + i * step;
    const y = H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const lastV = vals[vals.length - 1];
  const lastY = (H - pad - ((lastV - lo) / (hi - lo)) * (H - pad * 2)).toFixed(1);
  return "<svg class=\"deriv-spark\" viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"none\">" +
    "<polyline points=\"" + pts + "\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"1.6\" stroke-linejoin=\"round\"/>" +
    "<circle cx=\"" + (W - pad).toFixed(1) + "\" cy=\"" + lastY + "\" r=\"2.2\" fill=\"" + color + "\"/></svg>";
}
function derivCountdown(ts) {
  const d = ts - Date.now();
  if (!isFinite(d)) return "--";
  if (d <= 0) return "已到结算点";
  const h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000);
  return h > 0 ? h + " 小时 " + m + " 分后" : m + " 分钟后";
}
// 把 5 组原始数据翻译成"人话"结论。返回 [{t: 文案, cls: buy/sell/neutral}]
function derivVerdict(d, ctx) {
  const out = [];
  const pr = (d.premium && !d.premium.__error) ? d.premium : null;
  const oi = derivCol(d.oi, "sumOpenInterestValue");
  const lsTop = derivCol(d.lsTop, "longShortRatio");
  const lsAcc = derivCol(d.lsAccount, "longShortRatio");
  const taker = derivCol(d.taker, "buySellRatio");
  // ① 资金费率：多头/空头谁在付费
  if (pr) {
    const rate = derivNum(pr.lastFundingRate);
    if (rate !== null) {
      const ann = rate * 3 * 365 * 100;               // 每 8h 一次 ⇒ 每天 3 次
      const p8 = rate * 100;
      if (ann >= 30) out.push({ t: "资金费率年化 +" + ann.toFixed(1) + "%（8h " + p8.toFixed(4) + "%），多头付费明显偏贵，多头拥挤，追多性价比差", cls: "sell" });
      else if (ann >= 8) out.push({ t: "资金费率年化 +" + ann.toFixed(1) + "%（8h " + p8.toFixed(4) + "%），多头情绪温和偏多", cls: "buy" });
      else if (ann <= -20) out.push({ t: "资金费率年化 " + ann.toFixed(1) + "%（8h " + p8.toFixed(4) + "%），空头付费且幅度不小，存在挤空风险", cls: "buy" });
      else if (ann <= -5) out.push({ t: "资金费率年化 " + ann.toFixed(1) + "%（8h " + p8.toFixed(4) + "%），空头情绪偏重", cls: "neutral" });
      else out.push({ t: "资金费率基本中性（年化 " + ann.toFixed(1) + "%），多空无一方明显付费", cls: "neutral" });
    }
  }
  // ② 持仓量变化 × 价格变化：增量资金还是平仓推动
  const oiChg = derivChg(oi, 24);
  if (oiChg !== null && ctx && isFinite(ctx.priceChg)) {
    const up = ctx.priceChg >= 0;
    if (oiChg >= 1 && up) out.push({ t: "持仓量 24h +" + oiChg.toFixed(1) + "% 且价格上涨，新资金进场做多，涨势有增量支撑", cls: "buy" });
    else if (oiChg >= 1 && !up) out.push({ t: "持仓量 24h +" + oiChg.toFixed(1) + "% 但价格下跌，空头在增仓，下行压力偏大", cls: "sell" });
    else if (oiChg <= -1 && up) out.push({ t: "持仓量 24h " + oiChg.toFixed(1) + "% 而价格上涨，更可能是空头平仓推动，缺新资金接力", cls: "neutral" });
    else if (oiChg <= -1 && !up) out.push({ t: "持仓量 24h " + oiChg.toFixed(1) + "% 且价格下跌，多头在减仓离场，跌势或趋缓", cls: "neutral" });
    else out.push({ t: "持仓量 24h 变化 " + oiChg.toFixed(1) + "%，仓位结构稳定", cls: "neutral" });
  }
  // ③ 大户持仓多空比
  const topNow = derivLast(lsTop);
  if (topNow !== null) {
    const accNow = derivLast(lsAcc);
    if (topNow >= 1.2) out.push({ t: "大户持仓多空比 " + topNow.toFixed(2) + "（大户偏多）" + (accNow !== null ? "，全市场账户比 " + accNow.toFixed(2) : ""), cls: "buy" });
    else if (topNow <= 0.85) out.push({ t: "大户持仓多空比 " + topNow.toFixed(2) + "（大户偏空）" + (accNow !== null ? "，全市场账户比 " + accNow.toFixed(2) : ""), cls: "sell" });
    else out.push({ t: "大户持仓多空比 " + topNow.toFixed(2) + "，多空接近均衡" + (accNow !== null ? "，全市场账户比 " + accNow.toFixed(2) : ""), cls: "neutral" });
  }
  // ④ 主动买卖量比
  const tkNow = derivLast(taker);
  if (tkNow !== null) {
    if (tkNow >= 1.05) out.push({ t: "主动买卖量比 " + tkNow.toFixed(3) + "，主动买盘占优（真金白银在买）", cls: "buy" });
    else if (tkNow <= 0.95) out.push({ t: "主动买卖量比 " + tkNow.toFixed(3) + "，主动卖盘占优", cls: "sell" });
    else out.push({ t: "主动买卖量比 " + tkNow.toFixed(3) + "，买卖力量相当", cls: "neutral" });
  }
  return out;
}
function paintDeriv(sym, d) {
  const wrap = document.getElementById("derivWrap");
  if (!wrap) return;
  const pr = (d.premium && !d.premium.__error) ? d.premium : null;
  const oi = derivCol(d.oi, "sumOpenInterestValue");
  const oiCoin = derivCol(d.oi, "sumOpenInterest");
  const lsTop = derivCol(d.lsTop, "longShortRatio");
  const lsAcc = derivCol(d.lsAccount, "longShortRatio");
  const taker = derivCol(d.taker, "buySellRatio");
  const UP = "var(--chart-up)", DOWN = "var(--chart-down)", NEU = "var(--text-muted)";

  // 价格 24h 变化（用 1h K 线，与持仓量同期，避免拿现货 24h 涨跌错配）
  const ctx = { priceChg: NaN };
  if (Array.isArray(d.__kl) && d.__kl.length >= 25) {
    const c0 = derivNum(d.__kl[d.__kl.length - 25][4]), c1 = derivNum(d.__kl[d.__kl.length - 1][4]);
    if (c0) ctx.priceChg = (c1 / c0 - 1) * 100;
  }

  const cards = [];
  // ① 资金费率
  if (pr) {
    const rate = derivNum(pr.lastFundingRate);
    const ann = rate === null ? null : rate * 3 * 365 * 100;
    const cls = ann === null ? "" : (ann >= 30 ? "down" : ann <= -5 ? "up" : "");
    cards.push("<div class=\"deriv-card\"><div class=\"deriv-label\">资金费率（每 8h）</div>" +
      "<div class=\"deriv-value " + cls + "\">" + (rate === null ? "--" : (rate * 100).toFixed(4) + "%") + "</div>" +
      "<div class=\"deriv-sub\">年化 " + (ann === null ? "--" : (ann >= 0 ? "+" : "") + ann.toFixed(1) + "%") + " · 下次结算 " + derivCountdown(pr.nextFundingTime) + "</div></div>");
    const mark = derivNum(pr.markPrice), idx = derivNum(pr.indexPrice);
    const basis = (mark && idx) ? (mark / idx - 1) * 100 : null;
    cards.push("<div class=\"deriv-card\"><div class=\"deriv-label\">标记价 / 基差</div>" +
      "<div class=\"deriv-value\">" + (mark === null ? "--" : formatPrice(mark)) + "</div>" +
      "<div class=\"deriv-sub\">指数 " + (idx === null ? "--" : formatPrice(idx)) + " · 基差 " + (basis === null ? "--" : (basis >= 0 ? "+" : "") + basis.toFixed(3) + "%") + "</div></div>");
  }
  // ② 持仓量
  const oiChg = derivChg(oi, 24);
  cards.push("<div class=\"deriv-card\"><div class=\"deriv-label\">持仓量（名义价值）</div>" +
    "<div class=\"deriv-value\">" + derivFmtBig(derivLast(oi)) + " <small>USD</small></div>" +
    "<div class=\"deriv-sub\">24h " + (oiChg === null ? "--" : (oiChg >= 0 ? "+" : "") + oiChg.toFixed(2) + "%") +
    (derivLast(oiCoin) !== null ? " · " + derivFmtBig(derivLast(oiCoin)) + " 币" : "") + "</div>" +
    (oi.length >= 2 ? derivSpark(oi, oiChg >= 0 ? UP : DOWN) : "") + "</div>");
  // ③ 大户持仓多空比
  const topNow = derivLast(lsTop), topChg = derivChg(lsTop, 24);
  cards.push("<div class=\"deriv-card\"><div class=\"deriv-label\">大户持仓多空比</div>" +
    "<div class=\"deriv-value " + (topNow === null ? "" : topNow >= 1.2 ? "up" : topNow <= 0.85 ? "down" : "") + "\">" + (topNow === null ? "--" : topNow.toFixed(3)) + "</div>" +
    "<div class=\"deriv-sub\">24h " + (topChg === null ? "--" : (topChg >= 0 ? "+" : "") + topChg.toFixed(2) + "%") +
    (derivLast(lsAcc) !== null ? " · 全市场账户比 " + derivLast(lsAcc).toFixed(3) : "") + "</div>" +
    (lsTop.length >= 2 ? derivSpark(lsTop, topNow >= 1 ? UP : DOWN) : "") + "</div>");
  // ④ 主动买卖量比
  const tkNow = derivLast(taker), tkChg = derivChg(taker, 24);
  cards.push("<div class=\"deriv-card\"><div class=\"deriv-label\">主动买卖量比</div>" +
    "<div class=\"deriv-value " + (tkNow === null ? "" : tkNow >= 1.05 ? "up" : tkNow <= 0.95 ? "down" : "") + "\">" + (tkNow === null ? "--" : tkNow.toFixed(3)) + "</div>" +
    "<div class=\"deriv-sub\">24h " + (tkChg === null ? "--" : (tkChg >= 0 ? "+" : "") + tkChg.toFixed(2) + "%") + " · &gt;1 为主动买占优</div>" +
    (taker.length >= 2 ? derivSpark(taker, tkNow >= 1 ? UP : DOWN) : "") + "</div>");

  const verdicts = derivVerdict(d, ctx);
  const vHtml = verdicts.length
    ? verdicts.map(function (v) {
        return "<div class=\"deriv-vrow\"><span class=\"deriv-dot " + v.cls + "\"></span><span>" + escapeHtml(v.t) + "</span></div>";
      }).join("")
    : "<div class=\"deriv-vrow\"><span class=\"deriv-dot neutral\"></span><span>资金面数据不足，无法给出解读</span></div>";
  const missing = [];
  if (!pr) missing.push("资金费率");
  if (!oi.length) missing.push("持仓量");
  if (!lsTop.length) missing.push("大户多空比");
  if (!taker.length) missing.push("主动买卖量");

  wrap.innerHTML = "<div class=\"deriv-head\"><span class=\"deriv-sym\">" + escapeHtml(splitSymbol(sym).base) + " 资金面</span>" +
    "<span class=\"deriv-meta\">周期 " + escapeHtml(d.period || "1h") + " · 更新 " + new Date(d.fetchedAt || Date.now()).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "</span></div>" +
    "<div class=\"deriv-grid\">" + cards.join("") + "</div>" +
    "<div class=\"deriv-verdict\"><div class=\"deriv-vtitle\">资金面解读</div>" + vHtml + "</div>" +
    (missing.length ? "<div class=\"deriv-warn\">未取到：" + escapeHtml(missing.join("、")) + "（该币可能无合约或数据接口限流）</div>" : "") +
    "<div class=\"vp-note\">资金费率看“谁在付钱”（正 = 多头付给空头），持仓量看“仓位是增是减”，主动买卖量比看“成交是买出来的还是卖出来的”。三项合起来能区分「真买盘推动」与「杠杆/空头挤压」，<strong>独立展示，不参与主评分</strong>。</div>" +
    // 2026-10-09 第十批：基差 / 多空比历史曲线 / 恐惧贪婪（异步补位，失败不影响上面已渲染的部分）
    "<div id=\"derivExtra\"></div>";
  try { paintDerivExtra(sym, d); } catch (e) { console.error("[app] deriv extra:", e); }
}
async function renderDerivatives(symbol, force) {
  const wrap = document.getElementById("derivWrap");
  if (!wrap) return;
  const sym = symbol || (typeof selectedCoin !== "undefined" ? selectedCoin : null);
  if (!sym) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">请先在左侧选择一个币种</div>"; return; }
  const cached = window.__derivCache[sym];
  if (!force && cached && Date.now() - cached.ts < DERIV_TTL) { paintDeriv(sym, cached.data); return; }
  if (!window.binanceAPI || !window.binanceAPI.derivSnapshot) {
    wrap.innerHTML = "<div class=\"ai-rr-placeholder\">当前运行环境不支持资金面数据（需通过 NovaTrade 主程序启动）</div>";
    return;
  }
  wrap.innerHTML = "<div class=\"ai-rr-placeholder\">正在获取资金面数据...</div>";
  let data = null;
  try { data = await window.binanceAPI.derivSnapshot(sym, "1h", 24); } catch (e) { data = null; }
  if (!data || data.__error) {
    wrap.innerHTML = "<div class=\"ai-rr-placeholder\">资金面数据暂不可用" + (data && data.__error ? "（" + escapeHtml(data.__error) + "）" : "") + "</div>";
    return;
  }
  // 顺带取同一周期的 1h K 线，用于"持仓量变化 × 价格变化"的组合判断
  try {
    const kl = await window.binanceAPI.getKlines(sym.endsWith("USDT") ? sym : sym + "USDT", "1h", 30);
    if (Array.isArray(kl) && !kl.__error) data.__kl = kl;
  } catch (e) {}
  window.__derivCache[sym] = { ts: Date.now(), data };
  paintDeriv(sym, data);
}
window.renderDerivatives = renderDerivatives;

// ---------- 2026-10-09 第三步新增：选币扫描器（多条件横截面筛选） ----------
// 定位：这是"分析软件"最该有的功能 —— 之前只能一个个点开看，现在能一次扫全市场。
// 复用现有 Indicators 与 fetchKlines，**只读筛选，不改任何阈值、不下单**。
// 性能：并发池 6 + 结果缓存 60s，避免把接口打爆。
const SCREENER_TTL = 60000;
window.__screenerRun = 0;          // 运行令牌：再次点击"开始扫描"会作废上一次的残留回调
window.__screenerResults = [];
window.__screenerSort = { key: "hit", dir: -1 };
window.__screenerCache = window.__screenerCache || {};

function screenerFormHtml() {
  const opt = (v, t) => `<option value="${v}">${t}</option>`;
  const sel = (id, opts, cur) => `<select id="${id}" class="sc-input">` + opts.map(o => `<option value="${o[0]}"${o[0] === cur ? " selected" : ""}>${o[1]}</option>`).join("") + `</select>`;
  const num = (id, ph) => `<input type="number" id="${id}" class="sc-input" placeholder="${ph}" step="any">`;
  return `
    <div class="sc-row">
      <label class="sc-field"><span>K 线周期</span>${sel("sc_tf", [["15m", "15 分钟"], ["1h", "1 小时"], ["4h", "4 小时"]], "1h")}</label>
      <label class="sc-field"><span>扫描数量（按成交额前 N）</span>${sel("sc_n", [["30", "30 个"], ["60", "60 个"], ["100", "100 个"]], "60")}</label>
      <label class="sc-field"><span>RSI(14) 下限</span>${num("sc_rsiMin", "如 30")}</label>
      <label class="sc-field"><span>RSI(14) 上限</span>${num("sc_rsiMax", "如 70")}</label>
    </div>
    <div class="sc-row">
      <label class="sc-field"><span>量比 ≥</span>${num("sc_volRatio", "如 1.5")}</label>
      <label class="sc-field"><span>24h 涨跌 ≥ %</span>${num("sc_chgMin", "如 -5")}</label>
      <label class="sc-field"><span>24h 涨跌 ≤ %</span>${num("sc_chgMax", "如 20")}</label>
      <label class="sc-field"><span>均线形态</span>${sel("sc_ma", [["any", "不限"], ["above20", "站上 MA20"], ["below20", "跌破 MA20"], ["bull", "MA20 > MA50（多头排列）"], ["bear", "MA20 < MA50（空头排列）"]], "any")}</label>
    </div>
    <div class="sc-row">
      <label class="sc-field"><span>MACD</span>${sel("sc_macd", [["any", "不限"], ["golden", "刚金叉（柱由负转正）"], ["dead", "刚死叉（柱由正转负）"], ["pos", "柱为正"], ["neg", "柱为负"]], "any")}</label>
      <label class="sc-field"><span>KDJ</span>${sel("sc_kdj", [["any", "不限"], ["golden", "金叉"], ["dead", "死叉"], ["oversold", "超卖（J &lt; 0）"], ["overbought", "超买（J &gt; 100）"]], "any")}</label>
      <label class="sc-field"><span>布林 %B 下限</span>${num("sc_bbMin", "如 0.2")}</label>
      <label class="sc-field"><span>布林 %B 上限</span>${num("sc_bbMax", "如 0.8")}</label>
    </div>
    <div class="sc-row">
      <label class="sc-field"><span>距近 24 根高点回撤 ≤ %</span>${num("sc_ddMax", "如 5（只看接近高点的）")}</label>
      <label class="sc-field"><span>24h 成交额 ≥</span>${sel("sc_minVol", [["0", "不限"], ["1000000", "100 万 U"], ["5000000", "500 万 U"], ["20000000", "2000 万 U"], ["100000000", "1 亿 U"]], "0")}</label>
      <label class="sc-check"><input type="checkbox" id="sc_futures"> 仅看有合约的币</label>
      <label class="sc-check"><input type="checkbox" id="sc_watch"> 仅看自选</label>
    </div>`;
}
function initScreenerForm() {
  const box = document.getElementById("screenerForm");
  if (box && !box.dataset.ready) { box.innerHTML = screenerFormHtml(); box.dataset.ready = "1"; }
}
function scVal(id) { const el = document.getElementById(id); return el ? el.value : ""; }
function scNum(id) { const v = parseFloat(scVal(id)); return isFinite(v) ? v : null; }
function readScreenerForm() {
  return {
    tf: scVal("sc_tf") || "1h",
    n: parseInt(scVal("sc_n"), 10) || 60,
    rsiMin: scNum("sc_rsiMin"), rsiMax: scNum("sc_rsiMax"),
    volRatioMin: scNum("sc_volRatio"),
    chgMin: scNum("sc_chgMin"), chgMax: scNum("sc_chgMax"),
    ma: scVal("sc_ma") || "any",
    macd: scVal("sc_macd") || "any",
    kdj: scVal("sc_kdj") || "any",
    bbMin: scNum("sc_bbMin"), bbMax: scNum("sc_bbMax"),
    ddMax: scNum("sc_ddMax"),
    minVol: parseFloat(scVal("sc_minVol")) || 0,
    futuresOnly: !!(document.getElementById("sc_futures") && document.getElementById("sc_futures").checked),
    watchOnly: !!(document.getElementById("sc_watch") && document.getElementById("sc_watch").checked),
  };
}
// 指标计算：一次算齐，供条件判断与结果表共用（结果表要显示原始读数，便于人工复核）
function screenerIndicators(closes, ohlc, coin) {
  if (!closes || closes.length < 60 || !ohlc || ohlc.length < 60) return null;
  const price = closes[closes.length - 1];
  const rsi = Indicators.RSI(closes, 14);
  const macdNow = Indicators.MACDHist(closes);
  const macdPrev = Indicators.MACDHist(closes.slice(0, -1));
  const kd = Indicators.KDJ(ohlc, 9);
  const kdPrev = Indicators.KDJ(ohlc.slice(0, -1), 9);
  const bb = Indicators.BB(closes, 20, 2);
  const ma20 = Indicators.SMA(closes, 20);
  const ma50 = Indicators.SMA(closes, 50);
  const vols = ohlc.map(k => k[5] || 0);
  const lastVol = vols[vols.length - 1];
  const lookback = Math.min(20, vols.length - 1);
  let avgVol = 0;
  for (let i = vols.length - 1 - lookback; i < vols.length - 1; i++) avgVol += vols[i];
  avgVol = lookback > 0 ? avgVol / lookback : 0;
  const volRatio = avgVol > 0 ? lastVol / avgVol : null;
  const win = ohlc.slice(-24);
  let hi = -Infinity, lo = Infinity;
  for (const k of win) { if (k[2] > hi) hi = k[2]; if (k[3] < lo) lo = k[3]; }
  const dd = hi > 0 && isFinite(hi) ? (price / hi - 1) * 100 : null;   // 距高点的回撤（负数）
  const macdCross = (macdPrev === null || macdNow === null) ? null : (macdPrev <= 0 && macdNow > 0 ? "golden" : macdPrev >= 0 && macdNow < 0 ? "dead" : null);
  const kdjCross = (!kdPrev || !kd) ? null : (kdPrev.k <= kdPrev.d && kd.k > kd.d ? "golden" : kdPrev.k >= kdPrev.d && kd.k < kd.d ? "dead" : null);
  const tfChg = closes[0] > 0 ? (price / closes[0] - 1) * 100 : null;
  return { price, rsi, macdNow, macdCross, kd, kdjCross, bb, ma20, ma50, volRatio, hi, lo, dd, tfChg };
}
// 条件求值：全部满足才 pass；reasons/miss 用于结果表说明"为什么命中/差在哪"
function screenerEval(ind, coin, cfg) {
  const reasons = [], miss = [];
  let pass = true;
  const chk = (ok, label) => { if (ok) reasons.push(label); else { miss.push(label); pass = false; } };
  if (cfg.rsiMin !== null) chk(ind.rsi !== null && ind.rsi >= cfg.rsiMin, "RSI≥" + cfg.rsiMin);
  if (cfg.rsiMax !== null) chk(ind.rsi !== null && ind.rsi <= cfg.rsiMax, "RSI≤" + cfg.rsiMax);
  if (cfg.volRatioMin !== null) chk(ind.volRatio !== null && ind.volRatio >= cfg.volRatioMin, "量比≥" + cfg.volRatioMin);
  if (cfg.chgMin !== null) chk(isFinite(coin.change) && coin.change >= cfg.chgMin, "24h涨跌≥" + cfg.chgMin + "%");
  if (cfg.chgMax !== null) chk(isFinite(coin.change) && coin.change <= cfg.chgMax, "24h涨跌≤" + cfg.chgMax + "%");
  if (cfg.ma === "above20") chk(ind.ma20 !== null && ind.price > ind.ma20, "站上MA20");
  else if (cfg.ma === "below20") chk(ind.ma20 !== null && ind.price < ind.ma20, "跌破MA20");
  else if (cfg.ma === "bull") chk(ind.ma20 !== null && ind.ma50 !== null && ind.ma20 > ind.ma50, "MA20>MA50");
  else if (cfg.ma === "bear") chk(ind.ma20 !== null && ind.ma50 !== null && ind.ma20 < ind.ma50, "MA20<MA50");
  if (cfg.macd === "golden") chk(ind.macdCross === "golden", "MACD刚金叉");
  else if (cfg.macd === "dead") chk(ind.macdCross === "dead", "MACD刚死叉");
  else if (cfg.macd === "pos") chk(ind.macdNow !== null && ind.macdNow > 0, "MACD柱为正");
  else if (cfg.macd === "neg") chk(ind.macdNow !== null && ind.macdNow < 0, "MACD柱为负");
  if (cfg.kdj === "golden") chk(ind.kdjCross === "golden", "KDJ金叉");
  else if (cfg.kdj === "dead") chk(ind.kdjCross === "dead", "KDJ死叉");
  else if (cfg.kdj === "oversold") chk(ind.kd !== null && ind.kd.j < 0, "KDJ超卖(J<0)");
  else if (cfg.kdj === "overbought") chk(ind.kd !== null && ind.kd.j > 100, "KDJ超买(J>100)");
  if (cfg.bbMin !== null) chk(ind.bb !== null && ind.bb.pctB >= cfg.bbMin, "%B≥" + cfg.bbMin);
  if (cfg.bbMax !== null) chk(ind.bb !== null && ind.bb.pctB <= cfg.bbMax, "%B≤" + cfg.bbMax);
  if (cfg.ddMax !== null) chk(ind.dd !== null && ind.dd >= -Math.abs(cfg.ddMax), "距高点回撤≤" + Math.abs(cfg.ddMax) + "%");
  return { pass, reasons, miss };
}
// 并发池：避免同时打几百个请求把接口打爆
async function screenerPool(items, limit, worker, onTick) {
  let idx = 0, done = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      for (;;) {
        const my = idx++;
        if (my >= items.length) return;
        try { await worker(items[my]); } catch (e) {}
        done++;
        if (onTick) onTick(done, items.length);
      }
    })());
  }
  await Promise.all(runners);
}
function screenerStatusHtml(done, total, note) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `<div class="sc-progress"><div class="sc-progress-bar" style="width:${pct}%"></div></div>` +
    `<div class="sc-progress-text">${escapeHtml(note || "")}　已扫描 ${done}/${total}（${pct}%）</div>`;
}
async function runScreener() {
  initScreenerForm();
  const st = document.getElementById("screenerStatus");
  const box = document.getElementById("screenerResults");
  const btn = document.getElementById("screenerRunBtn");
  if (!st || !box) return;
  if (!allCoins || allCoins.length === 0) { st.innerHTML = `<div class="sc-progress-text">行情尚未加载完成，请稍后再试</div>`; return; }
  const cfg = readScreenerForm();
  const token = ++window.__screenerRun;
  if (btn) { btn.disabled = true; btn.textContent = "扫描中..."; }
  // 选池：按 24h 成交额降序取前 N
  let pool = [...allCoins];
  if (cfg.minVol > 0) pool = pool.filter(c => (c.volume || 0) >= cfg.minVol);
  if (cfg.futuresOnly) pool = pool.filter(c => c.hasFutures);
  if (cfg.watchOnly) pool = pool.filter(c => isWatched(c.symbol));
  pool.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  pool = pool.slice(0, cfg.n);
  if (pool.length === 0) {
    st.innerHTML = `<div class="sc-progress-text">没有符合条件的候选池（检查"仅看有合约的币"/"仅看自选"/成交额下限）</div>`;
    if (btn) { btn.disabled = false; btn.textContent = "开始扫描"; }
    return;
  }
  const hits = [];
  let errors = 0;
  st.innerHTML = screenerStatusHtml(0, pool.length, "正在扫描...");
  await screenerPool(pool, 6, async (co) => {
    if (token !== window.__screenerRun) return;       // 已被新的一轮作废
    const sym = co.symbol;
    let kl = null;
    const cached = window.__screenerCache[sym + "|" + cfg.tf];
    if (cached && Date.now() - cached.ts < SCREENER_TTL) kl = cached.kl;
    else {
      const r = await fetchKlines(sym, cfg.tf, 150, { closedOnly: true });   // 筛选信号只看已收盘 K 线
      kl = r.ohlc;
      if (kl && kl.length) window.__screenerCache[sym + "|" + cfg.tf] = { ts: Date.now(), kl };
    }
    if (!kl || !kl.length) { errors++; return; }
    const closes = kl.map(k => k[4]);
    const ind = screenerIndicators(closes, kl, co);
    if (!ind) { errors++; return; }
    const ev = screenerEval(ind, co, cfg);
    if (ev.pass) hits.push({ symbol: sym, coin: co, ind, reasons: ev.reasons, hitCount: ev.reasons.length });
  }, (done, total) => {
    if (token !== window.__screenerRun) return;
    const el = document.getElementById("screenerStatus");
    if (el) el.innerHTML = screenerStatusHtml(done, total, "正在扫描...");
  });
  if (token !== window.__screenerRun) return;          // 本轮已作废，不覆盖新一轮的结果
  window.__screenerResults = hits;
  window.__screenerCfg = cfg;
  const activeConds = countActiveConds(cfg);
  st.innerHTML = `<div class="sc-progress-text">扫描完成：候选 ${pool.length} 个，命中 <b>${hits.length}</b> 个` +
    (errors ? `，${errors} 个数据不足` : "") + `　条件数 ${activeConds}　周期 ${escapeHtml(cfg.tf)}</div>`;
  if (btn) { btn.disabled = false; btn.textContent = "重新扫描"; }
  renderScreenerResults();
}
function countActiveConds(cfg) {
  let n = 0;
  ["rsiMin", "rsiMax", "volRatioMin", "chgMin", "chgMax", "bbMin", "bbMax", "ddMax"].forEach(k => { if (cfg[k] !== null) n++; });
  if (cfg.ma !== "any") n++;
  if (cfg.macd !== "any") n++;
  if (cfg.kdj !== "any") n++;
  return n;
}
function screenerRowHtml(r) {
  const ind = r.ind, co = r.coin;
  const up = (co.change || 0) >= 0;
  const macdTxt = ind.macdCross === "golden" ? "<em class=\"sc-tag up\">金叉</em>" : ind.macdCross === "dead" ? "<em class=\"sc-tag down\">死叉</em>" : (ind.macdNow > 0 ? "多头" : "空头");
  const kdjTxt = (ind.kd ? ind.kd.j.toFixed(0) : "--") + (ind.kdjCross === "golden" ? " <em class=\"sc-tag up\">金叉</em>" : ind.kdjCross === "dead" ? " <em class=\"sc-tag down\">死叉</em>" : "");
  return `<div class="sc-tr" onclick="openLinkedCoin('${escapeJsAttr(r.symbol)}')" title="${escapeHtml(r.reasons.join(" 且 "))}">
    <span class="sc-td sym">${escapeHtml(splitSymbol(r.symbol).base)}</span>
    <span class="sc-td">${formatPrice(ind.price)}</span>
    <span class="sc-td ${ind.tfChg >= 0 ? "up" : "down"}">${ind.tfChg >= 0 ? "+" : ""}${ind.tfChg.toFixed(2)}%</span>
    <span class="sc-td ${up ? "up" : "down"}">${up ? "+" : ""}${(co.change || 0).toFixed(2)}%</span>
    <span class="sc-td">${ind.rsi === null ? "--" : ind.rsi.toFixed(1)}</span>
    <span class="sc-td">${ind.volRatio === null ? "--" : ind.volRatio.toFixed(2)}</span>
    <span class="sc-td">${macdTxt}</span>
    <span class="sc-td">${kdjTxt}</span>
    <span class="sc-td">${ind.bb === null ? "--" : ind.bb.pctB.toFixed(2)}</span>
    <span class="sc-td">${ind.dd === null ? "--" : ind.dd.toFixed(1) + "%"}</span>
    <span class="sc-td">${ind.ma20 !== null && ind.price > ind.ma20 ? "上" : "下"}</span>
    <span class="sc-td sc-why">${escapeHtml(r.reasons.join("、"))}</span>
  </div>`;
}
const SCREENER_COLS = [
  ["sym", "币种"], ["price", "价格"], ["tfChg", "本周期"], ["change", "24h"],
  ["rsi", "RSI"], ["volRatio", "量比"], ["macd", "MACD"], ["kdj", "KDJ(J)"],
  ["bb", "%B"], ["dd", "距高点"], ["ma", "MA20"], ["why", "命中条件"]
];
function renderScreenerResults() {
  const box = document.getElementById("screenerResults");
  if (!box) return;
  const list = window.__screenerResults || [];
  if (list.length === 0) {
    box.innerHTML = `<div class="linked-empty">没有命中的币种。条件放宽一点再试，或先点「开始扫描」。</div>`;
    return;
  }
  const s = window.__screenerSort;
  const val = (r) => {
    const i = r.ind;
    switch (s.key) {
      case "sym": return r.symbol;
      case "price": return i.price;
      case "tfChg": return i.tfChg;
      case "change": return r.coin.change;
      case "rsi": return i.rsi === null ? -999 : i.rsi;
      case "volRatio": return i.volRatio === null ? -999 : i.volRatio;
      case "macd": return i.macdNow === null ? -999 : i.macdNow;
      case "kdj": return i.kd ? i.kd.j : -999;
      case "bb": return i.bb ? i.bb.pctB : -999;
      case "dd": return i.dd === null ? -999 : i.dd;
      case "ma": return i.ma20 !== null && i.price > i.ma20 ? 1 : 0;
      case "why": return r.hitCount;
      default: return r.hitCount;
    }
  };
  const sorted = [...list].sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === "string") return va.localeCompare(vb) * s.dir;
    return (va - vb) * s.dir;
  });
  const head = SCREENER_COLS.map(c =>
    `<span class="sc-th${s.key === c[0] ? " active" : ""}" onclick="sortScreener('${c[0]}')">${c[1]}${s.key === c[0] ? (s.dir > 0 ? " ▲" : " ▼") : ""}</span>`
  ).join("");
  box.innerHTML = `<div class="sc-table"><div class="sc-tr head">${head}</div>` + sorted.slice(0, 200).map(screenerRowHtml).join("") + `</div>` +
    (sorted.length > 200 ? `<div class="vp-note">命中 ${sorted.length} 个，仅显示前 200 个</div>` : "");
}
function sortScreener(key) {
  const s = window.__screenerSort;
  if (s.key === key) s.dir = -s.dir; else { s.key = key; s.dir = key === "sym" ? 1 : -1; }
  renderScreenerResults();
}
window.sortScreener = sortScreener;
function resetScreener() {
  const box = document.getElementById("screenerForm");
  if (box) { box.dataset.ready = ""; box.innerHTML = screenerFormHtml(); box.dataset.ready = "1"; }
  window.__screenerResults = [];
  const st = document.getElementById("screenerStatus"); if (st) st.innerHTML = "";
  const rs = document.getElementById("screenerResults");
  if (rs) rs.innerHTML = `<div class="linked-empty">条件已重置，点「开始扫描」运行。</div>`;
}
window.resetScreener = resetScreener;
// 通用文本导出：优先走主进程保存对话框，浏览器环境下退化为 Blob 下载
async function downloadText(filename, text, mime) {
  if (window.electronAPI && window.electronAPI.exportCsv) {
    const r = await window.electronAPI.exportCsv(filename, text);
    if (r && r.ok) { linkedToast("已导出到 " + r.path); return true; }
    if (r && r.canceled) return false;
    linkedToast("导出失败：" + ((r && r.error) || "未知错误"));
    return false;
  }
  try {
    const blob = new Blob(["\ufeff" + text], { type: mime || "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    linkedToast("已下载 " + filename);
    return true;
  } catch (e) { linkedToast("导出失败：" + e.message); return false; }
}
function csvCell(v) { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function toCsv(headers, rows) { return [headers.map(csvCell).join(",")].concat(rows.map(r => r.map(csvCell).join(","))).join("\r\n"); }
async function exportScreenerCsv() {
  const list = window.__screenerResults || [];
  if (!list.length) { linkedToast("还没有扫描结果可导出"); return; }
  const cfg = window.__screenerCfg || {};
  const rows = list.map(r => [
    r.symbol, r.ind.price, r.ind.tfChg === null ? "" : r.ind.tfChg.toFixed(3),
    (r.coin.change || 0).toFixed(3), r.ind.rsi === null ? "" : r.ind.rsi.toFixed(2),
    r.ind.volRatio === null ? "" : r.ind.volRatio.toFixed(3),
    r.ind.macdNow === null ? "" : r.ind.macdNow.toFixed(4), r.ind.macdCross || "",
    r.ind.kd ? r.ind.kd.k.toFixed(2) : "", r.ind.kd ? r.ind.kd.d.toFixed(2) : "", r.ind.kd ? r.ind.kd.j.toFixed(2) : "",
    r.ind.kdjCross || "", r.ind.bb ? r.ind.bb.pctB.toFixed(3) : "", r.ind.dd === null ? "" : r.ind.dd.toFixed(2),
    r.coin.volume || 0, r.reasons.join(" 且 ")
  ]);
  const csv = toCsv(["币种", "价格", "本周期涨跌%", "24h涨跌%", "RSI14", "量比", "MACD柱", "MACD交叉", "K", "D", "J", "KDJ交叉", "布林%B", "距高点回撤%", "24h成交额", "命中条件"], rows);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  await downloadText(`选币扫描_${cfg.tf || "1h"}_${stamp}.csv`, csv);
}
window.exportScreenerCsv = exportScreenerCsv;
window.runScreener = runScreener;
window.initScreenerForm = initScreenerForm;

// ---------- 2026-10-09 第五步新增：信号历史台账 ----------
// 前向验证此前只有汇总统计（命中率/样本数），看不到"具体哪一条后来怎么样了"。
// 数据本来就都在 forward_validation.json 里，这里只是把它逐条摊开展示 + 可导出。
window.__ledgerFilter = window.__ledgerFilter || "all";
const LEDGER_FILTERS = [
  ["all", "全部"], ["long", "仅多头"], ["short", "仅空头"],
  ["settled", "已结算(4h)"], ["pending", "待结算"], ["filtered", "被门控拦下的"]
];
function ledgerFiltersHtml() {
  const f = window.__ledgerFilter;
  return "<div class=\"ledger-filters\">" + LEDGER_FILTERS.map(function (x) {
    return "<button class=\"filter-btn" + (f === x[0] ? " active" : "") + "\" data-ledger=\"" + x[0] + "\" onclick=\"setLedgerFilter('" + x[0] + "')\">" + x[1] + "</button>";
  }).join("") + "</div>";
}
function ledgerRows() {
  const f = window.__ledgerFilter;
  let rs = (fwdRecords || []).slice();
  if (f === "long") rs = rs.filter(r => r.dir === "long");
  else if (f === "short") rs = rs.filter(r => r.dir === "short");
  else if (f === "settled") rs = rs.filter(r => r.r4h);
  else if (f === "pending") rs = rs.filter(r => !r.r4h && !r.expired);
  else if (f === "filtered") rs = rs.filter(r => r.gated === false);
  rs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rs;
}
function ledgerCell(res, dir, expired) {
  if (!res) return "<span class=\"muted\">" + (expired ? "无数据" : "待结算") + "</span>";
  // 方向命中 = 多单涨 / 空单跌；收益按方向折算，避免"跌了但空单赚"被显示成亏损
  const signed = res.pct * (dir === "long" ? 1 : -1);
  const cls = res.hit ? "up" : "down";
  return "<span class=\"" + cls + "\">" + (res.hit ? "命中" : "未中") + " " + (signed >= 0 ? "+" : "") + signed.toFixed(2) + "%</span>";
}
function renderFwdLedger() {
  const box = document.getElementById("fwdLedger");
  if (!box) return;
  if (!fwdLoaded) { box.innerHTML = "<div class=\"linked-empty\">台账加载中...</div>"; return; }
  const all = fwdRecords || [];
  const rs = ledgerRows();
  const settled = all.filter(r => r.r4h).length;
  const expiredN = all.filter(r => r.expired && !r.r4h).length;
  const head = ledgerFiltersHtml() +
    "<div class=\"vp-note\" style=\"margin-bottom:10px\">共 " + all.length + " 条信号（已结算 " + settled + "，待结算 " + (all.length - settled - expiredN) + (expiredN ? "，无数据 " + expiredN : "") + "）；" +
    "「被门控拦下的」= 记录了但当时风控门控没放行，用来对比“记了但没做”的口径质量。点任意一行可回到该币技术分析。</div>";
  if (rs.length === 0) { box.innerHTML = head + "<div class=\"linked-empty\">该筛选下暂无记录。</div>"; return; }
  const rows = rs.slice(0, 300).map(function (r) {
    const t = new Date(r.ts || Date.now()).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const isLong = r.dir === "long";
    const gate = r.gated === false ? "<em class=\"sc-tag down\">已拦截</em>" : "<em class=\"sc-tag up\">放行</em>";
    return "<div class=\"ledger-tr clickable\" onclick=\"openLinkedCoin('" + escapeJsAttr(r.symbol) + "')\">" +
      "<span class=\"ledger-td\">" + t + "</span>" +
      "<span class=\"ledger-td sym\">" + escapeHtml(splitSymbol(r.symbol).base) + "</span>" +
      "<span class=\"ledger-td\">" + (isLong ? "多" : "空") + "</span>" +
      "<span class=\"ledger-td\">" + (r.score === undefined || r.score === null ? "--" : r.score) + "</span>" +
      "<span class=\"ledger-td\">" + formatPrice(r.price) + "</span>" +
      "<span class=\"ledger-td\">" + ledgerCell(r.r1h, r.dir, r.expired) + "</span>" +
      "<span class=\"ledger-td\">" + ledgerCell(r.r4h, r.dir, r.expired) + "</span>" +
      "<span class=\"ledger-td\">" + gate + "</span>" +
      "</div>";
  }).join("");
  box.innerHTML = head + "<div class=\"ledger-table\"><div class=\"ledger-tr head\">" +
    "<span>时间</span><span>币种</span><span>方向</span><span>评分</span><span>入场价</span><span>1h 结果</span><span>4h 结果</span><span>门控</span>" +
    "</div>" + rows + "</div>" +
    (rs.length > 300 ? "<div class=\"vp-note\">共 " + rs.length + " 条，仅显示最近 300 条（导出 CSV 可取全量）</div>" : "");
}
function setLedgerFilter(f) {
  window.__ledgerFilter = f;
  renderFwdLedger();
}
window.setLedgerFilter = setLedgerFilter;
window.renderFwdLedger = renderFwdLedger;
async function exportLedgerCsv() {
  if (!fwdLoaded) { linkedToast("台账尚未加载完成"); return; }
  const rs = ledgerRows();
  if (!rs.length) { linkedToast("当前筛选下没有记录可导出"); return; }
  const rows = rs.map(function (r) {
    const s = (res) => res ? (res.pct * (r.dir === "long" ? 1 : -1)).toFixed(3) : "";
    return [new Date(r.ts || 0).toISOString(), r.symbol, r.dir === "long" ? "多" : "空", r.score, r.price,
      r.r1h ? (r.r1h.hit ? "命中" : "未中") : (r.expired ? "无数据" : "待结算"), s(r.r1h),
      r.r4h ? (r.r4h.hit ? "命中" : "未中") : (r.expired ? "无数据" : "待结算"), s(r.r4h),
      r.gated === false ? "已拦截" : "放行"];
  });
  const csv = toCsv(["时间", "币种", "方向", "评分", "入场价", "1h判定", "1h方向收益%", "4h判定", "4h方向收益%", "门控"], rows);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  await downloadText(`信号台账_${window.__ledgerFilter}_${stamp}.csv`, csv);
}
window.exportLedgerCsv = exportLedgerCsv;

// ---------- 2026-10-09 第七步新增：推荐列表 CSV + 图表 PNG 导出 ----------
// 推荐列表 CSV：数据取自 renderRecommendations 里 progressiveRender 写下的 window.__recGroups 快照
// （直接复用内存对象，不从 DOM 反解 —— DOM 卡片只带部分字段，反解会丢信号明细与风险参数）。
async function exportRecommendCsv() {
  const g = window.__recGroups;
  const list = g ? (g.buy || []).concat(g.sell || []) : [];
  if (!list.length) { linkedToast("还没有推荐结果可导出，先点「刷新推荐」"); return; }
  const quality = g.quality;
  const rows = list.map(function (c) {
    const rr = c.riskReward || {};
    const isBuy = c.score >= SIGNAL_LONG_MIN;
    const lowConf = c.confidence < MIN_ACTION_CONFIDENCE;
    const gateBlocked = isVetoed(c);
    const perfBlocked = !quality || !quality.actionable;
    const blocked = lowConf || gateBlocked || perfBlocked;
    const bull = (c.signals || []).filter(s => s.t === "bull").slice(0, 3).map(s => s.n).join("、");
    const bear = (c.signals || []).filter(s => s.t === "bear").slice(0, 3).map(s => s.n).join("、");
    return [
      c.symbol, isBuy ? "多" : "空", c.score, c.confidence + "%", c.baseTf || "4h",
      c.price, Number(c.change || 0).toFixed(3),
      rr.entry != null ? rr.entry : "", rr.stopLoss != null ? rr.stopLoss : "",
      rr.tps && rr.tps[0] ? rr.tps[0].price : "", rr.rr || "",
      c.bullish || 0, c.bearish || 0,
      blocked ? "暂不交易" : (isBuy ? "关注做多" : "关注做空"),
      blocked ? [lowConf ? "置信度不足" : "", gateBlocked ? "风险门控" : "", perfBlocked ? (quality ? quality.label : "前向验证未达标") : ""].filter(Boolean).join("；") : "",
      bull, bear
    ];
  });
  const csv = toCsv(["币种", "方向", "评分", "置信度", "基准周期", "现价", "24h涨跌%", "入场", "止损", "TP1", "盈亏比", "看涨证据数", "看跌证据数", "建议", "拦截原因", "看涨明细", "看跌明细"], rows);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  await downloadText(`AI推荐_${stamp}.csv`, csv);
}
window.exportRecommendCsv = exportRecommendCsv;

// 图表 PNG：把「当前实际存在的」图表竖排合成一张。
// 注意（2026-10-09 实测）：本版 DOM 里只保留了主图容器 #tvChart，
// #macdChart / #rsiChart / #adxChart 已从分析页移除（initChart 里那三段副图分支因此不会执行，
// macdChart/rsiChart/adxChart 恒为 null）⇒ 实际导出的是主图。合成逻辑保留多图能力，
// 若日后把副图容器加回来，无需改动这里即可自动把副图一起拼进去。
//
// 为什么不"导出前临时放大"：试过 `chart.resize(1600, h)` 这条路，实测**不可靠** ——
// 应用自己挂了一个 ResizeObserver（initChart 里的 window.__chartRO，回调里 applyOptions({width,height})），
// 它会在导出过程中把图表重新拉回容器尺寸，于是截图又变回原尺寸（实测导出结果从 1998px 掉回 1119px）；
// 而且 DPR=1.5 时 takeScreenshot 返回设备像素、resize 收 CSS 像素，恢复时极易把图撑大 1.5 倍留在界面上。
// 结论：不去和应用自身的响应式机制较劲。导出直接用图表当前尺寸 —— 窗口开大一点，导出的图就更清晰。
// 真正要防的是「容器不可见 ⇒ 截图是几十像素的废图」这一种情况，见下面的 BT_PNG_MIN_W 校验。
var BT_PNG_MIN_W = 300;        // 设备像素：低于此值视为「图表没渲染出来」
function btCharts() {
  return [priceChart, macdChart, rsiChart, adxChart].filter(function (ch) {
    return ch && typeof ch.takeScreenshot === "function";
  });
}
function btShotAll(charts) {
  var out = [];
  charts.forEach(function (ch) {
    try {
      var c = ch.takeScreenshot();
      if (c && c.width > 0 && c.height > 0) out.push({ ch: ch, c: c, w: c.width, h: c.height });
    } catch (e) { console.warn("[app] takeScreenshot failed:", e && e.message); }
  });
  return out;
}
// 只负责合成，返回 {dataUrl,w,h,charts} 或 {error}
async function buildChartPngDataUrl() {
  var charts = btCharts();
  if (!charts.length) return { error: "当前没有可导出的图表" };
  var shots = btShotAll(charts);
  if (!shots.length) return { error: "图表尚未渲染完成，请先切到分析页并选中币种" };
  var W = shots.reduce(function (m, s) { return Math.max(m, s.w); }, 0);
  if (W < BT_PNG_MIN_W) return { error: "图表尺寸过小（宽 " + W + "px），请先切到分析页并选中币种再导出" };
  var H = shots.reduce(function (a, s) { return a + Math.round(s.h * W / s.w); }, 0);
  var out = document.createElement("canvas");
  out.width = W; out.height = H;
  var ctx = out.getContext("2d");
  ctx.fillStyle = cssVar("--chart-bg") || "#0b0b11";
  ctx.fillRect(0, 0, W, H);
  var y = 0;
  shots.forEach(function (s) {
    var h = Math.round(s.h * W / s.w);
    try { ctx.drawImage(s.c, 0, y, W, h); } catch (e) { console.warn("[app] drawImage failed:", e && e.message); }
    y += h;
  });
  var dataUrl;
  try { dataUrl = out.toDataURL("image/png"); }
  catch (e) { return { error: "画布不可读取（" + (e && e.message) + "）" }; }
  return { dataUrl: dataUrl, w: W, h: H, charts: shots.length };
}
async function exportChartPng() {
  var r;
  try { r = await buildChartPngDataUrl(); }
  catch (e) { linkedToast("导出失败：" + (e && e.message)); return; }
  if (r.error) { linkedToast(r.error); return; }
  var sym = lastAnalysisSymbol || "chart";
  var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  var name = `NovaTrade_${sym}_${currentRange}_${stamp}.png`;
  if (window.electronAPI && window.electronAPI.exportPng) {
    const res = await window.electronAPI.exportPng(name, r.dataUrl);
    if (res && res.ok) { linkedToast("已导出 " + r.w + "×" + r.h + " 图片到 " + res.path); return; }
    if (res && res.canceled) return;
    linkedToast("导出失败：" + ((res && res.error) || "未知错误"));
    return;
  }
  try {
    const a = document.createElement("a");
    a.href = r.dataUrl; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    linkedToast("已下载 " + name + "（" + r.w + "×" + r.h + "）");
  } catch (e) { linkedToast("导出失败：" + (e && e.message)); }
}
window.buildChartPngDataUrl = buildChartPngDataUrl;
window.exportChartPng = exportChartPng;

// ---------- 2026-10-09 第九步新增：应用内阈值回测（walk-forward，近似回测） ----------
// 要回答的问题只有一个：把 SIGNAL_LONG_MIN / SHORT_SCORE_MIN 从当前值挪开，胜率和每笔期望怎么变？
//
// 做法（walk-forward，无未来函数）：
//   1. 取历史 K 线，从第 BT_MIN_WARMUP 根开始，每隔 step 根取一个「采样点」i；
//   2. 只把 [0..i] 喂给 analyzeCoin（它是纯函数，只读入参、不碰 DOM、不看未来），得到「当时」的 score；
//   3. 记录该时刻之后 h1 / h4 根 K 线的真实涨跌 —— 这就是该信号的真实前向收益；
//   4. 阈值扫描是在这份 score 序列上做二次筛选，不重算指标（score 与阈值无关，所以只算一次）。
//
// 三条必须写进 UI 的局限（避免被误读成收益承诺）：
//   · 按信号 K 线收盘价成交，不含滑点、资金费，只扣一个可调的往返手续费；
//   · 采样点步长 < 持仓周期时，样本之间收益重叠，统计上不独立（胜率/期望只能看相对趋势）；
//   · 这里的"期望"是「每笔固定仓位」的算术平均，不是复利净值；最大回撤也是加法净值曲线上的回撤。
// 需要含 ATR 止损/止盈、冷却期、真实撮合的完整模拟，请用 bt/backtest.js（同一套 analyzeCoin 评分引擎）。
var BT_KEY = "novatrade_bt_cfg";
var BT_TTL = 10 * 60e3;
var BT_TF_LIST = ["15m", "1h", "4h", "1d"];
var BT_LONG_SWEEP = [50, 55, 60, 65, 70, 75, 80, 85];
var BT_SHORT_SWEEP = [30, 34, 38, 40, 42, 45, 48];
window.__btCache = window.__btCache || {};   // "sym|tf|bars|step" -> {ts, samples}
window.__btRun = 0;                          // 运行令牌：重跑时作废上一次未完成的遍历
window.__btResult = null;

function btDefaultCfg() {
  return { tf: "1h", bars: 1000, step: 4, h1: 1, h4: 4, fee: 0.08, overheat: true,
           longMin: SIGNAL_LONG_MIN, shortCeil: SHORT_SCORE_MIN - 1 };
}
function loadBtCfg() {
  if (!window.__btCfg) {
    var c = null;
    try { c = JSON.parse(localStorage.getItem(BT_KEY) || "null"); } catch (e) {}
    // 注意必须 Object.assign({}, d, c)：若写成 Object.assign(d, c)，
    // 目标对象就是 btDefaultCfg() 的返回值本身，存储里的非法值会先把「默认值」覆盖掉，
    // 下面的回落逻辑再拿 d 当兜底就兜了个脏值（曾实测：存的 tf:"3m" 回落后仍是 "3m"）。
    window.__btCfg = Object.assign({}, btDefaultCfg(), c || {});
  }
  var c2 = window.__btCfg, d = btDefaultCfg();   // 兜底值现取一份干净的
  if (BT_TF_LIST.indexOf(c2.tf) < 0) c2.tf = d.tf;
  if (typeof c2.overheat !== "boolean") c2.overheat = d.overheat;
  ["bars", "step", "h1", "h4", "fee", "longMin", "shortCeil"].forEach(function (k) {
    if (typeof c2[k] !== "number" || !isFinite(c2[k])) c2[k] = d[k];
  });
  return c2;
}
function saveBtCfg() { try { localStorage.setItem(BT_KEY, JSON.stringify(window.__btCfg)); } catch (e) {} }

// 一次遍历：返回 [{ts, score, entry, r1, r4}]，结果按「币|周期|根数|步长」缓存 10 分钟
async function btWalkForward(sym, cfg, token, onProgress) {
  var key = sym + "|" + cfg.tf + "|" + cfg.bars + "|" + cfg.step;
  var hit = window.__btCache[key];
  if (hit && Date.now() - hit.ts < BT_TTL) return hit.samples;
  var kl = await btLoadBars(sym, cfg.tf, cfg.bars + cfg.step + Math.max(cfg.h1, cfg.h4) + 2);
  var n = kl.length;
  if (n < BT_MIN_WARMUP + 30) throw new Error("样本不足：仅取到 " + n + " 根 K 线");
  var closes = new Array(n), ohlc = new Array(n);
  for (var j = 0; j < n; j++) {
    var k = kl[j];
    closes[j] = parseFloat(k[4]);
    ohlc[j] = [k[0], parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])];
  }
  var maxH = Math.max(cfg.h1, cfg.h4);
  var start = Math.max(BT_MIN_WARMUP, n - cfg.bars - maxH);
  var samples = [], budget = 0;
  for (var i = start; i + maxH < n; i += cfg.step) {
    if (window.__btRun !== token) throw new Error("__aborted__");
    var from = Math.max(0, i + 1 - BT_WINDOW);
    var w = analyzeCoin(closes.slice(from, i + 1), sym, ohlc.slice(from, i + 1));
    var entry = closes[i];
    if (entry > 0) {
      samples.push({
        ts: kl[i][0], score: w.score, entry: entry,
        r1: (closes[i + cfg.h1] / entry - 1) * 100,
        r4: (closes[i + cfg.h4] / entry - 1) * 100
      });
    }
    if (++budget % 25 === 0) {
      if (onProgress) onProgress(samples.length);
      await new Promise(function (r) { setTimeout(r, 0); });  // 让出主线程，避免界面卡死
    }
  }
  window.__btCache[key] = { ts: Date.now(), samples: samples };
  return samples;
}

// 按「方向 + 阈值条件」筛出交易，算净收益序列与统计量
function btCollect(samples, dir, horizon, fee, cond) {
  var rets = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (!cond(s)) continue;
    var raw = horizon === "h4" ? s.r4 : s.r1;
    if (typeof raw !== "number" || !isFinite(raw)) continue;
    rets.push((dir === "long" ? raw : -raw) - fee);   // 空头：价格跌才赚
  }
  return rets;
}
function btStats(rets) {
  var n = rets.length;
  if (!n) return null;
  var sum = 0, wins = 0, grossWin = 0, grossLoss = 0, eq = 0, peak = 0, mdd = 0;
  for (var i = 0; i < n; i++) {
    var r = rets[i];
    sum += r;
    if (r > 0) { wins++; grossWin += r; } else if (r < 0) { grossLoss += -r; }
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > mdd) mdd = peak - eq;
  }
  return {
    n: n, winRate: wins / n * 100, avg: sum / n, total: sum, mdd: mdd,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: (n - wins) ? grossLoss / (n - wins) : 0
  };
}
// 净收益 % → 颜色：本应用主体是「绿涨红跌」，导出/回测保持一致
function btCls(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }
function btFmt(v, d) { return (v > 0 ? "+" : "") + v.toFixed(d === undefined ? 2 : d); }
function btPct(v, d) { return v === Infinity ? "∞" : v.toFixed(d === undefined ? 2 : d); }

// 阈值扫描表：一行一个阈值，最后高亮当前值
// 注意：多空两侧在 score 轴上天然互斥（开多 ≥65、开空 ≤38），所以每张表只扫一侧阈值，
// 不对另一侧加边界（否则「score≥50 且 score≤38」会恒为空集）。
function btSweepHtml(samples, cfg, dir, horizon) {
  var isLong = dir === "long";
  var list = isLong ? BT_LONG_SWEEP : BT_SHORT_SWEEP;
  var cur = isLong ? cfg.longMin : cfg.shortCeil;
  var rows = list.map(function (th) {
    var cond = isLong
      ? (cfg.overheat
          ? function (s) { return s.score >= th && !(s.score >= OVERHEAT_MIN && s.score < OVERHEAT_MAX); }
          : function (s) { return s.score >= th; })
      : function (s) { return s.score <= th; };
    var st = btStats(btCollect(samples, dir, horizon, cfg.fee, cond));
    var isCur = th === cur;
    if (!st) return '<tr class="' + (isCur ? "bt-cur" : "") + '"><td>' + th + (isCur ? " ●" : "") + '</td><td colspan="7" class="bt-dim">无信号</td></tr>';
    return '<tr class="' + (isCur ? "bt-cur" : "") + '">' +
      '<td>' + th + (isCur ? " ●" : "") + '</td>' +
      '<td>' + st.n + '</td>' +
      '<td>' + st.winRate.toFixed(1) + '%</td>' +
      '<td class="' + btCls(st.avg) + '">' + btFmt(st.avg, 3) + '</td>' +
      '<td class="' + btCls(st.total) + '">' + btFmt(st.total, 1) + '</td>' +
      '<td>' + btPct(st.pf) + '</td>' +
      '<td>' + btFmt(st.avgWin, 2) + ' / ' + btFmt(-st.avgLoss, 2) + '</td>' +
      '<td>' + st.mdd.toFixed(1) + '</td></tr>';
  }).join("");
  return '<table class="bt-table"><thead><tr>' +
    '<th>' + (isLong ? "开多阈值 score≥" : "开空阈值 score≤") + '</th>' +
    '<th>信号数</th><th>胜率</th><th>每笔期望%</th><th>累计%</th><th>盈亏比</th><th>均盈/均亏%</th><th>最大回撤%</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function btFormHtml(sym, cfg) {
  var tfOpts = BT_TF_LIST.map(function (t) {
    return '<option value="' + t + '"' + (t === cfg.tf ? " selected" : "") + '>' + t + '</option>';
  }).join("");
  return '<div class="bt-form">' +
    '<label class="bt-f"><span>币种</span><b>' + escapeHtml(sym || "--") + '</b></label>' +
    '<label class="bt-f"><span>周期</span><select id="btTf">' + tfOpts + '</select></label>' +
    '<label class="bt-f"><span>样本根数</span><input id="btBars" type="number" min="200" max="20000" step="100" value="' + cfg.bars + '"></label>' +
    '<label class="bt-f"><span>采样步长</span><input id="btStep" type="number" min="1" max="50" step="1" value="' + cfg.step + '"></label>' +
    '<label class="bt-f"><span>短周期(根)</span><input id="btH1" type="number" min="1" max="96" step="1" value="' + cfg.h1 + '"></label>' +
    '<label class="bt-f"><span>长周期(根)</span><input id="btH4" type="number" min="1" max="192" step="1" value="' + cfg.h4 + '"></label>' +
    '<label class="bt-f"><span>往返手续费%</span><input id="btFee" type="number" min="0" max="2" step="0.01" value="' + cfg.fee + '"></label>' +
    '<label class="bt-f"><span>开多阈值</span><input id="btLong" type="number" min="20" max="95" step="1" value="' + cfg.longMin + '"></label>' +
    '<label class="bt-f"><span>开空上限</span><input id="btShort" type="number" min="5" max="80" step="1" value="' + cfg.shortCeil + '"></label>' +
    '<label class="bt-f bt-f-check"><input id="btOverheat" type="checkbox"' + (cfg.overheat ? " checked" : "") + '><span>应用过热区过滤（' + OVERHEAT_MIN + '≤score&lt;' + OVERHEAT_MAX + ' 不开多）</span></label>' +
    '<div class="bt-actions"><button class="btn-refresh" onclick="runBacktest()">开始回测</button>' +
    '<button class="btn-ghost" onclick="exportBacktestCsv()">导出 CSV</button></div>' +
    '</div>' +
    '<div class="bt-note">walk-forward 近似回测：只喂「采样点之前」的 K 线给评分引擎，前向收益按信号 K 线收盘价成交、扣 ' +
    cfg.fee.toFixed(2) + '% 往返手续费。采样步长小于持仓周期时样本收益重叠，胜率/期望只宜看相对趋势；' +
    '这里的期望是「每笔固定仓位」的算术平均，非复利。当前实盘常量：SIGNAL_LONG_MIN=' + SIGNAL_LONG_MIN +
    '、SHORT_SCORE_MIN=' + SHORT_SCORE_MIN + '（等价于 score≤' + (SHORT_SCORE_MIN - 1) + ' 开空）。' +
    '本页<b>不含</b>日线趋势门控与 ATR 止损止盈 —— 那部分请用 bt/backtest.js 的完整模拟。</div>';
}

function btEmptyHtml() {
  return '<div class="ai-rr-placeholder">点「开始回测」跑一次阈值扫描。首次遍历 ' +
    '1000 根 K 线约需 1-2 秒，结果缓存 10 分钟。</div>';
}

function btResultHtml(res) {
  var cfg = res.cfg, samples = res.samples;
  var upCount = samples.filter(function (s) { return s.score >= SIGNAL_LONG_MIN; }).length;
  var dnCount = samples.filter(function (s) { return s.score <= SHORT_SCORE_MIN - 1; }).length;
  var first = samples.length ? new Date(samples[0].ts) : null;
  var last = samples.length ? new Date(samples[samples.length - 1].ts) : null;
  var span = (first && last) ? (first.toLocaleDateString("zh-CN") + " ~ " + last.toLocaleDateString("zh-CN")) : "--";
  var head = '<div class="bt-summary">' +
    '<span class="bt-chip">样本 <b>' + samples.length + '</b> 个采样点</span>' +
    '<span class="bt-chip">区间 <b>' + span + '</b></span>' +
    '<span class="bt-chip">' + res.sym + ' · ' + cfg.tf + ' · 每 ' + cfg.step + ' 根取一点</span>' +
    '<span class="bt-chip">其中 score≥' + SIGNAL_LONG_MIN + ' <b>' + upCount + '</b> 个 / score≤' + (SHORT_SCORE_MIN - 1) + ' <b>' + dnCount + '</b> 个</span>' +
    '</div>';
  var ohNote = cfg.overheat ? "（已应用过热区过滤）" : "（未应用过热区过滤）";
  return head +
    '<div class="bt-block"><div class="bt-block-title">多头阈值扫描 · 前向 ' + cfg.h1 + ' 根（' + cfg.tf + '）' + ohNote + '</div>' +
    btSweepHtml(samples, cfg, "long", "h1") + '</div>' +
    '<div class="bt-block"><div class="bt-block-title">多头阈值扫描 · 前向 ' + cfg.h4 + ' 根（' + cfg.tf + '）' + ohNote + '</div>' +
    btSweepHtml(samples, cfg, "long", "h4") + '</div>' +
    '<div class="bt-block"><div class="bt-block-title">空头阈值扫描 · 前向 ' + cfg.h1 + ' 根（' + cfg.tf + '）</div>' +
    btSweepHtml(samples, cfg, "short", "h1") + '</div>' +
    '<div class="bt-block"><div class="bt-block-title">空头阈值扫描 · 前向 ' + cfg.h4 + ' 根（' + cfg.tf + '）</div>' +
    btSweepHtml(samples, cfg, "short", "h4") + '</div>' +
    '<div class="bt-note">● 标记的是当前实盘阈值。读表方式：<b>先看「信号数」</b>——样本太少的行（如 &lt;20）无论胜率多高都不足为凭；' +
    '再看「每笔期望」与「盈亏比」是否同向改善；最后看「最大回撤」有没有被阈值抬高而放大。</div>';
}

function renderBacktest(symbol) {
  var wrap = document.getElementById("btWrap"); if (!wrap) return;
  var sym = symbol || lastAnalysisSymbol || selectedCoin || "";
  if (sym && !/USDT$/.test(sym)) sym = sym + "USDT";
  var cfg = loadBtCfg();
  var res = (window.__btResult && window.__btResult.sym === sym) ? window.__btResult : null;
  wrap.innerHTML = btFormHtml(sym, cfg) + '<div id="btStatus" class="bt-status"></div>' +
    (res ? btResultHtml(res) : btEmptyHtml()) +
    // 2026-10-09 第十批：完整回测（含门控 + 实际止损止盈）+ 稳健性检验
    '<div id="btFullBox"></div>';
  try { renderBtFull(sym); } catch (e) { console.error("[app] bt full render:", e); }
}
function btReadForm() {
  var cfg = loadBtCfg();
  var num = function (id, def, lo, hi) {
    var el = document.getElementById(id); if (!el) return def;
    var v = parseFloat(el.value);
    if (!isFinite(v)) return def;
    return Math.max(lo, Math.min(hi, v));
  };
  var tfEl = document.getElementById("btTf");
  if (tfEl && BT_TF_LIST.indexOf(tfEl.value) >= 0) cfg.tf = tfEl.value;
  cfg.bars = Math.round(num("btBars", cfg.bars, 200, 20000));
  cfg.step = Math.round(num("btStep", cfg.step, 1, 50));
  cfg.h1 = Math.round(num("btH1", cfg.h1, 1, 96));
  cfg.h4 = Math.round(num("btH4", cfg.h4, 1, 192));
  cfg.fee = num("btFee", cfg.fee, 0, 2);
  cfg.longMin = Math.round(num("btLong", cfg.longMin, 20, 95));
  cfg.shortCeil = Math.round(num("btShort", cfg.shortCeil, 5, 80));
  var ohEl = document.getElementById("btOverheat");
  if (ohEl) cfg.overheat = !!ohEl.checked;
  saveBtCfg();
  return cfg;
}
function btStatus(msg) {
  var el = document.getElementById("btStatus");
  if (el) el.innerHTML = msg || "";
}
async function runBacktest() {
  var wrap = document.getElementById("btWrap"); if (!wrap) return;
  var sym = lastAnalysisSymbol || selectedCoin || "";
  if (sym && !/USDT$/.test(sym)) sym = sym + "USDT";
  if (!sym) { linkedToast("先选一个币种再做回测"); return; }
  var cfg = btReadForm();
  var token = ++window.__btRun;
  btStatus('<span class="bt-spin">正在遍历历史 K 线…</span>');
  try {
    var samples = await btWalkForward(sym, cfg, token, function (k) {
      if (window.__btRun === token) btStatus('<span class="bt-spin">正在遍历历史 K 线… 已算 ' + k + ' 个采样点</span>');
    });
    if (window.__btRun !== token) return;
    window.__btResult = { sym: sym, cfg: cfg, samples: samples, ts: Date.now() };
    renderBacktest(sym);
    linkedToast("回测完成：" + samples.length + " 个采样点");
  } catch (e) {
    if (window.__btRun !== token) return;
    if (e && e.message === "__aborted__") return;
    btStatus('<span class="bt-err">回测失败：' + escapeHtml(e && e.message) + '</span>');
    console.warn("[app] backtest failed:", e && e.message);
  }
}
async function exportBacktestCsv() {
  var res = window.__btResult;
  if (!res || !res.samples || !res.samples.length) { linkedToast("还没有回测结果可导出"); return; }
  var cfg = res.cfg;
  var rows = res.samples.map(function (s) {
    return [new Date(s.ts).toISOString(), res.sym, s.score, s.entry,
      s.r1.toFixed(3), s.r4.toFixed(3), cfg.fee.toFixed(2)];
  });
  var csv = toCsv(["时间", "币种", "评分", "入场价", "前向" + cfg.h1 + "根毛收益%", "前向" + cfg.h4 + "根毛收益%", "往返手续费%"], rows);
  var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  await downloadText(`阈值回测_${res.sym}_${cfg.tf}_${stamp}.csv`, csv);
}
window.renderBacktest = renderBacktest;
window.runBacktest = runBacktest;
window.exportBacktestCsv = exportBacktestCsv;



// ---------- 2026-10-09 第六步新增：板块强弱聚合 ----------
// 纯前端聚合（零新请求）：把成交额前 200 的币按赛道归类，看资金在哪个板块轮动。
// 赛道归属是内置静态表（币种赛道本身变化很慢，没必要为它引入接口）。
const SECTOR_MAP = {
  "支付/隐私": ["XRP", "XLM", "LTC", "BCH", "DASH", "ZEC", "XMR", "ALGO", "HBAR", "XDC", "CKB", "DGB", "RVN", "WAVES", "DCR", "SCRT", "ROSE", "ZEN"],
  "交易所平台币": ["BNB", "WOO", "FTT", "TWT", "SFP", "C98", "GT", "MX", "LEO"],
  "公链 L1": ["BTC", "ETH", "SOL", "ADA", "AVAX", "TRX", "DOT", "ATOM", "NEAR", "APT", "SUI", "SEI", "TIA", "EGLD", "FTM", "ONE", "ICP", "ETC", "VET", "KAS", "STX", "CELO", "ZIL", "IOTA", "NEO", "EOS", "QTUM", "FLOW", "CFX", "INJ", "MINA", "KSM", "GLMR", "MOVR", "ASTR", "THETA", "IOTX", "QNT", "TON", "OSMO", "JUNO", "KLAY", "ELF", "ONT", "NULS", "WAN", "AERGO", "COTI", "ICX", "WTC", "NAS", "AION", "GRS", "ARK"],
  "L2/扩容": ["MATIC", "POL", "ARB", "OP", "IMX", "STRK", "MNT", "METIS", "LRC", "ZK", "BLAST", "MANTA", "SKL", "BOBA", "CTSI", "CELR", "TAIKO", "DYM", "ALT", "SAGA", "OMNI"],
  "DeFi": ["UNI", "AAVE", "MKR", "COMP", "CRV", "SUSHI", "SNX", "LDO", "CAKE", "1INCH", "BAL", "YFI", "DYDX", "GMX", "PENDLE", "JUP", "RAY", "ENA", "EIGEN", "ETHFI", "ONDO", "RUNE", "KAVA", "ALPHA", "REN", "KNC", "ZRX", "BNT", "DODO", "AUCTION", "BEL", "ALPACA", "RIF", "XVS", "BAKE", "ACH", "PYR", "ID", "HOOK", "MLN", "FIS", "TRU", "SRM"],
  "Meme": ["DOGE", "SHIB", "PEPE", "FLOKI", "BONK", "WIF", "MEME", "BOME", "ORDI", "SATS", "RATS", "DOGS", "NEIRO", "POPCAT", "TURBO", "MOG", "BRETT", "BAN", "PENGU", "TRUMP", "BABYDOGE", "ELON", "SHIB1000", "1000SATS", "1000RATS", "1000PEPE", "1000BONK", "1000FLOKI"],
  "AI/算力": ["FET", "AGIX", "OCEAN", "RENDER", "GRT", "TAO", "ARKM", "AI", "WLD", "NFP", "PHB", "LPT", "NMR", "AGRS", "IO", "ATH", "VANA", "CGPT"],
  "存储/基础设施": ["FIL", "AR", "STORJ", "SC", "BLZ", "HNT", "GLM", "ANKR", "NKN", "CQT", "DUSK", "MASK"],
  "游戏/NFT": ["SAND", "MANA", "AXS", "GALA", "ENJ", "APE", "ILV", "MAGIC", "PRIME", "PIXEL", "PORTAL", "BEAM", "YGG", "ALICE", "TLM", "CHR", "GHST", "GODS", "HIGH", "SLP", "MBOX", "DAR", "VOXEL", "AUDIO", "BLUR", "RONIN"],
  "预言机": ["LINK", "BAND", "TRB", "API3", "PYTH", "UMA", "DIA", "ORAI"],
  "跨链/互操作": ["AXL", "W", "ZRO", "LAYER", "AXEL"],
  "RWA/资产代币": ["POLYX", "OM", "CFG", "MPLX", "SNX"]
};
const SECTOR_LOOKUP = (function () {
  const m = {};
  Object.keys(SECTOR_MAP).forEach(function (sec) {
    SECTOR_MAP[sec].forEach(function (base) { if (!m[base]) m[base] = sec; });   // 先到先得，避免一个币被多个赛道抢
  });
  return m;
})();
function sectorOf(symbol) { return SECTOR_LOOKUP[splitSymbol(symbol).base] || "其他"; }
function renderSectors() {
  const wrap = document.getElementById("sectorWrap");
  if (!wrap) return;
  if (!allCoins || allCoins.length === 0) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">行情尚未加载完成，稍后重试</div>"; return; }
  const pool = [...allCoins].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 200);
  const agg = {};
  pool.forEach(function (c) {
    const sec = sectorOf(c.symbol);
    const a = agg[sec] || (agg[sec] = { name: sec, n: 0, sumChg: 0, sumVol: 0, up: 0, coins: [] });
    a.n++; a.sumChg += (c.change || 0); a.sumVol += (c.volume || 0);
    if ((c.change || 0) > 0) a.up++;
    a.coins.push(c);
  });
  let list = Object.keys(agg).map(function (k) {
    const a = agg[k];
    a.avgChg = a.sumChg / a.n;
    a.breadth = (a.up / a.n) * 100;
    a.coins.sort((x, y) => (y.change || 0) - (x.change || 0));
    return a;
  }).filter(a => a.n >= 2);                     // 只有 1 个币的板块没有统计意义
  if (!list.length) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">暂无可聚合的板块数据</div>"; return; }
  list.sort((a, b) => b.avgChg - a.avgChg);
  const maxAbs = Math.max.apply(null, list.map(a => Math.abs(a.avgChg))) || 1;
  const strong = list.slice(0, 3), weak = list.slice(-3).reverse();
  const rows = list.map(function (a) {
    const w = Math.max(2, Math.round(Math.abs(a.avgChg) / maxAbs * 50));   // 半宽百分比
    const pos = a.avgChg >= 0;
    const bar = pos
      ? "<div class=\"sector-bar\"><div class=\"sector-bar-fill pos\" style=\"left:50%;width:" + w + "%\"></div></div>"
      : "<div class=\"sector-bar\"><div class=\"sector-bar-fill neg\" style=\"right:50%;width:" + w + "%\"></div></div>";
    const tops = a.coins.slice(0, 3).map(c => splitSymbol(c.symbol).base + " " + (c.change >= 0 ? "+" : "") + (c.change || 0).toFixed(1) + "%").join(" · ");
    return "<div class=\"sector-row\">" +
      "<span class=\"sector-name\">" + escapeHtml(a.name) + "</span>" +
      "<span class=\"sector-n\">" + a.n + " 个</span>" +
      bar +
      "<span class=\"sector-chg " + (pos ? "up" : "down") + "\">" + (pos ? "+" : "") + a.avgChg.toFixed(2) + "%</span>" +
      "<span class=\"sector-breadth\">" + a.breadth.toFixed(0) + "% 上涨</span>" +
      "<span class=\"sector-top\" title=\"" + escapeHtml(tops) + "\">" + escapeHtml(tops) + "</span>" +
      "</div>";
  }).join("");
  wrap.innerHTML =
    "<div class=\"sector-sum\"><span class=\"sector-sum-item\">领涨：<b class=\"up\">" + escapeHtml(strong.map(a => a.name + " " + (a.avgChg >= 0 ? "+" : "") + a.avgChg.toFixed(2) + "%").join("、")) + "</b></span>" +
    "<span class=\"sector-sum-item\">领跌：<b class=\"down\">" + escapeHtml(weak.map(a => a.name + " " + a.avgChg.toFixed(2) + "%").join("、")) + "</b></span></div>" +
    "<div class=\"sector-table\"><div class=\"sector-row head\"><span>板块</span><span>数量</span><span>板块均值（相对中线）</span><span>均值</span><span>上涨占比</span><span>代表币</span></div>" + rows + "</div>" +
    "<div class=\"vp-note\">取 24h 成交额前 200 个币聚合（不足 2 个币的板块不显示）。「上涨占比」看板块内部是否一致 —— 均值高但占比低，说明只是被个别龙头拉起来；均值与占比同时高，才是真轮动。<strong>独立统计，不参与主评分。</strong></div>";
}
window.renderSectors = renderSectors;

// ---------- 第七步：多币对比 ----------
window.__cmpCoins = window.__cmpCoins || ["BTCUSDT", "ETHUSDT"];
window.__cmpTf = window.__cmpTf || "1h";
window.__cmpCache = window.__cmpCache || {};
const CMP_COLORS = ["#6366f1", "#f0a91b", "#a855f7", "#22d3ee"];
function renderCmpPicker() {
  const box = document.getElementById("cmpPicker");
  if (!box) return;
  const list = window.__cmpCoins;
  const opts = (allCoins || []).slice().sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 150)
    .map(c => "<option value=\"" + escapeHtml(c.symbol) + "\"></option>").join("");
  box.innerHTML =
    "<span class=\"cmp-label\">对比币种</span>" +
    list.map((s, i) => "<span class=\"cmp-chip\" style=\"border-color:" + CMP_COLORS[i % CMP_COLORS.length] + "\">" +
      escapeHtml(splitSymbol(s).base) +
      "<em onclick=\"removeCmpCoin('" + escapeJsAttr(s) + "')\">×</em></span>").join("") +
    (list.length < 4
      ? "<input id=\"cmpInput\" class=\"sc-input cmp-input\" list=\"cmpCoinList\" placeholder=\"输入币种后回车，如 SOL\" onkeydown=\"if(event.key==='Enter'){event.preventDefault();addCmpCoin();}\">" +
        "<button class=\"btn-ghost\" onclick=\"addCmpCoin()\">添加</button>" +
        "<datalist id=\"cmpCoinList\">" + opts + "</datalist>"
      : "<span class=\"cmp-hint\">最多对比 4 个</span>") +
    "<select id=\"cmpTf\" class=\"sc-input cmp-tf\" onchange=\"setCmpTf(this.value)\">" +
      ["15m", "1h", "4h"].map(t => "<option value=\"" + t + "\"" + (window.__cmpTf === t ? " selected" : "") + ">" + t + "</option>").join("") +
    "</select>";
}
function addCmpCoin() {
  const el = document.getElementById("cmpInput");
  if (!el) return;
  let v = String(el.value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!v) return;
  if (!v.endsWith("USDT")) v += "USDT";
  if (window.__cmpCoins.indexOf(v) !== -1) { linkedToast("已经在对比列表里了"); return; }
  if (window.__cmpCoins.length >= 4) { linkedToast("最多同时对比 4 个"); return; }
  if (allCoins && allCoins.length && !allCoins.some(c => c.symbol === v)) { linkedToast("未找到 " + v); return; }
  window.__cmpCoins.push(v);
  renderCmpPicker(); renderMultiCompare();
}
function removeCmpCoin(sym) {
  window.__cmpCoins = window.__cmpCoins.filter(s => s !== sym);
  renderCmpPicker(); renderMultiCompare();
}
function setCmpTf(tf) { window.__cmpTf = tf; renderMultiCompare(); }
window.addCmpCoin = addCmpCoin; window.removeCmpCoin = removeCmpCoin; window.setCmpTf = setCmpTf;
// 归一化走势对比：把每个币的收盘价换算成「相对起点涨跌 %」，这样不同价位的币能画在一张图上
function cmpSeries(kl) {
  const closes = kl.map(k => k[4]);
  if (closes.length < 10 || !closes[0]) return null;
  const base = closes[0];
  return closes.map(c => (c / base - 1) * 100);
}
function cmpChart(series) {
  const W = 1000, H = 300, padL = 56, padR = 14, padT = 14, padB = 24;
  let lo = Infinity, hi = -Infinity, maxN = 0;
  series.forEach(s => {
    if (s.vals.length > maxN) maxN = s.vals.length;
    s.vals.forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
  });
  if (!isFinite(lo) || !isFinite(hi)) return "";
  if (hi - lo < 1e-6) { hi = lo + 1; lo -= 1; }
  const span = hi - lo, pad = span * 0.08;
  lo -= pad; hi += pad;
  const X = (i) => padL + (maxN <= 1 ? 0 : (i / (maxN - 1)) * (W - padL - padR));
  const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * (g / 4), y = Y(v);
    grid += "<line x1=\"" + padL + "\" y1=\"" + y.toFixed(1) + "\" x2=\"" + (W - padR) + "\" y2=\"" + y.toFixed(1) + "\" stroke=\"var(--chart-grid)\" stroke-width=\"1\"/>" +
      "<text x=\"" + (padL - 6) + "\" y=\"" + (y + 3).toFixed(1) + "\" text-anchor=\"end\" font-size=\"10\" fill=\"var(--chart-text)\">" + (v >= 0 ? "+" : "") + v.toFixed(1) + "%</text>";
  }
  const zeroY = Y(0);
  const zeroLine = (0 >= lo && 0 <= hi)
    ? "<line x1=\"" + padL + "\" y1=\"" + zeroY.toFixed(1) + "\" x2=\"" + (W - padR) + "\" y2=\"" + zeroY.toFixed(1) + "\" stroke=\"var(--chart-border)\" stroke-width=\"1\" stroke-dasharray=\"3 3\"/>"
    : "";
  const lines = series.map(function (s, idx) {
    const color = CMP_COLORS[idx % CMP_COLORS.length];
    const pts = s.vals.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" ");
    const lastY = Y(s.vals[s.vals.length - 1]).toFixed(1);
    const lastX = X(s.vals.length - 1).toFixed(1);
    return "<polyline points=\"" + pts + "\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/>" +
      "<circle cx=\"" + lastX + "\" cy=\"" + lastY + "\" r=\"2.6\" fill=\"" + color + "\"/>";
  }).join("");
  return "<div class=\"net-wrap\"><svg class=\"net-svg\" viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"xMidYMid meet\">" +
    grid + zeroLine + lines + "</svg></div>";
}
async function renderMultiCompare() {
  const wrap = document.getElementById("compareWrap");
  if (!wrap) return;
  const list = window.__cmpCoins || [];
  if (list.length === 0) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">请先添加要对比的币种</div>"; return; }
  wrap.innerHTML = "<div class=\"ai-rr-placeholder\">正在拉取 " + list.length + " 个币的 " + escapeHtml(window.__cmpTf) + " K 线...</div>";
  const data = {}, series = [], missing = [];
  for (let i = 0; i < list.length; i++) {
    const sym = list[i];
    const key = sym + "|" + window.__cmpTf;
    let c = window.__cmpCache[key];
    if (!c || Date.now() - c.ts > 120000) {
      let r = null;
      try { r = await fetchKlines(sym, window.__cmpTf, 120); } catch (e) { r = null; }
      if (!r || !r.ohlc || r.ohlc.length < 10) { missing.push(sym); continue; }
      c = { ts: Date.now(), closes: r.closes, ohlc: r.ohlc };
      window.__cmpCache[key] = c;
    }
    data[sym] = c;
    const vals = cmpSeries(c.ohlc);
    if (vals) series.push({ symbol: sym, vals: vals, color: CMP_COLORS[i % CMP_COLORS.length] });
  }
  if (!series.length) { wrap.innerHTML = "<div class=\"ai-rr-placeholder\">所选币种都没有取到 K 线数据，请检查网络或换一个币</div>"; return; }
  // 指标并排表：复用扫描器的指标函数，保证与「选币扫描」口径一致
  const rows = series.map(function (s) {
    const c = data[s.symbol];
    const ind = screenerIndicators(c.closes, c.ohlc, { change: 0 }) || {};
    const coin = (allCoins || []).find(x => x.symbol === s.symbol) || {};
    const last = s.vals[s.vals.length - 1];
    const f = (v, d) => (v === null || v === undefined || !isFinite(v)) ? "--" : v.toFixed(d === undefined ? 2 : d);
    const cross = ind.macdCross === "golden" ? "金叉" : ind.macdCross === "dead" ? "死叉" : (ind.macdNow > 0 ? "多头" : "空头");
    return "<div class=\"cmp-row\">" +
      "<span class=\"cmp-name\"><i style=\"background:" + s.color + "\"></i>" + escapeHtml(splitSymbol(s.symbol).base) + "</span>" +
      "<span class=\"cmp-cell " + (last >= 0 ? "up" : "down") + "\">" + (last >= 0 ? "+" : "") + f(last) + "%</span>" +
      "<span class=\"cmp-cell " + ((coin.change || 0) >= 0 ? "up" : "down") + "\">" + (coin.change >= 0 ? "+" : "") + f(coin.change) + "%</span>" +
      "<span class=\"cmp-cell\">" + f(ind.rsi, 1) + "</span>" +
      "<span class=\"cmp-cell\">" + f(ind.volRatio) + "</span>" +
      "<span class=\"cmp-cell\">" + cross + "</span>" +
      "<span class=\"cmp-cell\">" + f(ind.kd && ind.kd.j, 0) + "</span>" +
      "<span class=\"cmp-cell\">" + f(ind.bb && ind.bb.pctB) + "</span>" +
      "<span class=\"cmp-cell\">" + f(ind.dd, 1) + "%</span>" +
      "</div>";
  }).join("");
  const best = series.slice().sort((a, b) => b.vals[b.vals.length - 1] - a.vals[a.vals.length - 1])[0];
  const worst = series.slice().sort((a, b) => a.vals[a.vals.length - 1] - b.vals[b.vals.length - 1])[0];
  wrap.innerHTML = cmpChart(series) +
    "<div class=\"cmp-legend\">" + series.map(s => "<span class=\"cmp-lg\"><i style=\"background:" + s.color + "\"></i>" + escapeHtml(splitSymbol(s.symbol).base) + " <b class=\"" + (s.vals[s.vals.length - 1] >= 0 ? "up" : "down") + "\">" + (s.vals[s.vals.length - 1] >= 0 ? "+" : "") + s.vals[s.vals.length - 1].toFixed(2) + "%</b></span>").join("") + "</div>" +
    "<div class=\"vp-note\" style=\"margin-bottom:10px\">横轴为等距 K 线（共 " + series[0].vals.length + " 根 " + escapeHtml(window.__cmpTf) + "），纵轴为相对起点涨跌 %。本周期最强 " + escapeHtml(splitSymbol(best.symbol).base) + "，最弱 " + escapeHtml(splitSymbol(worst.symbol).base) + "，强弱差 " + (best.vals[best.vals.length - 1] - worst.vals[worst.vals.length - 1]).toFixed(2) + " 个百分点。</div>" +
    "<div class=\"cmp-table\"><div class=\"cmp-row head\"><span>币种</span><span>本周期</span><span>24h</span><span>RSI</span><span>量比</span><span>MACD</span><span>KDJ(J)</span><span>%B</span><span>距高点</span></div>" + rows + "</div>" +
    (missing.length ? "<div class=\"deriv-warn\">未取到：" + escapeHtml(missing.map(m => splitSymbol(m).base).join("、")) + "</div>" : "") +
    "<div class=\"vp-note\">「本周期」= 所选周期内的涨跌幅，「距高点」= 距近 24 根高点的回撤。<strong>纯对比展示，不参与主评分。</strong></div>";
}
window.renderMultiCompare = renderMultiCompare;
window.renderCmpPicker = renderCmpPicker;

function renderAnalysis(symbol, a, klines) {
  // 2026-10-10 最后一道闸：6 个调用点最终都从这里落地，渲染目标不是当前选中的币就直接丢弃。
  // 丢弃时**不能**同步 __lastAnalysisData —— 否则视图切换会拿错币的快照去重建图表。
  if (!anaIsCurrentTarget(symbol)) {
    console.warn("[app] 丢弃过期分析渲染:", symbol, "当前选中:", selectedCoin);
    return;
  }
  window.__lastAnalysisData = { symbol, a, klines }; // 供视图切换回分析页时按真实尺寸重建图表
  const cc = a.change>=0?"up":"down";
  const analysisPair = splitSymbol(symbol);
  const quality = fwdQualityStatus();
  const trustBlocked = !quality.actionable || a.confidence < MIN_ACTION_CONFIDENCE || isVetoed(a);
  const displayRec = trustBlocked ? (a.trendDir === "看涨" ? "偏多 · 暂不交易" : a.trendDir === "看跌" ? "偏空 · 暂不交易" : "观望") : a.rec;
  const displayBadge = trustBlocked ? "hold" : a.badge;
  const linkedCtx = window.__linkedSignalContext;
  const linkedBanner = linkedCtx && linkedCtx.symbol === symbol
    ? `<div class="linked-analysis-banner"><strong>来自 AI 推荐：${escapeHtml(linkedCtx.direction === "long" ? "偏多" : "偏空")}</strong><span>${escapeHtml(String(linkedCtx.timeframe || "多周期").toUpperCase())} 主导 · ${Number(linkedCtx.score)}分 · 置信度 ${Number(linkedCtx.confidence)}%</span></div>`
    : "";
  const signalsHtml = a.signals.map(function(s) {
    const color = s.t==="bull"?"var(--positive)":s.t==="bear"?"var(--negative)":"var(--warning)";
    const icon = s.t==="bull"?"<polyline points=\"23 6 13.5 15.5 8.5 10.5 1 18\"/>":s.t==="bear"?"<polyline points=\"23 18 13.5 8.5 8.5 13.5 1 6\"/>":"<circle cx=\"12\" cy=\"12\" r=\"10\"/>";
    return "<span class=\"ai-factor\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"" + color + "\" stroke-width=\"2\">" + icon + "</svg>" + escapeHtml(s.n) + "</span>";
  }).join("");
  // Draw S/R and trendlines on chart
  if (priceChart && a.supports && a.resistances) {
    try {
      // v5 Pane API 无 pane.series()，直接用缓存的蜡烛系列引用
      var mainSeries = (window.__priceChartSeries && window.__priceChartSeries.candle) ? window.__priceChartSeries.candle : null;
      if (!mainSeries) return;
      // 先清理上一轮的支撑/阻力线，避免每次刷新叠加
      if (window.__srLines && window.__srLines.length && mainSeries.removePriceLine) { window.__srLines.forEach(function(l){ try { mainSeries.removePriceLine(l); } catch(e) {} }); }
      window.__srLines = [];
      (a.supports||[]).slice(0,3).forEach(function(s,i) {
        try { window.__srLines.push(mainSeries.createPriceLine({ price: s.price, color: "#10b981", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "支撑"+(i+1) })); } catch(e) {}
      });
      (a.resistances||[]).slice(0,3).forEach(function(r,i) {
        try { window.__srLines.push(mainSeries.createPriceLine({ price: r.price, color: "#ef4444", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "阻力"+(i+1) })); } catch(e) {}
      });
      if (a.trendlines && a.trendlines.uptrend) {
        try {
          var ut = a.trendlines.uptrend;
          var cds = mainSeries.data();
          if (cds && cds.length > 0) {
            mainSeries.createShape({ from: cds[0].time, to: cds[cds.length-1].time, borderColor: "#f59e0b", fillColor: "rgba(245,158,11,0.03)", linewidth: 1, shape: "line", coordinates: [{ time: cds[0].time, price: ut.intercept }, { time: cds[cds.length-1].time, price: ut.endPrice }] });
          }
        } catch(e) {}
      }
      if (a.trendlines && a.trendlines.downtrend) {
        try {
          var dt = a.trendlines.downtrend;
          var cds2 = mainSeries.data();
          if (cds2 && cds2.length > 0) {
            mainSeries.createShape({ from: cds2[0].time, to: cds2[cds2.length-1].time, borderColor: "#6366f1", fillColor: "rgba(99,102,241,0.03)", linewidth: 1, shape: "line", coordinates: [{ time: cds2[0].time, price: dt.intercept }, { time: cds2[cds2.length-1].time, price: dt.endPrice }] });
          }
        } catch(e) {}
      }
    } catch(e) { console.log("[app] chart overlay error:", e.message); }
  }
  // 风险回报统一以多周期（4h 基底）结论为准，避免与右侧分析栏数字不一致
  const __mtfA = (window.__mtfCache||{})[a.symbol ? (a.symbol.endsWith("USDT")?a.symbol:a.symbol+"USDT") : ""] ;
  const rawRr = (__mtfA && __mtfA.data && __mtfA.data.riskReward) || a.riskReward;
  const rr = trustBlocked ? null : rawRr;
  var rrHtml = "";
  if (rr) {
    const dc = rr.direction === "long" ? "buy" : "sell";
    const tpItems = (rr.tps||[]).map(function(t){ return "<div class=\"ai-rr-item\"><span class=\"ai-rr-label\">" + t.label + "</span><span class=\"ai-rr-val buy\">" + formatPrice(t.price) + "</span></div>"; }).join("");
    rrHtml = "<div class=\"ai-rr-row\">" +
      "<div class=\"ai-rr-item\"><span class=\"ai-rr-label\">入场</span><span class=\"ai-rr-val " + dc + "\">" + formatPrice(rr.entry) + "</span></div>" +
      "<div class=\"ai-rr-item\"><span class=\"ai-rr-label\">止损</span><span class=\"ai-rr-val sell\">" + formatPrice(rr.stopLoss) + "</span></div>" +
      "<div class=\"ai-rr-item\"><span class=\"ai-rr-label\">盈亏比</span><span class=\"ai-rr-val\">" + rr.rr + "</span></div>" +
    "</div>" +
    (tpItems ? "<div class=\"ai-rr-row\">" + tpItems + "</div>" : "<div class=\"ai-rr-row\"><div class=\"ai-rr-item\"><span class=\"ai-rr-label\">止盈</span><span class=\"ai-rr-val buy\">" + formatPrice(rr.takeProfit) + "</span></div></div>") +
    "<div class=\"ai-rr-ratio\"><span class=\"ai-rr-ratio-label\">风险</span><span class=\"ai-rr-risk\">" + rr.riskPct + "</span></div>";
  } else { rrHtml = `<div class="ai-rr-placeholder">${trustBlocked ? "前向验证或置信度未达标，仅观察，不提供交易参数" : "切换币种查看风险回报"}</div>`; }
  var supHtml = (a.supports||[]).slice(0,3).map(function(s){ return "<div class=\"sr-row\"><span class=\"sr-label up\">支撑</span><span class=\"sr-val\">" + formatPrice(s.price) + "</span></div>"; }).join("");
  var resHtml = (a.resistances||[]).slice(0,3).map(function(r){ return "<div class=\"sr-row\"><span class=\"sr-label down\">阻力</span><span class=\"sr-val\">" + formatPrice(r.price) + "</span></div>"; }).join("");
  var subPanels = document.getElementById("chartSubPanels");
  if (subPanels) subPanels.innerHTML = rrHtml + (supHtml+resHtml ? "<div class=\"sr-panel-mini\"><div class=\"sr-header\">支撑/阻力</div>" + (supHtml+resHtml) + "</div>" : "");
  const tfRows = a.tfData ? a.tfData.map(function(tf){
    // tfData 元素形状为 {interval, analysis:{score, rec, confidence}}（analyzeMultiTimeframe 生成）
    const an = tf.analysis || {};
    const tfName = String(tf.interval || tf.timeframe || "?").toUpperCase();
    const sc = (typeof an.score === "number") ? an.score : null;
    return "<div class=\"tf-row\">" +
      "<span class=\"tf-label\">" + escapeHtml(tfName) + "</span>" +
      "<span class=\"tf-score\" style=\"color:" + getScoreColor(sc || 0) + "\">" + (sc === null ? "--" : sc + "分 " + escapeHtml(an.rec || "")) + "</span>" +
      "</div>";
  }).join("") : "";
  const am = document.getElementById("analysisMain"); if(!am) return;
  const curPane = window.__anaActivePane || "p_concl"; // 重建后恢复用户当前所在标签页
  const paneCls = (id) => "ana-pane" + (curPane === id ? " active" : "");
  const tabBtn = (id, label) => "<button class=\"ana-tab" + (curPane === id ? " active" : "") + "\" data-pane=\"" + id + "\">" + label + "</button>";
  am.innerHTML = linkedBanner +
    "<div class=\"analysis-header\"><div class=\"ah-left\"><h3>" + escapeHtml(analysisPair.base) + "<span class=\"symbol\">/" + escapeHtml(analysisPair.quote) + "</span>" +
    "<span class=\"ana-star" + (isWatched(symbol) ? " on" : "") + "\" id=\"analysisStar\" title=\"" + (isWatched(symbol) ? "移出自选" : "加入自选") + "\" onclick=\"toggleWatch('" + escapeJsAttr(symbol) + "')\">" + (isWatched(symbol) ? "★" : "☆") + "</span></h3>" +
    "<div class=\"analysis-price\">" + formatPrice(a.price) + " <span class=\"change " + cc + "\">近24h " + (a.change>=0?"+":"") + a.change.toFixed(2) + "%</span></div></div>" +
    "<div class=\"ah-right\"><span class=\"ai-badge " + escapeHtml(displayBadge) + "\">" + escapeHtml(displayRec) + "</span><span class=\"ah-score\" style=\"color:" + getScoreColor(a.score) + "\">" + a.score + "<small>分</small></span></div></div>" +
    "<div class=\"ana-tabs\">" +
      tabBtn("p_concl", "AI 结论") +
      tabBtn("p_ind", "核心指标") +
      tabBtn("p_vp", "量价结构") +
      tabBtn("p_tf", "多周期与支撑阻力") +
      tabBtn("p_rr", "风险回报") +
      tabBtn("p_xcheck", "结论互证") +
      tabBtn("p_deriv", "资金面") +
      tabBtn("p_flow", "盘口与强平") +
      tabBtn("p_bt", "阈值回测") +
      tabBtn("p_size", "仓位计算") +
    "</div>" +
    "<div class=\"" + paneCls("p_concl") + "\" id=\"p_concl\"><div class=\"ai-analysis\">" +
    "<div class=\"ai-header\"><div class=\"ai-icon\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M12 2a7 7 0 0 1 7 7c0 3-2 5.5-3.5 7.5S12 20 12 20s-1.5-2-3.5-4S5 12 5 9a7 7 0 0 1 7-7z\"/><circle cx=\"12\" cy=\"9\" r=\"2\"/></svg></div><span class=\"ai-title\">AI 分析结论</span></div>" +
    "<div class=\"ai-score\"><div class=\"ai-score-bar\"><div class=\"ai-score-fill\" style=\"width:" + a.score + "%;background:" + getScoreColor(a.score) + "\"></div></div><span class=\"ai-score-num\" style=\"color:" + getScoreColor(a.score) + "\">" + a.score + "分</span></div>" +
    "<div class=\"ai-confidence\"><span class=\"conf-label\">信号置信度</span><span class=\"conf-value\" style=\"color:" + getScoreColor(a.confidence) + "\">" + a.confidence + "%</span></div>" +
    "<div class=\"ai-recommendation\"><span class=\"ai-trend\">多周期动能: " + escapeHtml(a.trendDir) + "</span></div>" +
    "<p class=\"ai-text\">" + escapeHtml(a.text) + "</p>" +
    "<div class=\"ai-factors\">" + signalsHtml + "</div>" +
    "</div></div>" +
    "<div class=\"" + paneCls("p_ind") + "\" id=\"p_ind\">" +
    "<div class=\"vote-panel\" id=\"votePanel\"></div>" +
    "<div class=\"indicators-grid\">" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">MA7</div><div class=\"indicator-value\" id=\"ind_ma7\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">MA25</div><div class=\"indicator-value\" id=\"ind_ma25\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">MA99</div><div class=\"indicator-value\" id=\"ind_ma99\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">MACD</div><div class=\"indicator-value\" id=\"ind_macd\">--</div><span class=\"indicator-signal\" id=\"ind_macd_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">MACD柱</div><div class=\"indicator-value\" id=\"ind_hist\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">RSI(14)</div><div class=\"indicator-value\" id=\"ind_rsi\">--</div><span class=\"indicator-signal\" id=\"ind_rsi_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">布林上轨</div><div class=\"indicator-value\" id=\"ind_bb_up\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">布林下轨</div><div class=\"indicator-value\" id=\"ind_bb_low\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">ADX</div><div class=\"indicator-value\" id=\"ind_adx\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">DI+</div><div class=\"indicator-value\" id=\"ind_pdi\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">DI-</div><div class=\"indicator-value\" id=\"ind_mdi\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">成交量比</div><div class=\"indicator-value\" id=\"ind_vol\">--</div></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">OBV 量价</div><div class=\"indicator-value\" id=\"ind_obv\">--</div><span class=\"indicator-signal\" id=\"ind_obv_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">KDJ (9,3,3)</div><div class=\"indicator-value\" id=\"ind_kdj\">--</div><span class=\"indicator-signal\" id=\"ind_kdj_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">VWAP (96)</div><div class=\"indicator-value\" id=\"ind_vwap\">--</div><span class=\"indicator-signal\" id=\"ind_vwap_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">布林 %B</div><div class=\"indicator-value\" id=\"ind_bbpb\">--</div><span class=\"indicator-signal\" id=\"ind_bbpb_sig\"></span></div>" +
      "<div class=\"indicator-card\"><div class=\"indicator-label\">布林带宽</div><div class=\"indicator-value\" id=\"ind_bbw\">--</div><span class=\"indicator-signal\" id=\"ind_bbw_sig\"></span></div>" +
    "</div></div>" +
    "<div class=\"" + paneCls("p_vp") + "\" id=\"p_vp\"><div id=\"vpWrap\"></div></div>" +
    "<div class=\"" + paneCls("p_tf") + "\" id=\"p_tf\">" + (tfRows ? "<div class=\"tf-rows\">" + tfRows + "</div>" : "<div class=\"ai-rr-placeholder\">暂无多周期数据</div>") +
      ((supHtml + resHtml) ? "<div class=\"sr-panel-mini\"><div class=\"sr-header\">支撑/阻力</div>" + (supHtml + resHtml) + "</div>" : "") + "</div>" +
    "<div class=\"" + paneCls("p_rr") + "\" id=\"p_rr\">" + rrHtml + "</div>" +
    "<div class=\"" + paneCls("p_xcheck") + "\" id=\"p_xcheck\"><div id=\"xcheckWrap\"></div></div>" +
    "<div class=\"" + paneCls("p_deriv") + "\" id=\"p_deriv\"><div id=\"derivWrap\"><div class=\"ai-rr-placeholder\">切换到本页签即加载资金面数据</div></div></div>" +
    "<div class=\"" + paneCls("p_flow") + "\" id=\"p_flow\"><div id=\"flowWrap\"><div class=\"ai-rr-placeholder\">切换到本页签即加载盘口 / 大额成交 / 强平数据</div></div></div>" +
    "<div class=\"" + paneCls("p_bt") + "\" id=\"p_bt\"><div id=\"btWrap\"><div class=\"ai-rr-placeholder\">切换到本页签即可对本币做阈值回测</div></div></div>" +
    "<div class=\"" + paneCls("p_size") + "\" id=\"p_size\"><div id=\"sizeWrap\"><div class=\"ai-rr-placeholder\">切换到本页签即可计算仓位</div></div></div>";
  if (lastAnalysisSymbol !== symbol) {
    lastAnalysisSymbol = symbol;
    // 销毁旧图表
    if (priceChart) { try { priceChart.remove(); } catch(e) {} priceChart = null; }
    if (macdChart) { try { macdChart.remove(); } catch(e) {} macdChart = null; }
    if (rsiChart) { try { rsiChart.remove(); } catch(e) {} rsiChart = null; }
    if (adxChart) { try { adxChart.remove(); } catch(e) {} adxChart = null; }
    window.__srLines = [];
    initChart(klines); setupFilters(klines);
  } else {
    updateChart(klines);
  }
  // Populate indicator cards
  var ind = a.indicators || {};
  var setInd = function(id, val, sigId, sigVal) {
    var el = document.getElementById(id);
    if (el) el.textContent = val || "--";
    if (sigId && sigVal) {
      var se = document.getElementById(sigId);
      if (se) { se.textContent = sigVal; se.className = "indicator-signal " + (sigVal==="看涨"||sigVal==="超买"?"buy":sigVal==="看跌"||sigVal==="超卖"?"sell":"neutral"); }
    }
  };
  setInd("ind_ma7", ind.ma7);
  setInd("ind_ma25", ind.ma25);
  setInd("ind_ma99", ind.ma99);
  setInd("ind_macd", ind.macd);
  setInd("ind_hist", ind.macdHist);
  setInd("ind_rsi", ind.rsi, "ind_rsi_sig", ind.rsi ? (parseFloat(ind.rsi)>70?"超买":parseFloat(ind.rsi)<30?"超卖":"中性") : "--");
  setInd("ind_bb_up", ind.bbUp);
  setInd("ind_bb_low", ind.bbLow);
  setInd("ind_adx", ind.adx);
  setInd("ind_pdi", ind.pdi);
  setInd("ind_mdi", ind.mdi);
  var volEl = document.getElementById("ind_vol");
  if (volEl && a.volRatio) volEl.textContent = a.volRatio.toFixed(1) + "x";
  // ---- 2026-10-09 第一步新增：量价结构 + 三维投票（展示用，不参与主 score）----
  // 优先用当前图表的 K 线；缺失时退回多周期基底周期 OHLC，保证 4 个调用路径都能算出结果。
  var __vpOhlc = (klines && klines.ohlc && klines.ohlc.length >= 20) ? klines.ohlc
    : (a.tfOhlc && a.tfOhlc[a.baseTf] && a.tfOhlc[a.baseTf].length >= 20) ? a.tfOhlc[a.baseTf] : null;
  var __vs = __vpOhlc ? computeVolumeStats(__vpOhlc) : null;
  if (__vs) {
    var setSig = function (sigId, txt, cls) {
      var se = document.getElementById(sigId);
      if (se) { se.textContent = txt; se.className = "indicator-signal " + cls; }
    };
    if (__vs.obv) { setInd("ind_obv", __vs.obv.state === "bull" ? "看涨" : __vs.obv.state === "bear" ? "看跌" : "中性"); setSig("ind_obv_sig", __vs.obv.note, __vs.obv.state === "bull" ? "buy" : __vs.obv.state === "bear" ? "sell" : "neutral"); }
    if (__vs.kdj) { setInd("ind_kdj", "K " + __vs.kdj.k.toFixed(1)); setSig("ind_kdj_sig", "D " + __vs.kdj.d.toFixed(1) + " / J " + __vs.kdj.j.toFixed(1), __vs.kdj.j > 100 ? "sell" : __vs.kdj.j < 0 ? "buy" : "neutral"); }
    if (__vs.vwap) { setInd("ind_vwap", formatPrice(__vs.vwap.value)); setSig("ind_vwap_sig", __vs.vwap.above ? "现价在上方 +" + __vs.vwap.dev.toFixed(2) + "%" : "现价在下方 " + __vs.vwap.dev.toFixed(2) + "%", __vs.vwap.above ? "buy" : "sell"); }
    if (__vs.bb) {
      setInd("ind_bbpb", __vs.bb.pctB.toFixed(2));
      setSig("ind_bbpb_sig", __vs.bb.pctB < 0.2 ? "贴近下轨" : __vs.bb.pctB > 0.8 ? "贴近上轨" : "通道中部", __vs.bb.pctB < 0.2 ? "buy" : __vs.bb.pctB > 0.8 ? "sell" : "neutral");
      setInd("ind_bbw", __vs.bb.width.toFixed(2) + "%");
      setSig("ind_bbw_sig", __vs.bb.width < 4 ? "带宽收窄（变盘临近）" : __vs.bb.width > 10 ? "带宽扩张（波动放大）" : "带宽正常", "neutral");
    }
  }
  renderVotesAndVolume(a, __vs);
  renderCrossCheck(a, __vs, __vpOhlc);
  // 若当前停留在「资金面」页签，换币后同步刷新该币的资金面（否则会一直显示上一个币的数据）
  if (window.__anaActivePane === "p_deriv") { try { renderDerivatives(symbol, true); } catch (e) {} }
  // 阈值回测同理：换币后重建表单（旧结果属于上一个币，不再展示；结果本身留在 __btResult 里可回看）
  if (window.__anaActivePane === "p_bt") { try { renderBacktest(symbol); } catch (e) {} }
  // 2026-10-09 第十批：仓位计算随换币刷新（入场/止损要跟着当前币走）；盘口与强平同理
  if (window.__anaActivePane === "p_size") { try { renderSizeCalc(symbol); } catch (e) {} }
  if (window.__anaActivePane === "p_flow") { try { renderFlowPane(symbol); } catch (e) {} }
}
// ---------- 日线趋势门控（做空推荐需日线同向下行：EMA20 < EMA50）----------
// 依据 bt/VERDICT_20261002_多空信号质量与做空改进.md：无门控整体收益/回撤 0.26（不可用），
// 1d 门控后 3.06（可用线以上）。日线数据拉取失败时保守放行，与回测门控行为一致。
function emaSeries(arr, n) { const k = 2 / (n + 1); const out = []; let e = null; for (let i = 0; i < arr.length; i++) { e = e === null ? arr[i] : arr[i] * k + e * (1 - k); out.push(e); } return out; }
window.__dailyTrendCache = window.__dailyTrendCache || {};
// 1007b：日线趋势统一取数（down=EMA20<EMA50 空头日；up=EMA20>EMA50 多头日；
// below20/above20=收盘价相对日线 EMA20 位置）。空/多门控共用一份缓存。
// 1007b 拐点修复：EMA 死叉/金叉是滞后指标，行情刚转空时价格已破 EMA20 但均线未死叉，
// 纯 EMA 交叉门控会在拐点期把空单全拦（20261007 实测：7 个空头候选 dailyOK 全 false）。
// 门控放宽为「EMA 交叉 或 收盘价破 EMA20」，emaOK/priceOK 分别记账供前向验证 A/B。
async function dailyTrendData(symbol) {
  const sym = symbol.endsWith("USDT") ? symbol : symbol + "USDT";
  const c = window.__dailyTrendCache[sym];
  if (c && Date.now() - c.ts < 30 * 60e3) return c; // 日线趋势变化慢，缓存 30 分钟
  let down = true, up = true, below20 = false, above20 = false; // 拉取失败时保守放行两侧，与回测门控行为一致
  try {
    const kl = await window.binanceAPI.getKlines(sym, "1d", 60);
    // 正在走的日线不参与（回测的 btDailyGateAt 也是只取已收盘日线，口径一致）
    const closes = (kl && Array.isArray(kl) && !kl.__error) ? dropOpenCandle(kl).map(k => parseFloat(k[4])) : [];
    if (closes.length >= 50) {
      const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
      const e20last = e20[e20.length - 1];
      down = e20last < e50[e50.length - 1];
      up = e20last > e50[e50.length - 1];
      const close = closes[closes.length - 1];
      below20 = close < e20last;
      above20 = close > e20last;
    }
  } catch (e) { console.warn("[app] dailyTrendData failed:", sym, e && e.message); }
  const d = { down, up, below20, above20, ts: Date.now() };
  window.__dailyTrendCache[sym] = d;
  return d;
}
// 空头门控放行：EMA 已死叉（成熟空头）或 收盘价已破日线 EMA20（拐点期新空头）
async function dailyShortOK(symbol) { const d = await dailyTrendData(symbol); return d.down || d.below20; }
// 多头门控放行：EMA 已金叉（成熟多头）或 收盘价站在日线 EMA20 上方（拐点期新多头）
async function dailyLongOK(symbol) { const d = await dailyTrendData(symbol); return d.up || d.above20; }
const RECOMMEND_CACHE_KEY = "novatrade.recommend-snapshot.v1";
const RECOMMEND_CACHE_MAX_AGE = 10 * 60e3;
function restoreRecommendationSnapshot(grid) {
  try {
    const cached = JSON.parse(localStorage.getItem(RECOMMEND_CACHE_KEY) || "null");
    if (!cached || !cached.html || Date.now() - cached.ts > RECOMMEND_CACHE_MAX_AGE || !cached.html.includes("recommend-card")) return false;
    grid.innerHTML = cached.html;
    grid.insertAdjacentHTML("afterbegin", `<div class="recommend-refresh-note" id="recommendRefreshNote">先显示上次结果，正在后台刷新 0%</div>`);
    renderLinkedSummary();
    return true;
  } catch(e) { return false; }
}
function saveRecommendationSnapshot(html) {
  try { localStorage.setItem(RECOMMEND_CACHE_KEY, JSON.stringify({ html, ts: Date.now() })); } catch(e) {}
}
function updateRecommendationProgress(grid, done, total, usingCache) {
  const pct = total ? Math.round(done / total * 100) : 100;
  if (usingCache) {
    const note = document.getElementById("recommendRefreshNote");
    if (note) note.textContent = `先显示上次结果，正在后台刷新 ${done}/${total}（${pct}%）`;
  } else {
    const p = grid.querySelector(".recommend-placeholder p");
    if (p) p.textContent = `正在分析币种 ${done}/${total}（${pct}%）`;
  }
}
function dailyTrendFromAnalysis(a) {
  const rows = a && a.tfOhlc && a.tfOhlc["1d"];
  if (!Array.isArray(rows) || rows.length < 50) return null;
  const closes = rows.map(k => Number(k[4])).filter(isFinite);
  if (closes.length < 50) return null;
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const e20last = e20[e20.length - 1], e50last = e50[e50.length - 1], close = closes[closes.length - 1];
  return { down:e20last < e50last, up:e20last > e50last, below20:close < e20last, above20:close > e20last, ts:Date.now() };
}
async function candidateDailyTrend(a) { return dailyTrendFromAnalysis(a) || dailyTrendData(a.symbol); }
// 1009 渐进渲染辅助：分组用 display:contents 包裹层，子项继续参与 .recommend-grid 布局，
// 每币完成即整组重渲染（10 币最多 10 次局部重绘，开销可忽略），不再等全部完成才出首屏
function ensureRecommendSkeleton(grid, usingCache) {
  const note = usingCache ? `<div class="recommend-refresh-note" id="recommendRefreshNote">正在后台刷新推荐</div>` : "";
  grid.innerHTML = note
    + `<div id="recBuyGroup" style="display:contents"></div>`
    + `<div id="recSellGroup" style="display:contents"></div>`
    + `<div id="recEndNote" style="display:contents"></div>`;
}
function renderRecommendGroup(groupId, list, dir, quality, blockedCount, gateNoteHtml) {
  const el = document.getElementById(groupId); if (!el) return;
  if (list.length === 0 && blockedCount === 0) { el.innerHTML = ""; return; }
  const title = dir === "buy" ? "📈" : "📉";
  const label = dir === "buy" ? (quality.actionable ? "看涨推荐" : "看涨观察") : (quality.actionable ? "看跌预警" : "看跌观察");
  const note = (gateNoteHtml || "");
  el.innerHTML = `<div class="recommend-card-header rec-group ${dir}"><h3>${title} ${label} (${list.length}个)${note}</h3></div>`
    + list.map(co => renderRecommendCard(co, quality)).join("");
}
async function renderRecommendations() { const grid = document.getElementById("recommendGrid"); if(!grid) return;
  const usingCache = !!grid.querySelector(".recommend-card") || restoreRecommendationSnapshot(grid);
  if (!usingCache) grid.innerHTML = "<div class=\"recommend-placeholder\"><p>正在准备推荐分析...</p></div>";
  btcAnalysis = await fetchBTCAnalysis();
  if (btcAnalysis && btcAnalysis.indicators) {
    const adxV = parseFloat(btcAnalysis.indicators.adx);
    if (isFinite(adxV)) window.__btcRegime = { score: btcAnalysis.score, adx: adxV, ts: Date.now() };
  }
  console.log("[app] renderRecommendations btcAnalysis:", btcAnalysis ? "ok" : "null");
  const topCoins = allCoins.filter(c => c.volume > 10000000).slice(0, 10);
  console.log("[app] renderRecommendations topCoins:", topCoins.length);
  updateRecommendationProgress(grid, 0, topCoins.length, usingCache);
  const analyses = [];
  const buyGateDetail = {}, sellGateDetail = {};
  const gatedBuySet = new Set(), gatedSellSet = new Set();
  const buyPool = [], sellPool = [];
  let overheatCount = 0, blockedBuy = 0, blockedSell = 0, skeletonReady = false;
  // 渐进插入：币完成 → 门控判定（candidateDailyTrend 优先复用 tfOhlc["1d"]，零额外请求）→ 入池 → 整组重渲染
  function progressiveRender() {
    if (!skeletonReady) { ensureRecommendSkeleton(grid, usingCache); skeletonReady = true; }
    const quality = fwdQualityStatus();
    const strongBuy = buyPool.sort((a,b) => b.score - a.score).slice(0, 6);
    const strongSell = sellPool.sort((a,b) => a.score - b.score).slice(0, 6);
    // 导出 CSV 用的快照：直接复用本次渲染出的两组数据，避免从 DOM 反解（DOM 里只有部分字段）
    window.__recGroups = { buy: strongBuy, sell: strongSell, quality, ts: Date.now() };
    const buyGateNote = (blockedBuy + overheatCount) > 0 ? `<span class="gate-note">另有 ${blockedBuy + overheatCount} 个多头信号被过热区/日线趋势过滤</span>` : "";
    const sellGateNote = blockedSell > 0 ? `<span class="gate-note">另有 ${blockedSell} 个空头信号被日线趋势过滤（EMA未死叉且价未破EMA20）</span>` : "";
    renderRecommendGroup("recBuyGroup", strongBuy, "buy", quality, (blockedBuy + overheatCount) > 0 ? 1 : 0, buyGateNote);
    renderRecommendGroup("recSellGroup", strongSell, "sell", quality, blockedSell > 0 ? 1 : 0, sellGateNote);
    const endNote = document.getElementById("recEndNote");
    if (endNote && strongBuy.length === 0 && strongSell.length === 0 && (blockedBuy + blockedSell + overheatCount) === 0) {
      endNote.innerHTML = "<div class=\"recommend-placeholder\"><p>暂无明显信号，建议观望</p></div>";
    } else if (endNote) endNote.innerHTML = "";
  }
  // 6 路币种并发（1009 配合主进程 keep-alive 连接池从 5 上调；fapi klines 权重 2/请求，
  // 40 请求 ≈ 80 weight，远低于 2400/min 限额）；币内 4 周期复用同批请求
  const CONCURRENCY = 6;
  let cursor = 0, completed = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, topCoins.length) }, async () => {
    while (cursor < topCoins.length) {
      const co = topCoins[cursor++];
      try {
        const a = await analyzeMultiTimeframe(co.symbol);
        if (!a) continue;
        const cIdx = allCoins.findIndex(c => c.symbol === co.symbol);
        if (cIdx >= 0) allCoins[cIdx].score = a.score;
        const merged = { ...co, ...a };
        analyses.push(merged);
        // 1007 过热区计数 + 双向门控（与收尾 recordFwdSignals 完全同源）
        if (merged.score >= OVERHEAT_MIN && merged.score < OVERHEAT_MAX) overheatCount++;
        if (merged.score >= SIGNAL_LONG_MIN && !(merged.score >= OVERHEAT_MIN && merged.score < OVERHEAT_MAX)) {
          try { const d = await candidateDailyTrend(merged); buyGateDetail[merged.symbol] = { emaOK: d.up, priceOK: d.above20 };
            if (d.up || d.above20) buyPool.push(merged); else { gatedBuySet.add(merged.symbol); blockedBuy++; } }
          catch (e) { buyPool.push(merged); }
        }
        if (merged.score < SHORT_SCORE_MIN) {
          try { const d = await candidateDailyTrend(merged); sellGateDetail[merged.symbol] = { emaOK: d.down, priceOK: d.below20 };
            if (d.down || d.below20) sellPool.push(merged); else { gatedSellSet.add(merged.symbol); blockedSell++; } }
          catch (e) { sellPool.push(merged); }
        }
        progressiveRender();
      } catch (err) { console.warn("[app] analyze failed:", co.symbol, err && err.message); }
      finally { completed++; updateRecommendationProgress(grid, completed, topCoins.length, usingCache); }
    }
  }));
  const valid = analyses;
  if (!skeletonReady) { ensureRecommendSkeleton(grid, usingCache); skeletonReady = true; progressiveRender(); }
  recordFwdSignals(valid, gatedSellSet, gatedBuySet, sellGateDetail, buyGateDetail); renderFwdStats();
  const quality = fwdQualityStatus();
  const bullCount = valid.filter(a => a.score >= SIGNAL_LONG_MIN).length;
  const bearCount = valid.filter(a => a.score < SHORT_SCORE_MIN).length;
  const tc=document.getElementById("totalCoins"); if(tc) tc.textContent = allCoins.length;
  const bc=document.getElementById("bullCount"); if(bc) bc.textContent = bullCount;
  const be=document.getElementById("bearCount"); if(be) be.textContent = bearCount;
  // 收尾：最终一致性渲染（排序/截断/gate-note 均以全量数据为准）
  progressiveRender();
  saveRecommendationSnapshot(grid.innerHTML);
  renderLinkedSummary();
}
const LINKED_STATE_KEY = "novatrade.linked-state.v1";
function loadLinkedState() {
  try {
    const s = JSON.parse(localStorage.getItem(LINKED_STATE_KEY) || "{}");
    return { alerts: Array.isArray(s.alerts) ? s.alerts : [], tracks: Array.isArray(s.tracks) ? s.tracks : [] };
  } catch(e) { return { alerts: [], tracks: [] }; }
}
function saveLinkedState(s) {
  try { localStorage.setItem(LINKED_STATE_KEY, JSON.stringify(s)); } catch(e) {}
}
function linkedToast(message) {
  let el = document.getElementById("linkedToast");
  if (!el) { el = document.createElement("div"); el.id = "linkedToast"; el.className = "linked-toast"; document.body.appendChild(el); }
  el.textContent = message; el.style.display = "block";
  clearTimeout(window.__linkedToastTimer);
  window.__linkedToastTimer = setTimeout(() => { el.style.display = "none"; }, 4200);
}
function linkedStateFor(symbol, direction, tradeBlocked) {
  const s = loadLinkedState();
  const alert = s.alerts.find(a => a.symbol === symbol && a.direction === direction && a.status !== "cancelled");
  // 同一币种+方向可能同时存在「已停止」的旧记录和重新加入的新记录；
  // 优先级：进行中 > 已达目标 > 已失效 > 已停止（此前用 find(status!=="cancelled")，
  // 会把「已停止」当成不存在，导致卡片回落显示为「已确认」，与明细表不一致）。
  const mine = s.tracks.filter(t => t.symbol === symbol && t.direction === direction);
  const track = mine.find(t => t.status === "active")
             || mine.find(t => t.status === "target")
             || mine.find(t => t.status === "invalid")
             || null;
  const stopped = mine.filter(t => t.status === "cancelled")
                      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))[0] || null;
  if (track && track.status === "target") return { label:"已达目标", cls:"target", alert, track };
  if (track && track.status === "invalid") return { label:"已失效", cls:"invalid", alert, track };
  if (track && track.status === "active") return { label:"模拟跟踪中", cls:"confirmed", alert, track };
  if (alert && alert.status === "confirmed") return { label:"已确认", cls:"confirmed", alert, track };
  if (alert && alert.status === "expired") return { label:"已过期", cls:"expired", alert, track };
  if (stopped) return { label:"已停止", cls:"expired", alert, track: null };
  return { label: tradeBlocked ? "等待确认" : "已确认", cls: tradeBlocked ? "waiting" : "confirmed", alert, track };
}
function renderLinkedSummary() {
  const stats = document.getElementById("fwdStats");
  if (!stats) return;
  let el = document.getElementById("linkedSummary");
  if (!el) { el = document.createElement("div"); el.id = "linkedSummary"; el.className = "linked-summary"; stats.insertAdjacentElement("afterend", el); }
  const s = loadLinkedState();
  const activeAlerts = s.alerts.filter(a => a.status === "active").length;
  const activeTracks = s.tracks.filter(t => t.status === "active").length;
  const targets = s.tracks.filter(t => t.status === "target").length;
  const invalid = s.tracks.filter(t => t.status === "invalid").length;
  const stopped = s.tracks.filter(t => t.status === "cancelled").length;
  el.innerHTML = `<strong>联动中心</strong><span class="linked-pill">价格提醒 ${activeAlerts}</span><span class="linked-pill">模拟跟踪 ${activeTracks}</span><span class="linked-pill">到达目标 ${targets}</span><span class="linked-pill">已失效 ${invalid}</span>`
    + (stopped ? `<span class="linked-pill">已停止 ${stopped}</span>` : "");
  renderLinkedDetail(s);
}
// 联动中心明细：把 checkLinkedFeatures 每 30 秒算出的 current/pnl 真正显示出来
// （此前这些字段只存进 localStorage，从未渲染 ⇒ 用户看不到模拟跟踪的后续）
function linkedTrackRow(t) {
  const isLong = t.direction === "long";
  const pnl = Number.isFinite(t.pnl) ? t.pnl : 0;
  const cur = (Number.isFinite(t.current) && t.current > 0) ? t.current : t.entry;
  const stLabel = t.status === "active" ? "跟踪中" : t.status === "target" ? "达目标" : t.status === "invalid" ? "已失效" : "已停止";
  const sign = pnl >= 0 ? "+" : "";
  const when = new Date(t.createdAt || Date.now()).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const op = t.status === "active"
    ? `<button type="button" onclick="cancelTrack('${escapeJsAttr(t.symbol)}','${t.direction}')">取消</button>`
    : `<span class="muted">—</span>`;
  return `<div class="linked-row">
    <span class="sym">${escapeHtml(t.symbol)}<em class="dir ${isLong ? "long" : "short"}">${isLong ? "多" : "空"}</em></span>
    <span>${formatPrice(t.entry)}</span>
    <span>${formatPrice(cur)}</span>
    <span class="pnl ${pnl >= 0 ? "up" : "down"}">${sign}${pnl.toFixed(2)}%</span>
    <span class="st ${t.status}">${stLabel}</span>
    <span class="when">${when}</span>
    <span class="op">${op}</span>
  </div>`;
}
function renderLinkedDetail(s) {
  const summaryEl = document.getElementById("linkedSummary");
  if (!summaryEl) return;
  let box = document.getElementById("linkedDetail");
  if (!box) { box = document.createElement("div"); box.id = "linkedDetail"; box.className = "linked-detail"; summaryEl.insertAdjacentElement("afterend", box); }
  const active = s.tracks.filter(t => t.status === "active");
  const closed = s.tracks.filter(t => t.status === "target" || t.status === "invalid").sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 10);
  // 「已停止」= 用户主动点「停止模拟」/「取消」的记录。此前这类记录被两个渲染函数一起过滤掉，
  // 界面上既不计入统计也不出现在明细里，看起来就像"数据凭空消失了"，其实一直存在 localStorage。
  const stopped = s.tracks.filter(t => t.status === "cancelled").sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 10);
  if (active.length === 0 && closed.length === 0 && stopped.length === 0) {
    box.innerHTML = `<div class="linked-empty">暂无模拟跟踪。在推荐卡片点「模拟跟踪」即可跟踪后续走势：每 30 秒更新现价与浮盈，达到目标 / 触发止损自动归档。</div>`;
    return;
  }
  let html = `<div class="linked-detail-head"><span>模拟跟踪明细 · 入场 / 现价 / 浮盈</span><button type="button" onclick="clearFinishedTracks()">清除已结束</button></div>`;
  html += `<div class="linked-row head"><span>币种</span><span>入场</span><span>现价</span><span>浮盈</span><span>状态</span><span>加入时间</span><span>操作</span></div>`;
  html += active.map(linkedTrackRow).join("");
  if (closed.length) { html += `<div class="linked-detail-sub">最近结束</div>` + closed.map(linkedTrackRow).join(""); }
  if (stopped.length) { html += `<div class="linked-detail-sub">已停止 / 已取消（${stopped.length}）</div>` + stopped.map(linkedTrackRow).join(""); }
  box.innerHTML = html;
}
function clearFinishedTracks() {
  const s = loadLinkedState();
  const removable = s.tracks.filter(t => t.status !== "active").length + s.alerts.filter(a => a.status !== "active").length;
  if (!removable) { linkedToast("没有已结束的记录可清除"); return; }
  // 这里是唯一的"真删除"入口：会把已达目标/已失效/已停止的记录从 localStorage 里彻底抹掉。
  // 之前没有二次确认，误点一下数据就永久没了，所以补上确认框。
  if (!confirm(`确定永久清除 ${removable} 条已结束记录吗？（已达目标 / 已失效 / 已停止，含价格提醒）\n此操作不可撤销。`)) return;
  s.tracks = s.tracks.filter(t => t.status === "active");
  s.alerts = s.alerts.filter(a => a.status === "active");
  saveLinkedState(s); renderLinkedSummary();
  linkedToast(`已清除 ${removable} 条已结束记录`);
}
// 从联动中心明细里直接取消某笔进行中的模拟跟踪（等价于卡片上的「停止模拟」）
function cancelTrack(symbol, direction) {
  const s = loadLinkedState();
  const t = s.tracks.find(x => x.symbol === symbol && x.direction === direction && x.status === "active");
  if (!t) return;
  t.status = "cancelled"; t.closedAt = Date.now();
  saveLinkedState(s); renderLinkedSummary(); renderRecommendations();
  linkedToast(`${symbol} 已取消模拟跟踪`);
}
async function openLinkedAnalysis(symbol, direction, score, confidence, timeframe) {
  window.__linkedSignalContext = { symbol, direction, score, confidence, timeframe };
  if (timeframe) {
    currentRange = timeframe;
    document.querySelectorAll(".time-btn").forEach(b => b.classList.toggle("active", b.dataset.range === timeframe));
  }
  await selectCoin(symbol);
  if (timeframe && timeframe !== "1h") {
    try {
      const [a, data] = await Promise.all([analyzeMultiTimeframe(symbol), fetchKlines(symbol, timeframe, 150)]);
      if (a && data.closes.length >= 30) renderAnalysis(symbol, a, data);
    } catch(e) { console.warn("[linked] timeframe load failed", e.message); }
  }
}
function createPriceAlert(symbol, direction, price) {
  const s = loadLinkedState();
  const triggerPrice = direction === "long" ? price * 1.01 : price * 0.99;
  s.alerts = s.alerts.filter(a => !(a.symbol === symbol && a.direction === direction && a.status === "active"));
  s.alerts.push({ symbol, direction, basePrice:price, triggerPrice, status:"active", createdAt:Date.now() });
  saveLinkedState(s); renderLinkedSummary();
  linkedToast(`${symbol} 已设置${direction === "long" ? "突破" : "跌破"}确认提醒：${formatPrice(triggerPrice)}`);
  renderRecommendations();
}
function togglePaperTrack(symbol, direction, entry, stopLoss, target) {
  const s = loadLinkedState();
  const active = s.tracks.find(t => t.symbol === symbol && t.direction === direction && t.status === "active");
  if (active) {
    active.status = "cancelled"; active.closedAt = Date.now();
    linkedToast(`${symbol} 已停止模拟跟踪`);
  } else {
    s.tracks.push({ symbol, direction, entry, stopLoss, target, current:entry, pnl:0, status:"active", createdAt:Date.now() });
    linkedToast(`${symbol} 已加入模拟跟踪，不会发送真实订单`);
  }
  saveLinkedState(s); renderLinkedSummary(); renderRecommendations();
}
function checkLinkedFeatures() {
  const s = loadLinkedState();
  let changed = false;
  const now = Date.now();
  s.alerts.forEach(a => {
    if (a.status !== "active") return;
    const coin = allCoins.find(c => c.symbol === a.symbol); if (!coin) return;
    if (now - a.createdAt > 4 * 3600e3) { a.status = "expired"; a.closedAt = now; changed = true; return; }
    const hit = a.direction === "long" ? coin.price >= a.triggerPrice : coin.price <= a.triggerPrice;
    if (hit) { a.status = "confirmed"; a.confirmedAt = now; a.confirmedPrice = coin.price; changed = true; linkedToast(`${a.symbol} 方向信号已确认，现价 ${formatPrice(coin.price)}`); pushNotify(`${a.symbol} 方向信号已确认`, `现价 ${formatPrice(coin.price)} · 触发价 ${formatPrice(a.triggerPrice)}`); }
  });
  s.tracks.forEach(t => {
    if (t.status !== "active") return;
    const coin = allCoins.find(c => c.symbol === t.symbol); if (!coin) return;
    t.current = coin.price;
    t.pnl = ((coin.price / t.entry - 1) * (t.direction === "long" ? 1 : -1) * 100);
    const targetHit = t.direction === "long" ? coin.price >= t.target : coin.price <= t.target;
    const stopHit = t.direction === "long" ? coin.price <= t.stopLoss : coin.price >= t.stopLoss;
    if (targetHit) { t.status = "target"; t.closedAt = now; changed = true; linkedToast(`${t.symbol} 模拟跟踪已达到目标`); pushNotify(`${t.symbol} 模拟跟踪已达目标 🎯`, `${t.direction === "long" ? "多" : "空"}单 入场 ${formatPrice(t.entry)} → 现价 ${formatPrice(coin.price)}，浮动 ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}%`); }
    else if (stopHit) { t.status = "invalid"; t.closedAt = now; changed = true; linkedToast(`${t.symbol} 模拟信号已失效`); pushNotify(`${t.symbol} 模拟跟踪已失效`, `${t.direction === "long" ? "多" : "空"}单 触发止损 ${formatPrice(t.stopLoss)}，浮动 ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}%`); }
  });
  saveLinkedState(s);
  renderLinkedSummary(); // 每 30 秒刷新现价/浮盈（此前仅在状态变化时刷新，浮盈长期不动）
}
function renderRecommendCard(c, quality) {
  const isBuy = c.badge.includes("buy");
  const directionCode = isBuy ? "long" : "short";
  const reasons = c.signals.filter(s => s.t === (isBuy ? "bull" : "bear")).slice(0,3).map(s => s.n).join("、");
  const sym = c.symbol;
  const pair = splitSymbol(sym);
  const symSafe = escapeHtml(sym);
  const bullish = c.bullish || 0;
  const bearish = c.bearish || 0;
  const lowConfidence = c.confidence < MIN_ACTION_CONFIDENCE;
  const gateBlocked = isVetoed(c);
  const performanceBlocked = !quality || !quality.actionable;
  const tradeBlocked = lowConfidence || gateBlocked || performanceBlocked;
  const direction = isBuy ? "偏多" : "偏空";
  const actionLabel = tradeBlocked ? direction + " · 暂不交易" : (isBuy ? "关注做多" : "关注做空");
  const actionClass = tradeBlocked ? "hold" : c.badge;
  const blockReasons = [];
  if (performanceBlocked) blockReasons.push(quality ? quality.label : "前向验证未达标");
  if (lowConfidence) blockReasons.push("置信度低于 " + MIN_ACTION_CONFIDENCE + "%");
  if (gateBlocked) blockReasons.push("风险门控已触发");
  const updated = new Date(c.fetchedAt || Date.now()).toLocaleTimeString("zh-CN", {hour:"2-digit", minute:"2-digit"});
  const rr = c.riskReward;
  const entry = Number(c.price);
  const stopLoss = rr && isFinite(Number(rr.stopLoss)) ? Number(rr.stopLoss) : (isBuy ? entry * 0.985 : entry * 1.015);
  const target = rr && rr.tps && rr.tps[0] ? Number(rr.tps[0].price) : (isBuy ? entry * 1.03 : entry * 0.97);
  const life = linkedStateFor(sym, directionCode, tradeBlocked);
  const tracking = !!(life.track && life.track.status === "active");
  const alerting = !!(life.alert && life.alert.status === "active");
  const riskHtml = !tradeBlocked && rr
    ? `<div class="recommend-card-risk"><span>入场 ${formatPrice(rr.entry)}</span><span>止损 ${formatPrice(rr.stopLoss)}</span><span>TP1 ${formatPrice(target)}</span><span>盈亏比 ${escapeHtml(rr.rr||"--")}</span></div>`
    : `<div class="recommend-card-action-note">${escapeHtml(blockReasons.join("；") || "当前条件不足，等待更明确的信号")}</div>`;
  return `<div class="recommend-card ${tradeBlocked ? "low-trust" : ""}" data-coin="${symSafe}" data-direction="${directionCode}" data-score="${c.score}" data-confidence="${c.confidence}" data-timeframe="${escapeHtml(c.baseTf || "4h")}">
    <div class="recommend-card-header">
      <div class="recommend-card-icon">${escapeHtml(pair.base.slice(0,2))}</div>
      <span class="recommend-card-badge ${escapeHtml(actionClass)}">${escapeHtml(actionLabel)}</span>
    </div>
    <div class="recommend-card-meta"><span class="signal-life ${life.cls}">${life.label}</span><span>更新 ${updated}</span></div>
    <h3>${escapeHtml(pair.base)}</h3><div class="symbol">/${escapeHtml(pair.quote)} · 15m/1h/4h 加权</div>
    <div class="recommend-card-price">${formatPrice(c.price)}</div>
    <div class="recommend-card-change ${c.change>=0?"up":"down"}">近24h ${c.change>=0?"▲":"▼"} ${Math.abs(c.change).toFixed(2)}%</div>
    <div class="recommend-card-score">
      <div class="score-bar"><div class="score-fill" style="width:${c.score}%;background:${getScoreColor(c.score)}"></div></div>
      <span class="score-label" style="color:${getScoreColor(c.score)}">信号强度 ${c.score}/100</span>
    </div>
    <div class="recommend-card-confidence">模型置信度 ${c.confidence}% · ${tradeBlocked ? "仅方向观察" : "风险参数已生成"}</div>
    <div class="recommend-card-signals"><span class="signal-bull">▲ ${bullish} 条看涨证据</span><span class="signal-bear">▼ ${bearish} 条看跌证据</span></div>
    <div class="recommend-card-reason">${escapeHtml(reasons || "暂无足够同向证据")}</div>
    ${riskHtml}
    <div class="recommend-card-actions">
      <button onclick="event.stopPropagation();openLinkedAnalysis('${escapeJsAttr(sym)}','${directionCode}',${Number(c.score)},${Number(c.confidence)},'${escapeJsAttr(c.baseTf || "4h")}')">联动分析</button>
      <button class="${alerting ? "active" : ""}" onclick="event.stopPropagation();createPriceAlert('${escapeJsAttr(sym)}','${directionCode}',${entry})">${alerting ? "已设提醒" : "确认提醒"}</button>
      <button class="${tracking ? "active" : ""}" onclick="event.stopPropagation();togglePaperTrack('${escapeJsAttr(sym)}','${directionCode}',${entry},${stopLoss},${target})">${tracking ? "停止模拟" : "模拟跟踪"}</button>
    </div>
  </div>`;
}


// ===== 主题 / 密度引擎：图表配色与整体主题联动 + 紧凑/舒适密度切换 =====
function cssVar(name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  catch (e) { return ""; }
}
function chartPalette() {
  var f = parseInt(cssVar("--chart-font-size"), 10);
  return {
    bg: cssVar("--chart-bg") || "#0b0b11",
    grid: cssVar("--chart-grid") || "rgba(255,255,255,0.035)",
    border: cssVar("--chart-border") || "rgba(255,255,255,0.09)",
    text: cssVar("--chart-text") || "#a3a4b6",
    up: cssVar("--chart-up") || "#16c784",
    down: cssVar("--chart-down") || "#ea3943",
    accent: cssVar("--chart-accent") || "#6366f1",
    ma7: cssVar("--chart-ma7") || "#f0a91b",
    rsi: cssVar("--chart-rsi") || "#a855f7",
    volUp: cssVar("--chart-vol-up") || "rgba(22,199,132,0.32)",
    volDown: cssVar("--chart-vol-down") || "rgba(234,57,67,0.32)",
    histUp: cssVar("--chart-hist-up") || "rgba(22,199,132,0.7)",
    histDown: cssVar("--chart-hist-down") || "rgba(234,57,67,0.7)",
    font: isFinite(f) && f > 0 ? f : 11
  };
}
// 图表基础配置：统一从令牌生成，避免各处硬编码
function chartBaseOptions(p, fontSize) {
  return {
    layout: { background: { type: "solid", color: p.bg }, textColor: p.text, fontSize: fontSize || p.font },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.border },
    timeScale: { borderColor: p.border, timeVisible: true, secondsVisible: false }
  };
}
// 主题切换后把新配色应用到已存在的图表实例
function applyChartTheme() {
  var p = chartPalette();
  var base = { layout: { background: { type: "solid", color: p.bg }, textColor: p.text, fontSize: p.font },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border } };
  [priceChart, macdChart, rsiChart, adxChart].forEach(function (ch) {
    if (!ch) return;
    try { ch.applyOptions(base); } catch (e) {}
  });
  var refs = window.__priceChartSeries || {};
  try { if (refs.candle) refs.candle.applyOptions({ upColor: p.up, downColor: p.down, borderUpColor: p.up, borderDownColor: p.down, wickUpColor: p.up, wickDownColor: p.down }); } catch (e) {}
  try { if (refs.ma7) refs.ma7.applyOptions({ color: p.ma7 }); } catch (e) {}
  try { if (refs.ma25) refs.ma25.applyOptions({ color: p.accent }); } catch (e) {}
  // 成交量柱：数据点自带颜色，需按方向重新着色
  try {
    if (refs.vol && window.__volMeta && window.__volMeta.length) {
      refs.vol.setData(window.__volMeta.map(function (d) {
        return { time: d.time, value: d.value, color: d.up ? p.volUp : p.volDown };
      }));
    }
  } catch (e) {}
  try {
    if (macdChart && macdChart.__series) {
      if (macdChart.__series.macd) macdChart.__series.macd.applyOptions({ color: p.accent });
      if (macdChart.__series.sig) macdChart.__series.sig.applyOptions({ color: p.ma7 });
      if (macdChart.__series.hist && window.__macdHistMeta && window.__macdHistMeta.length) {
        macdChart.__series.hist.setData(window.__macdHistMeta.map(function (d) {
          return { time: d.time, value: d.value, color: d.up ? p.histUp : p.histDown };
        }));
      }
    }
  } catch (e) {}
  try { if (rsiChart && rsiChart.__series && rsiChart.__series.rsi) rsiChart.__series.rsi.applyOptions({ color: p.rsi }); } catch (e) {}
}
// 密度：comfortable（默认）/ compact
var DENSITY_KEY = "novatrade_density";
function currentDensity() { return document.documentElement.getAttribute("data-density") || "comfortable"; }
function applyDensity(mode, persist) {
  mode = (mode === "compact") ? "compact" : "comfortable";
  document.documentElement.setAttribute("data-density", mode);
  if (persist) { try { localStorage.setItem(DENSITY_KEY, mode); } catch (e) {} }
  var btn = document.getElementById("densityToggle");
  var ico = document.getElementById("densityIco");
  var txt = document.getElementById("densityText");
  var compact = mode === "compact";
  if (btn) { btn.classList.toggle("active", compact); btn.title = compact ? "信息密度：紧凑（点击切回舒适）" : "信息密度：舒适（点击切换紧凑）"; }
  if (ico) ico.textContent = compact ? "▥" : "▤";
  if (txt) txt.textContent = compact ? "紧凑" : "舒适";
  // 容器尺寸由 CSS 令牌驱动，图表通过既有 ResizeObserver 自动跟随；这里只需重刷配色与字号
  applyChartTheme();
}
function toggleDensity() { applyDensity(currentDensity() === "compact" ? "comfortable" : "compact", true); }
window.toggleDensity = toggleDensity;
window.applyDensity = applyDensity;
window.applyChartTheme = applyChartTheme;

// ===== 系统通知：价格提醒 / 模拟跟踪触发时发 Windows 通知 =====
// 背景：窗口收进托盘后，应用内 toast 完全看不见（linkedToast 只是页面里的一个 div），
// 用户会漏掉「已确认 / 已达目标 / 已失效」这三类关键状态变化。
// 策略：
//   1. 走主进程 Notification（preload 暴露 electronAPI.notify），点通知会把窗口唤回前台；
//   2. 窗口在前台且已获得焦点时不再弹系统通知 —— 此时用户正看着界面，应用内 toast 已足够，
//      否则每次状态变化都会「toast + 系统通知」双响，属于打扰；
//   3. 开关持久化在 localStorage，默认开启。
var NOTIFY_KEY = "novatrade_notify";
function notifyEnabled() {
  try { return localStorage.getItem(NOTIFY_KEY) !== "0"; } catch (e) { return true; }
}
function applyNotifyUi() {
  var on = notifyEnabled();
  var btn = document.getElementById("notifyToggle");
  var ico = document.getElementById("notifyIco");
  var txt = document.getElementById("notifyText");
  if (btn) { btn.classList.toggle("muted", !on); btn.title = on ? "系统通知：已开启（点击关闭）" : "系统通知：已关闭（点击开启）"; }
  if (ico) ico.textContent = on ? "🔔" : "🔕";
  if (txt) txt.textContent = on ? "通知开" : "通知关";
}
function setNotifyEnabled(on) {
  try { localStorage.setItem(NOTIFY_KEY, on ? "1" : "0"); } catch (e) {}
  applyNotifyUi();
  linkedToast(on ? "系统通知已开启（窗口收进托盘也能收到提醒）" : "系统通知已关闭");
}
function toggleNotify() { setNotifyEnabled(!notifyEnabled()); }
// 统一出口：任何模块要发系统通知都走这里，避免各处重复判空 electronAPI
function pushNotify(title, body) {
  if (!notifyEnabled()) return false;
  // 前台且聚焦 ⇒ 用户正在看，跳过系统通知
  try {
    if (document.visibilityState === "visible" && typeof document.hasFocus === "function" && document.hasFocus()) return false;
  } catch (e) {}
  try {
    if (window.electronAPI && window.electronAPI.notify) {
      window.electronAPI.notify({ title: title || "NovaTrade", body: String(body || "") });
      return true;
    }
  } catch (e) { console.warn("[app] notify failed:", e && e.message); }
  return false;
}
window.toggleNotify = toggleNotify;
window.setNotifyEnabled = setNotifyEnabled;
window.pushNotify = pushNotify;
window.notifyEnabled = notifyEnabled;
try { if (typeof document !== "undefined" && document.getElementById) applyNotifyUi(); } catch (e) {}

// 顶层调用必须对「无 DOM 环境」安全（bt/backtest.js 用 vm 沙箱加载本文件）：
// 沙箱里 document.documentElement / localStorage 均不存在，原 catch 回退也会二次抛错 ⇒ 整个脚本加载失败。
try { if (typeof document !== "undefined" && document.documentElement) applyDensity(localStorage.getItem(DENSITY_KEY) || "comfortable", false); } catch (e) {}

function initChart(klines) {
  var container = document.getElementById("tvChart");
  if (!container) { console.error("[app] tvChart not found"); return; }
  if (typeof LightweightCharts === "undefined") { console.error("[app] LightweightCharts not loaded"); return; }
  var w = container.clientWidth || 800;
  var h = container.clientHeight || 320;
  if (w < 100 || h < 100) { container.style.width = "100%"; w = container.clientWidth || 800; h = container.clientHeight || 320; }
  if (macdChart) { try { macdChart.remove(); } catch(e) {} macdChart = null; }
  if (rsiChart) { try { rsiChart.remove(); } catch(e) {} rsiChart = null; }
  if (adxChart) { try { adxChart.remove(); } catch(e) {} adxChart = null; }
  // 主图同样需要先销毁旧实例，否则每次切换币种都会泄漏一个图表对象与其 ResizeObserver
  if (priceChart) { try { priceChart.remove(); } catch(e) {} priceChart = null; }
  window.__priceChartSeries = {};
  if (!klines || !klines.closes || klines.closes.length === 0) { console.warn("[app] No kline data"); return; }
  console.log("[app] initChart candles=" + (klines.closes||[]).length + " container=" + w + "x" + h);
  var ohlc = klines.ohlc || [];
  var ts = klines.timestamps || [];
  var candleData = ohlc.map(function(o, i) { return { time: Math.floor((ts[i] || 0) / 1000), open: o[1] || 0, high: o[2] || 0, low: o[3] || 0, close: o[4] || 0 }; });
  if (candleData.length < 2) return;
  var closes = klines.closes; 
  var volumes = ohlc.map(function(o) { return o[5] || 0; });

  // Main chart: Candlestick + MA + Volume（配色/字号统一来自主题令牌）
  var PAL = chartPalette();
  priceChart = LightweightCharts.createChart(container, Object.assign({
    width: container.clientWidth,
    height: 360
  }, chartBaseOptions(PAL), { crosshair: { mode: LightweightCharts.CrosshairMode.Normal } }));
  var cs = priceChart.addSeries(LightweightCharts.CandlestickSeries, {
    upColor: PAL.up, downColor: PAL.down,
    borderUpColor: PAL.up, borderDownColor: PAL.down,
    wickUpColor: PAL.up, wickDownColor: PAL.down
  });
  cs.setData(candleData);
  updateChartPriceFormat(priceChart, cs, candleData);

  // MA lines on main chart（滑动窗口 O(n)）
  var maTimes = candleData.map(function(d) { return d.time; });
  var ma7D = smaSeries(closes, maTimes, 7);
  var ma25D = smaSeries(closes, maTimes, 25);
  if (ma7D.length > 0) { var ma7S = priceChart.addSeries(LightweightCharts.LineSeries, { data: ma7D, color: PAL.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); if (window.__priceChartSeries) window.__priceChartSeries.ma7 = ma7S; }
  if (ma25D.length > 0) { var ma25S = priceChart.addSeries(LightweightCharts.LineSeries, { data: ma25D, color: PAL.accent, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); if (window.__priceChartSeries) window.__priceChartSeries.ma25 = ma25S; }

  // Volume histogram on main chart（记录方向元数据，便于主题切换时重新着色）
  var volColors = [];
  window.__volMeta = [];
  for (var i = 0; i < candleData.length; i++) {
    var isUp = candleData[i].close >= candleData[i].open;
    volColors.push({ time: candleData[i].time, color: isUp ? PAL.volUp : PAL.volDown, value: volumes[i] });
    window.__volMeta.push({ time: candleData[i].time, value: volumes[i], up: isUp });
  }
  var volHist = priceChart.addSeries(LightweightCharts.HistogramSeries, { data: volColors, priceFormat: { type: "volume" }, priceScaleId: "volume" });
  priceChart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  if (window.__priceChartSeries) window.__priceChartSeries.vol = volHist;

  // MACD chart
  var macdContainer = document.getElementById("macdChart");
  if (macdContainer) {
    var macdArr = [], sigArr = [], histArr = []; var ef=null, es=null, esig=0; 
    var ef = closes[0], es = closes[0], esig = 0;
    for (var i = 0; i < closes.length; i++) { if (ef===null) { ef=closes[i]; es=closes[i]; } else { ef=closes[i]*(2/13)+ef*(11/13); es=closes[i]*(2/27)+es*(25/27); } var m=ef-es; macdArr.push(m); esig=m*(2/10)+esig*(8/10); histArr.push(m-esig); sigArr.push(esig); } 
    macdChart = LightweightCharts.createChart(macdContainer, Object.assign({
      width: macdContainer.clientWidth,
      height: 100
    }, chartBaseOptions(PAL, PAL.font - 1)));
    var macdHistData = histArr.map(function(t,i){ return {time: candleData[i].time, value: histArr[i], color: histArr[i] >= 0 ? PAL.histUp : PAL.histDown}; });
    window.__macdHistMeta = histArr.map(function(t,i){ return { time: candleData[i].time, value: histArr[i], up: histArr[i] >= 0 }; });
    // 键名与 updateChart 的复用守卫保持一致（macd/sig/hist、rsi/ob/os、adx/ref）
    macdChart.__series = {
      macd: macdChart.addSeries(LightweightCharts.LineSeries, { data: macdArr.map(function(t,i){ return {time: candleData[i].time, value: macdArr[i]}; }), color: PAL.accent, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      sig: macdChart.addSeries(LightweightCharts.LineSeries, { data: sigArr.map(function(t,i){ return {time: candleData[i].time, value: sigArr[i]}; }), color: PAL.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      hist: macdChart.addSeries(LightweightCharts.HistogramSeries, { data: macdHistData, priceLineVisible: false, lastValueVisible: false })
    };
  }

  // RSI chart
  var rsiContainer = document.getElementById("rsiChart");
  if (rsiContainer) {
    var rsiArr = Indicators.RSI_Array(closes); 
    rsiChart = LightweightCharts.createChart(rsiContainer, Object.assign({
      width: rsiContainer.clientWidth,
      height: 100
    }, chartBaseOptions(PAL, PAL.font - 1)));
    rsiChart.__series = {
      rsi: rsiChart.addSeries(LightweightCharts.LineSeries, { data: rsiArr.map(function(t,i){ return i < candleData.length ? {time: candleData[i].time, value: rsiArr[i]} : null; }).filter(function(d){ return d !== null; }), color: PAL.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ob: rsiChart.addSeries(LightweightCharts.LineSeries, { data: candleData.map(function(d){ return {time: d.time, value: 70}; }), color: PAL.volDown, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }),
      os: rsiChart.addSeries(LightweightCharts.LineSeries, { data: candleData.map(function(d){ return {time: d.time, value: 30}; }), color: PAL.volUp, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    };
  }

  // ADX chart
  var adxContainer = document.getElementById("adxChart");
  if (adxContainer) {
    var adxArr = Indicators.ADX_Array(closes, 14, 14, ohlc);
    adxChart = LightweightCharts.createChart(adxContainer, Object.assign({
      width: adxContainer.clientWidth,
      height: 80
    }, chartBaseOptions(PAL, PAL.font - 1)));
    adxChart.__series = {
      adx: adxChart.addSeries(LightweightCharts.LineSeries, { data: adxArr.adx.map(function(t,i){ return i < candleData.length ? {time: candleData[i].time, value: adxArr.adx[i]} : null; }).filter(function(d){ return d !== null; }), color: PAL.accent, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      ref: adxChart.addSeries(LightweightCharts.LineSeries, { data: candleData.map(function(d){ return {time: d.time, value: 25}; }), color: PAL.ma7, lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    };
  }

  setTimeout(function() { if (priceChart) priceChart.timeScale().fitContent(); if (macdChart) macdChart.timeScale().fitContent(); if (rsiChart) rsiChart.timeScale().fitContent(); if (adxChart) adxChart.timeScale().fitContent(); }, 150);
  // ResizeObserver for all chart containers
  if (window.__chartRO) { try { window.__chartRO.disconnect(); } catch(e) {} window.__chartRO = null; }
  window.__chartRO = new ResizeObserver(function(entries) {
    for (var i = 0; i < entries.length; i++) {
      var el = entries[i].target;
      var nw = Math.floor(entries[i].contentRect.width);
      var nh = Math.floor(entries[i].contentRect.height);
      if (el.id === "tvChart" && priceChart) priceChart.applyOptions({width:nw,height:nh});
      else if (el.id === "macdChart" && macdChart) macdChart.applyOptions({width:nw,height:nh});
      else if (el.id === "rsiChart" && rsiChart) rsiChart.applyOptions({width:nw,height:nh});
      else if (el.id === "adxChart" && adxChart) adxChart.applyOptions({width:nw,height:nh});
    }
  });
  window.__priceChartSeries = { candle: cs, vol: null, ma7: null, ma25: null };
  window.__chartRO.observe(container);
  ["macdChart","rsiChart","adxChart"].forEach(function(id){var e=document.getElementById(id);if(e)window.__chartRO.observe(e);});
  console.log("[app] initChart done");
}
function updateChart(klines) {
  if (!priceChart || !klines || !klines.closes || klines.closes.length === 0) return;
  var ohlc = klines.ohlc || [];
  var ts = klines.timestamps || [];
  var candleData = ohlc.map(function(o, i) { return { time: Math.floor((ts[i] || 0) / 1000), open: o[1] || 0, high: o[2] || 0, low: o[3] || 0, close: o[4] || 0 }; });
  if (candleData.length < 2) return;
  var closes = klines.closes;
  var refs = window.__priceChartSeries || {};
  try { if (refs.candle) { refs.candle.setData(candleData); updateChartPriceFormat(priceChart, refs.candle, candleData); } } catch(e) {}
  // Update volume（配色取主题令牌，并记录方向元数据供主题切换重着色）
  var PAL = chartPalette();
  var volumes = ohlc.map(function(o){ return o[5]||0; });
  var volColors = [];
  window.__volMeta = [];
  for (var i=0;i<candleData.length;i++){
    var vu = candleData[i].close >= candleData[i].open;
    volColors.push({time:candleData[i].time,color:vu?PAL.volUp:PAL.volDown,value:volumes[i]});
    window.__volMeta.push({time:candleData[i].time,value:volumes[i],up:vu});
  }
  try { if (refs.vol) refs.vol.setData(volColors); } catch(e) {}
  // Update MA lines（滑动窗口 O(n)）
  var maTimes = candleData.map(function(d){ return d.time; });
  var ma7D = smaSeries(closes, maTimes, 7);
  var ma25D = smaSeries(closes, maTimes, 25);
  try{if(refs.ma7)refs.ma7.setData(ma7D);if(refs.ma25)refs.ma25.setData(ma25D);}catch(e){}
  // Update MACD sub-chart（缓存 series 引用，避免每次刷新都 removeAllSeries 重建导致闪烁与内存增长）
  try {
    if (macdChart) {
      var macdArr=[],sigArr=[],histArr=[];var ef=closes[0],es=closes[0],esig=0;
      for(var i=0;i<closes.length;i++){if(ef===null){ef=closes[i];es=closes[i];}else{ef=closes[i]*(2/13)+ef*(11/13);es=closes[i]*(2/27)+es*(25/27);}var m=ef-es;macdArr.push(m);esig=m*(2/10)+esig*(8/10);histArr.push(m-esig);sigArr.push(esig);}
      var macdData=macdArr.map(function(t,i){return{time:candleData[i].time,value:macdArr[i]};});
      var sigData=sigArr.map(function(t,i){return{time:candleData[i].time,value:sigArr[i]};});
      var histData=histArr.map(function(t,i){return{time:candleData[i].time,value:histArr[i],color:histArr[i]>=0?PAL.histUp:PAL.histDown};});
      window.__macdHistMeta = histArr.map(function(t,i){ return { time: candleData[i].time, value: histArr[i], up: histArr[i] >= 0 }; });
      if (!macdChart.__series) {
        macdChart.__series = {
          macd: macdChart.addSeries(LightweightCharts.LineSeries,{color:PAL.accent,lineWidth:1,priceLineVisible:false,lastValueVisible:false}),
          sig:  macdChart.addSeries(LightweightCharts.LineSeries,{color:PAL.ma7,lineWidth:1,priceLineVisible:false,lastValueVisible:false}),
          hist: macdChart.addSeries(LightweightCharts.HistogramSeries,{priceLineVisible:false,lastValueVisible:false})
        };
      }
      macdChart.__series.macd.setData(macdData);
      macdChart.__series.sig.setData(sigData);
      macdChart.__series.hist.setData(histData);
    }
  }catch(e){}
  // Update RSI sub-chart
  try {
    if (rsiChart) {
      var rsiArr = Indicators.RSI_Array(closes);
      var rsiData=rsiArr.map(function(t,i){return i<candleData.length?{time:candleData[i].time,value:rsiArr[i]}:null;}).filter(function(d){return d!==null;});
      if (!rsiChart.__series) {
        rsiChart.__series = {
          rsi: rsiChart.addSeries(LightweightCharts.LineSeries,{color:PAL.rsi,lineWidth:1,priceLineVisible:false,lastValueVisible:false}),
          ob:  rsiChart.addSeries(LightweightCharts.LineSeries,{color:PAL.volDown,lineWidth:1,lineStyle:2,priceLineVisible:false,lastValueVisible:false}),
          os:  rsiChart.addSeries(LightweightCharts.LineSeries,{color:PAL.volUp,lineWidth:1,lineStyle:2,priceLineVisible:false,lastValueVisible:false})
        };
      }
      rsiChart.__series.rsi.setData(rsiData);
      rsiChart.__series.ob.setData(candleData.map(function(d){return{time:d.time,value:70};}));
      rsiChart.__series.os.setData(candleData.map(function(d){return{time:d.time,value:30};}));
    }
  }catch(e){}
  // Update ADX sub-chart
  try {
    if (adxChart) {
      var adxArr = Indicators.ADX_Array(closes,14,14,ohlc);
      var adxData=adxArr.adx.map(function(t,i){return i<candleData.length?{time:candleData[i].time,value:adxArr.adx[i]}:null;}).filter(function(d){return d!==null;});
      if (!adxChart.__series) {
        adxChart.__series = {
          adx: adxChart.addSeries(LightweightCharts.LineSeries,{color:PAL.accent,lineWidth:1,priceLineVisible:false,lastValueVisible:false}),
          ref: adxChart.addSeries(LightweightCharts.LineSeries,{color:PAL.ma7,lineWidth:1,lineStyle:2,priceLineVisible:false,lastValueVisible:false})
        };
      }
      adxChart.__series.adx.setData(adxData);
      adxChart.__series.ref.setData(candleData.map(function(d){return{time:d.time,value:25};}));
    }
  }catch(e){}
  setTimeout(function(){if(priceChart)priceChart.timeScale().fitContent();},50);
}
function setupFilters(klines) {
  // 时间周期按钮统一由 document 级 click 委托处理（见文件底部监听），
  // 这里不再重复绑定，否则每次切换币种都会叠加监听导致一次点击多次请求
}

async function refreshAll() {
  await loadAllCoins(); checkLinkedFeatures();
  renderMarket(currentFilter);
  renderSidebar();
  await renderRecommendations();
  notifyWidget();
  if (selectedCoin) await loadAnalysis(selectedCoin);
}

document.addEventListener("click", function(e) {
  var card = e.target.closest("[data-coin]");
  if (card) {
    if (card.classList.contains("recommend-card")) {
      openLinkedAnalysis(card.dataset.coin, card.dataset.direction, card.dataset.score, card.dataset.confidence, card.dataset.timeframe);
    } else { selectCoin(card.dataset.coin); }
    return;
  }
  var btn = e.target.closest(".time-btn");
  if (btn) {
    document.querySelectorAll(".time-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const range = btn.dataset.range;
    currentRange = range;
    const interval = range==="1w"?"4h":range==="1d"?"1h":range==="4h"?"15m":range==="1h"?"1m":range==="15m"?"15m":"1m";
    // 结论源统一（1006）：图表可切周期，但中栏分析结论始终走多周期加权，与右栏/头部评级同源
    // 2026-10-10：锁定币种，避免等待期间切币后用错数据渲染（渲染闸门会再兜一次）
    const reqSym = selectedCoin;
    fetchKlines(reqSym, interval, 150).then(data => {
      return analyzeMultiTimeframe(reqSym).then(a => {
        if (a && data.closes.length >= 30) renderAnalysis(reqSym, a, data);
      });
    }).catch(function(e){console.error("[app] period fetch error:",e.message);});
    return;
  }
  var filterBtn = e.target.closest(".filter-btn");
  if (filterBtn) { filterMarket(filterBtn.textContent==="全部"?"all":filterBtn.textContent==="涨幅"?"gainers":filterBtn.textContent==="跌幅"?"losers":"volume"); return; }
});

document.addEventListener("DOMContentLoaded", async () => {
  // 每次初始化前先清掉上一轮的定时器，避免刷新/重复初始化导致任务叠加
  clearAppTimers();
  setupProxyUI();
  let retries = 0;
  while (!window.binanceAPI && retries < 30) { await new Promise(r => setTimeout(r, 100)); retries++; }
  if (!window.binanceAPI) { console.error("[app] binanceAPI 未就绪"); const el = document.getElementById("coinCount"); if (el) el.textContent = "连接失败"; return; }
  try {
    await loadAllCoins(); checkLinkedFeatures();
    updateStatus(true); renderMarket();
    renderSidebar();
    // 2026-10-09 第十批：预警徽标 / 托盘状态在首屏就同步一次
    try { alertUpdateBadge(); } catch(e) {}
    try { pushTrayStatus(); } catch(e) {}
    try { await initFwdValidation(); } catch(e) { console.error("[app] fwd init failed:", e); }
    await renderRecommendations();
    notifyWidget();
    await loadAnalysis("BTC");
    try { window.__trendIQReady = true; if (document.getElementById("trendiqAIAnalysis") && !trendiqCurrentSymbol) selectTrendIQCoin("BTC"); } catch(e) { console.error("[app] TrendIQ init failed:", e); }
    // widget creation disabled at startup to fix main window handle
  } catch(e) { console.error("启动失败:", e); const el = document.getElementById("coinCount"); if (el) el.textContent = "连接失败"; }
  appTimers.push(setInterval(async () => { await loadAllCoins(); checkLinkedFeatures(); renderMarket(currentFilter); renderSidebar(); try { checkAlerts(); } catch(e) {} try { pushTrayStatus(); } catch(e) {} try { if (document.getElementById("trendiqAIAnalysis") && !trendiqCurrentSymbol && window.__trendIQCoins && window.__trendIQCoins.length > 0) selectTrendIQCoin(window.__trendIQCoins[0].symbol); } catch(e) {} }, 30000));
  appTimers.push(setInterval(async () => {
    // 2026-10-10：先锁定币种再发请求。原来在 await 之后才读 selectedCoin，
    // 等待期间用户切币就会「新币名字 + 旧币数据」渲染 —— 这是「显示上一个缓存币种」的主因。
    const reqSym = selectedCoin;
    if (!reqSym || !document.getElementById("analysisMain")) return;
    // 结论源统一（1006）：无论图表周期，中栏结论始终走多周期加权；图表仍显示当前所选周期
    const interval = currentRange==="1w"?"4h":currentRange==="1d"?"1h":currentRange==="4h"?"15m":currentRange==="1h"?"1m":currentRange==="15m"?"15m":"1m";
    try {
      const [analysis, klines] = await Promise.all([analyzeMultiTimeframe(reqSym), fetchKlines(reqSym, interval, 150)]);
      if (analysis && klines.closes.length >= 30) renderAnalysis(reqSym, analysis, klines);
    } catch(e) { console.error("[app] analysis refresh error:", e.message); }
  }, 10000));
  appTimers.push(setInterval(async () => { await renderRecommendations(); notifyWidget(); }, 180000));
  appTimers.push(setInterval(async () => { await resolveFwdSignals(); renderFwdStats(); }, 600000));
  // TrendIQ 分析面板每 2 分钟跟随多周期结论自动刷新（图不动，只刷新右侧分析）
  let trendiqAnalysisBusy = false;
  appTimers.push(setInterval(async () => {
    if (!trendiqCurrentSymbol || trendiqAnalysisBusy || !document.getElementById("trendiqAIAnalysis")) return;
    trendiqAnalysisBusy = true;
    try { await loadTrendIQAnalysis(trendiqCurrentSymbol); } catch(e) {} finally { trendiqAnalysisBusy = false; }
  }, 120000));
  if (window.electronAPI && window.electronAPI.onWidgetCreated) {
    window.electronAPI.onWidgetCreated(() => { notifyWidget(); });
  }
  // 页面卸载时清理所有定时器
  window.addEventListener("beforeunload", clearAppTimers);
});
function renderRiskReward(symbol, a) {
  // 风险回报统一以多周期（4h 基底）结论为准
  const __mtfA = (window.__mtfCache||{})[symbol ? (symbol.endsWith("USDT")?symbol:symbol+"USDT") : ""];
  const rr = (__mtfA && __mtfA.data && __mtfA.data.riskReward) || a.riskReward;
  const sr = document.getElementById("riskRewardSection");
  if (!sr) return;
  if (!rr) {
    const neutralMsg = (a && isFinite(a.score))
      ? (a.stopCapVeto
          ? "止损距离超过 " + MAX_STOP_PCT + "% 上限 → 已否决，不提供 TP/SL"
          : a.overheatVeto
          ? "评分处于 70-74 过热区（前向验证 4h 命中率仅 14%）→ 已过滤，不提供 TP/SL"
          : (a.shortVeto || a.nearSupportVeto)
          ? "做空信号被门控过滤（BTC趋势偏多 或 距支撑<1ATR）→ 观望，不提供 TP/SL"
          : (a.score >= SHORT_SCORE_MIN && a.score < SIGNAL_LONG_MIN)
            ? "评分处于中性区间（39–64）→ 观望，无方向信号，不提供 TP/SL"
            : "切换币种查看风险回报")
      : "切换币种查看风险回报";
    sr.innerHTML = "<div class='rr-placeholder'>" + neutralMsg + "</div>";
    return;
  }
  const dirClass = rr.direction === "long" ? "buy" : "sell";
  const dirText = rr.direction === "long" ? "做多" : "做空";
  const tpItems = (rr.tps||[]).map(t=>"<div class='rr-item'><span class='rr-label'>"+t.label+" · "+t.rr+"</span><span class='rr-value buy'>"+formatPrice(t.price)+"</span></div>").join("");
  sr.innerHTML = "<div class='rr-header'>风险回报</div><div class='rr-grid'>" +
    "<div class='rr-item'><span class='rr-label'>方向</span><span class='rr-value " + dirClass + "'>" + dirText + "</span></div>" +
    "<div class='rr-item'><span class='rr-label'>入场</span><span class='rr-value'>" + formatPrice(rr.entry) + "</span></div>" +
    "<div class='rr-item'><span class='rr-label'>止损</span><span class='rr-value sell'>" + formatPrice(rr.stopLoss) + "</span></div>" +
    tpItems +
    "<div class='rr-item'><span class='rr-label'>盈亏比</span><span class='rr-value'>" + rr.rr + "</span></div>" +
    "<div class='rr-item'><span class='rr-label'>风险</span><span class='rr-value'>" + rr.riskPct + "</span></div>" +
    "</div>";
  const srPanel = document.getElementById("srPanel");
  if (!srPanel) return;
  // 多周期与支撑阻力：1h/4h/1d 各周期距现价最近的水位；无多周期数据时退回原展示
  let srPrice = null;
  if (a.livePrice > 0) srPrice = a.livePrice;
  else if (a.tfOhlc) { const bTf = a.tfOhlc[a.baseTf] || a.tfOhlc["1h"] || a.tfOhlc["4h"]; if (bTf && bTf.length) srPrice = bTf[bTf.length-1][4]; }
  const multiSr = srPrice !== null ? multiTfSrHtml(a.tfOhlc, srPrice) : "";
  srPanel.innerHTML = "<div class='sr-header'>支撑/阻力 · 1h/4h/1d 最近水位</div>" + (multiSr ||
    "<div class='sr-row'><span class='sr-label'>暂无数据</span></div>");
}

// 全局暴露函数
window.loadAllCoins = loadAllCoins;
window.fetchBTCAnalysis = fetchBTCAnalysis;
window.renderRecommendations = renderRecommendations;
window.loadAnalysis = loadAnalysis;
window.analyzeCoin = analyzeCoin;
window.renderAnalysis = renderAnalysis;
window.initChart = initChart;
window.selectCoin = selectCoin;
window.refreshAll = refreshAll;
window.fetchKlines = fetchKlines;
window.formatPrice = formatPrice;

// Enhanced analysis wrapper (defined after analyzeCoin is available)
function analyzeCoinEnhanced(closes, symbol, ohlc) {
  const result = analyzeCoin(closes, symbol, ohlc);
  const rawLevels = findSupportResistance(ohlc);
  const currentPrice = Number(result.price);
  const allLevels = (rawLevels.supports || []).concat(rawLevels.resistances || []);
  const supports = allLevels.filter(l => l.price < currentPrice).sort((a,b) => b.price - a.price);
  const resistances = allLevels.filter(l => l.price > currentPrice).sort((a,b) => a.price - b.price);
  const { uptrend, downtrend } = findTrendlines(ohlc);
  const rr = calcRiskReward(result, ohlc);
  result.supports = supports;
  result.resistances = resistances;
  result.trendlines = { uptrend, downtrend };
  result.riskReward = rr;
  // Add trend/signal/direction fields for TrendIQ display
  result.trend = result.score >= SIGNAL_LONG_MIN ? "上涨趋势" : result.score >= SHORT_SCORE_MIN ? "震荡" : "下跌趋势";
  result.signal = result.score >= SIGNAL_LONG_MIN ? "买入信号" : result.score >= SHORT_SCORE_MIN ? "中性" : "卖出信号";
  result.direction = result.trendDir || (result.score >= SIGNAL_LONG_MIN ? "看涨" : result.score >= SHORT_SCORE_MIN ? "震荡" : "看跌");
  result.reasons = (result.signals || []).slice(0, 5).map(function(s) { return s.n; });
  return result;
}
window.analyzeCoinEnhanced = analyzeCoinEnhanced;
// detectPatterns already overridden at line 952-953
console.log('[app] All modules loaded');
// ===== TrendIQ 分析模块 =====
let trendiqChart = null;
let trendiqVolChart = null;
let trendiqKlines = [];
let trendiqCurrentSymbol = null;
let trendiqCurrentPeriod = "1d";
const trendiqChartInstance = { _watched: false };

function initTrendIQChart() {
  console.log("[TrendIQ] initTrendIQChart called, trendiqChart:", trendiqChart);
  if (trendiqChart) {
    console.log("[TrendIQ] Chart already initialized, skipping");
    return;
  }
  const container = document.getElementById("trendiqChart");
  const volContainer = document.getElementById("trendiqVolChart");
  console.log("[TrendIQ] Container:", container);
  if (!container) { console.error("[TrendIQ] Container not found!"); return; }
  try {
    const PAL = chartPalette();
    trendiqChart = LightweightCharts.createChart(container, Object.assign({
      width: container.clientWidth,
      height: container.clientHeight || 380
    }, chartBaseOptions(PAL), {
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      timeScale: { borderColor: PAL.border, timeVisible: true, secondsVisible: false, rightOffset: 5 },
      handleScroll: { vertTouchDrag: false },
    }));
    const candleSeries = trendiqChart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: PAL.up, downColor: PAL.down, borderUpColor: PAL.up, borderDownColor: PAL.down,
      wickUpColor: PAL.up, wickDownColor: PAL.down,
    });
    const ma7 = trendiqChart.addSeries(LightweightCharts.LineSeries, { color: PAL.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma25 = trendiqChart.addSeries(LightweightCharts.LineSeries, { color: PAL.accent, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const ma99 = trendiqChart.addSeries(LightweightCharts.LineSeries, { color: PAL.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });

    // Volume chart (separate container below)
    let volSeries = null;
    if (volContainer) {
      trendiqVolChart = LightweightCharts.createChart(volContainer, {
        width: volContainer.clientWidth,
        height: volContainer.clientHeight || 120,
        layout: { background: { type: "solid", color: "transparent" }, textColor: PAL.text, fontSize: 10 },
        grid: { vertLines: { color: PAL.grid }, horzLines: { color: PAL.grid } },
        rightPriceScale: { borderColor: PAL.border },
        timeScale: { borderColor: PAL.border, timeVisible: true, secondsVisible: false, rightOffset: 5 },
        handleScroll: { vertTouchDrag: false },
      });
      volSeries = trendiqVolChart.addSeries(LightweightCharts.HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      });
      // Sync time scales: scroll/zoom one → other
      trendiqChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && trendiqVolChart) trendiqVolChart.timeScale().setVisibleLogicalRange(range);
      });
      trendiqVolChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range && trendiqChart) trendiqChart.timeScale().setVisibleLogicalRange(range);
      });
      // Sync crosshair
      trendiqChart.subscribeCrosshairMove((param) => {
        if (trendiqVolChart && param.time) trendiqVolChart.setCrosshairPosition(NaN, param.time, volSeries);
        else if (trendiqVolChart) trendiqVolChart.clearCrosshairPosition();
      });
      trendiqVolChart.subscribeCrosshairMove((param) => {
        if (trendiqChart && param.time) trendiqChart.setCrosshairPosition(NaN, param.time, candleSeries);
        else if (trendiqChart) trendiqChart.clearCrosshairPosition();
      });
    }

    window.__trendIQChart = trendiqChart;
    window.__trendIQSeries = { candle: candleSeries, ma7, ma25, ma99, vol: volSeries };
    window.__trendIQResize = () => {
      if (trendiqChart && container.clientWidth > 0) trendiqChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
      if (trendiqVolChart && volContainer && volContainer.clientWidth > 0) trendiqVolChart.applyOptions({ width: volContainer.clientWidth, height: volContainer.clientHeight });
    };
    const ro = new ResizeObserver(window.__trendIQResize);
    ro.observe(container);
    if (volContainer) ro.observe(volContainer);
    renderTrendIQCoinList();
    console.log("[TrendIQ] Coins available:", window.__trendIQCoins ? window.__trendIQCoins.length : 0);
    if (window.__trendIQCoins && window.__trendIQCoins.length > 0) {
      console.log("[TrendIQ] Selecting first coin:", window.__trendIQCoins[0].symbol);
      selectTrendIQCoin(window.__trendIQCoins[0].symbol);
    } else {
      console.warn("[TrendIQ] No coins available yet");
    }
  } catch (e) { console.error("[TrendIQ] initChart error:", e); }
}

window.__trendIQRendered = true; function renderTrendIQCoinList() {
  const list = document.getElementById("trendiqCoinList");
  if (!list) return;
  const coins = window.__trendIQCoins || [];
  list.innerHTML = coins.map(c => `<div class="trendiq-coin-item" data-symbol="${escapeHtml(c.symbol)}" onclick="selectTrendIQCoin('${escapeJsAttr(c.symbol)}')"><div class="trendiq-coin-symbol">${escapeHtml(c.symbol)}</div><div class="trendiq-coin-price">${formatPrice(c.price)} ${c.change >= 0 ? "&#9650;" : "&#9660;"} ${Math.abs(c.change||0).toFixed(2)}%</div></div>`).join("");
}

async function selectTrendIQCoin(symbol) {
  trendiqCurrentSymbol = symbol;
  trendiqCurrentPeriod = "1d";
  document.querySelectorAll(".trendiq-coin-item").forEach(el => el.classList.toggle("active", el.dataset.symbol === symbol));
  document.querySelectorAll(".trendiq-chart-toolbar .time-btn").forEach(b => b.classList.toggle("active", b.dataset.range === "1d"));
  // 图表已并入技术分析主图，仅刷新右侧综合研判面板
  if (trendiqChart) await loadTrendIQChart(symbol, "1d");
  await loadTrendIQAnalysis(symbol);
}

async function loadTrendIQChart(symbol, period) {
  console.log("[TrendIQ] loadTrendIQChart called for:", symbol, "period:", period);
  try {
    const sym = symbol.endsWith("USDT") ? symbol : symbol + "USDT";
    console.log("[TrendIQ] Fetching klines for:", sym, "interval:", period);
    const data = await window.binanceAPI.getKlines(sym, period, 200);
    console.log("[TrendIQ] Received", data ? data.length : 0, "candles");
    if (!Array.isArray(data) || data.length === 0) return;
    trendiqKlines = data;
    const candles = data.map(k => ({ time: Math.floor(k[0]/1000), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]) }));
    const closes = candles.map(c => c.close);
    if (window.__trendIQSeries) {
      window.__trendIQSeries.candle.setData(candles);
      // 与主图共用滑动窗口 SMA（O(n)），替代原先每个点 slice+求和的 O(n·period) 暴力写法
      const times = candles.map(c => c.time);
      window.__trendIQSeries.ma7.setData(smaSeries(closes, times, 7));
      window.__trendIQSeries.ma25.setData(smaSeries(closes, times, 25));
      window.__trendIQSeries.ma99.setData(smaSeries(closes, times, 99));
      const vols = data.map(k => ({ time: Math.floor(k[0]/1000), value: parseFloat(k[5]), color: parseFloat(k[4])>=parseFloat(k[1]) ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)" }));
      window.__trendIQSeries.vol.setData(vols);
      updateChartPriceFormat(trendiqChart, window.__trendIQSeries.candle, candles);
      trendiqChart.timeScale().fitContent();
    }
    document.title = symbol + " - NovaTrade TrendIQ";
  } catch(e) { console.error("[TrendIQ] loadChart error:", e); }
}

async function loadTrendIQAnalysis(symbol) {
  console.log("[TrendIQ] loadTrendIQAnalysis called for:", symbol);
  const aEl = document.getElementById("trendiqAIAnalysis");
  const srEl = document.getElementById("trendiqSR");
  const pEl = document.getElementById("trendiqPatterns");
  const rrEl = document.getElementById("trendiqRR");
  console.log("[TrendIQ] Elements:", { aEl: !!aEl, srEl: !!srEl, pEl: !!pEl, rrEl: !!rrEl });
  if (!aEl || !srEl || !pEl || !rrEl) {
    console.error("[TrendIQ] Missing elements!");
    return;
  }
  try {
    const sym = symbol.endsWith("USDT") ? symbol : symbol + "USDT";
    // 与"技术分析"页共用同一多周期加权结论，保证两个页面的趋势方向一致
    const analysis = await analyzeMultiTimeframe(symbol);
    if (!analysis) { aEl.innerHTML="<div class=trendiq-loading><p>数据不足</p></div>"; return; }
    const ohlc = (analysis.tfOhlc && (analysis.tfOhlc[analysis.baseTf] || analysis.tfOhlc["1h"] || analysis.tfOhlc["4h"] || analysis.tfOhlc["15m"])) || null;
    if (!ohlc || ohlc.length < 50) { aEl.innerHTML="<div class=trendiq-loading><p>数据不足</p></div>"; return; }
    const closes = ohlc.map(k => k[4]);
    const latest = isFinite(Number(analysis.price)) ? Number(analysis.price) : closes[closes.length-1];
    const prev = closes[closes.length-2];
    // 与主分析区使用同一份多周期快照，避免同屏出现两组现价/24h涨跌幅
    const chg = isFinite(Number(analysis.change)) ? Number(analysis.change) : ((latest-prev)/prev*100);
    const priceStr = formatPrice(latest);
    const chgStr = (chg>=0?"+":"") + chg.toFixed(2) + "%";
    const chgClass = chg>=0?"buy":"sell";
    // Trading Logic
    const logicEl = document.getElementById("trendiqLogic");
    if (logicEl) {
      var logicItems = [];
      if (analysis.trend) logicItems.push("趋势: " + analysis.trend);
      if (analysis.signal) logicItems.push("信号: " + analysis.signal);
      if (analysis.direction) logicItems.push("动能方向: " + analysis.direction);
      if (analysis.indicators) {
        if (analysis.indicators.macd) logicItems.push("MACD: " + (analysis.indicators.macd > 0 ? "多头" : "空头"));
        if (analysis.indicators.rsi && isFinite(parseFloat(analysis.indicators.rsi))) logicItems.push("RSI: " + parseFloat(analysis.indicators.rsi).toFixed(1));
      }
      if (analysis.reasons && analysis.reasons.length > 0) {
        analysis.reasons.slice(0,3).forEach(function(r) { logicItems.push(r); });
      }
      logicEl.innerHTML = logicItems.length > 0 
        ? "<ul class='trendiq-logic-list'>" + logicItems.map(function(l) { return "<li>" + l + "</li>"; }).join("") + "</ul>"
        : "<div class='trendiq-loading'><p>暂无数据</p></div>";
    }
    // AI Analysis panel：与推荐页使用同一可信度门槛
    const score = analysis.score || 0;
    const quality = fwdQualityStatus();
    const tradeBlocked = !quality.actionable || analysis.confidence < MIN_ACTION_CONFIDENCE || isVetoed(analysis);
    const rawSignal = analysis.signal || "中性";
    const direction = analysis.direction || "震荡";
    const signal = tradeBlocked ? (direction === "看涨" ? "偏多 · 暂不交易" : direction === "看跌" ? "偏空 · 暂不交易" : "观望") : rawSignal;
    const sigClass = tradeBlocked ? "" : (/买入|看涨/.test(signal) ? "buy" : (/卖出|看跌/.test(signal) ? "sell" : ""));
    const sigNeutralCls = sigClass === "" ? "neutral-signal" : "";
    const dirEmoji = direction==='看涨' ? '&#x1f4c8;' : (direction==='看跌' ? '&#x1f4c9;' : '&#x2796;');
    const sigNote = tradeBlocked ? ' · 前向验证或置信度未达标，仅观察' : ((sigClass === "" && direction !== '震荡') ? ' · 评分未达方向阈值，动能偏' + direction : '');
    aEl.innerHTML = `<div class="trendiq-entry-signal ${sigClass==='sell'?'sell-signal':''} ${sigNeutralCls}"><div class="trendiq-entry-label">多周期信号强度 ${score}分 · 置信度 ${analysis.confidence||0}%</div><div class="trendiq-entry-value ${sigClass}">${signal}</div><div class="trendiq-entry-sub">动能方向: ${dirEmoji} ${direction}${sigNote}</div></div>
      <div class="now-price-label">现价</div><div class="now-price">${priceStr} <span class="now-price-chg ${chgClass}">${chgStr}</span></div>`;
    // Support/Resistance：1h/4h/1d 各周期距现价最近的水位（阻力在上方、支撑在下方）
    srEl.innerHTML = multiTfSrHtml(analysis.tfOhlc, latest) || "<div class=trendiq-loading><p>暂无数据</p></div>";
    // Patterns
    const patterns = detectPatternsEnhanced(ohlc);
    pEl.innerHTML = (patterns||[]).slice(0,4).map(p => {
      const name = p.name || p.n || "";
      const desc = p.description || "";
      const dir = p.direction || (p.t==='bull'?'bullish':p.t==='bear'?'bearish':'neutral');
      return `<div class="trendiq-pattern-item"><div class="trendiq-pattern-name">${escapeHtml(name)}</div><div class="trendiq-pattern-desc">${escapeHtml(desc)}</div><span class="trendiq-pattern-signal ${dir==='bullish'?'bullish':'bearish'}">${dir==='bullish'?'看涨':'看跌'}</span></div>`;
    }).join("") || "<div class=trendiq-loading><p>暂无形态</p></div>";
    // Risk/Reward：与主区风险回报标签页共用同一份多周期结论（analysis.riskReward 已是 4h 基底）
    const rr = tradeBlocked ? null : (analysis.riskReward || calcRiskReward(analysis, ohlc));
    if (rr) {
    const rrDir = rr.direction === "long" ? "buy" : "sell";
    const rrDirText = rr.direction === "long" ? "做多" : "做空";
    const tpItems = (rr.tps||[]).map(t => `<div class="trendiq-rr-item"><div class="trendiq-rr-label">${t.label} · ${t.rr}</div><div class="trendiq-rr-value buy">${formatPrice(t.price)}</div></div>`).join("");
    rrEl.innerHTML = `<div class="trendiq-entry-signal ${rrDir==='sell'?'sell-signal':''}"><div class="trendiq-entry-label">建议方向</div><div class="trendiq-entry-value ${rrDir}">${rrDirText}</div></div>
      <div class="trendiq-rr-grid">
        <div class="trendiq-rr-item"><div class="trendiq-rr-label">入场</div><div class="trendiq-rr-value">${formatPrice(rr.entry)}</div></div>
        <div class="trendiq-rr-item"><div class="trendiq-rr-label">止损</div><div class="trendiq-rr-value sell">${formatPrice(rr.stopLoss)}</div></div>
        ${tpItems || `<div class="trendiq-rr-item"><div class="trendiq-rr-label">止盈</div><div class="trendiq-rr-value buy">${formatPrice(rr.takeProfit)}</div></div>`}
        <div class="trendiq-rr-item"><div class="trendiq-rr-label">盈亏比</div><div class="trendiq-rr-value">${rr.rr}</div></div>
        <div class="trendiq-rr-item span2"><div class="trendiq-rr-label">风险</div><div class="trendiq-rr-value">${rr.riskPct}</div></div>
      </div>`;
    } else {
      const neutralMsg = tradeBlocked
        ? "前向验证或置信度未达标，仅观察，不提供交易参数"
        : (analysis && isFinite(analysis.score))
          ? (analysis.stopCapVeto
              ? "止损距离超过 " + MAX_STOP_PCT + "% 上限 → 已否决，无方向信号"
              : analysis.overheatVeto
              ? "评分处于 70-74 过热区（前向验证 4h 命中率仅 14%）→ 已过滤，无方向信号"
              : (analysis.shortVeto || analysis.nearSupportVeto)
              ? "做空信号被门控过滤（BTC趋势偏多 或 距支撑<1ATR）→ 观望，无方向信号"
              : (analysis.score >= SHORT_SCORE_MIN && analysis.score < SIGNAL_LONG_MIN)
                ? "评分处于中性区间（39–64）→ 观望，无方向信号"
                : "暂无数据")
          : "暂无数据";
      rrEl.innerHTML = "<div class=trendiq-loading><p>" + neutralMsg + "</p></div>";
    }
  } catch(e) { console.error("[TrendIQ] analysis error:", e); }
}

// Period switching
document.addEventListener("click", function(e) {
  if (e.target.dataset.ti === "true" && trendiqCurrentSymbol) {
    const period = e.target.dataset.range;
    if (!period) return;
    document.querySelectorAll(".trendiq-chart-toolbar .time-btn").forEach(b => b.classList.remove("active"));
    e.target.classList.add("active");
    trendiqCurrentPeriod = period;
    loadTrendIQChart(trendiqCurrentSymbol, period);
  }
});

// Init on DOM ready
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ window.__trendIQReady = true; });
else window.__trendIQReady = true;

// Expose to window
// 滚动到可见区域时初始化
if (typeof IntersectionObserver !== 'undefined') {
  const tiqEl = document.getElementById("trendiqChart");
  if (tiqEl) {
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !trendiqChart) initTrendIQChart();
    }, { threshold: 0.1 });
    io.observe(tiqEl);
  }
}
function getPriceFormat(price) {
  var absP = Math.abs(price);
  if (absP >= 1000) return { type: 'price', precision: 2, minMove: 0.01 };
  if (absP >= 10) return { type: 'price', precision: 3, minMove: 0.001 };
  if (absP >= 1) return { type: 'price', precision: 4, minMove: 0.0001 };
  if (absP >= 0.01) return { type: 'price', precision: 6, minMove: 0.000001 };
  if (absP >= 0.001) return { type: 'price', precision: 7, minMove: 0.0000001 };
  return { type: 'price', precision: 8, minMove: 0.00000001 };
}
function updateChartPriceFormat(chart, series, data) {
  if (!chart || !series || !data || data.length === 0) return;
  var lastPrice = data[data.length - 1].close || data[data.length - 1].value || 0;
  if (lastPrice > 0) {
    try { series.applyOptions({ priceFormat: getPriceFormat(lastPrice) }); } catch(e) {}
  }
}
window.selectTrendIQCoin = selectTrendIQCoin;
window.loadTrendIQChart = loadTrendIQChart;
window.loadTrendIQAnalysis = loadTrendIQAnalysis;

/* ==================================================================================
   2026-10-09 第十批：「能加的都加上」——全部为只读分析/辅助功能
   【硬边界】本批不含任何下单、撤单、资金划转、实盘交易接口。应用定位始终是分析辅助工具。
   结构：① 主题切换  ② 全局快捷键  ③ 托盘状态  ④ 仓位/风险计算器  ⑤ 价格预警
        ⑥ 组合持仓  ⑦ 交易日志  ⑧ 资金面扩展（FNG/基差/深度/鲸鱼/爆仓）  ⑨ 回测深化
   ================================================================================== */

// ========== ① 主题切换（跟随系统 / 亮色 / 暗色）==========
var THEME_KEY = "novatrade_theme";
var THEME_MODES = ["system", "light", "dark"];
var THEME_LABEL = { system: "跟随系统", light: "亮色", dark: "暗色" };
var THEME_ICO = { system: "◐", light: "☀", dark: "☾" };
function getThemeMode() {
  try { var m = localStorage.getItem(THEME_KEY); return THEME_MODES.indexOf(m) >= 0 ? m : "system"; }
  catch (e) { return "system"; }
}
function systemPrefersLight() {
  try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches); }
  catch (e) { return false; }
}
// 应用主题；返回"实际生效"的主题（system 模式下解析成 light/dark）
function applyTheme() {
  var mode = getThemeMode();
  var effective = mode === "system" ? (systemPrefersLight() ? "light" : "dark") : mode;
  try {
    var el = document.documentElement;
    if (el && el.dataset) {
      if (mode === "system") { try { delete el.dataset.theme; } catch (e2) { el.removeAttribute("data-theme"); } }
      else el.dataset.theme = mode;
      // 供 canvas / 图表读取"实际生效"的主题（CSS 变量在 canvas 里读不到）
      el.dataset.themeResolved = effective;
    }
  } catch (e) {}
  try {
    var ico = document.getElementById("themeIco"), txt = document.getElementById("themeText");
    if (ico) ico.textContent = THEME_ICO[mode];
    if (txt) txt.textContent = THEME_LABEL[mode];
  } catch (e) {}
  return effective;
}
function currentThemeIsLight() {
  try {
    var el = document.documentElement;
    if (el && el.dataset && el.dataset.themeResolved) return el.dataset.themeResolved === "light";
  } catch (e) {}
  return false;
}
function cycleTheme() {
  var next = THEME_MODES[(THEME_MODES.indexOf(getThemeMode()) + 1) % THEME_MODES.length];
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  var eff = applyTheme();
  // 图表配色全部来自 CSS token，切换后必须重刷已有图表实例
  try { if (typeof applyChartTheme === "function") applyChartTheme(); } catch (e) {}
  try { if (typeof renderHeatmap === "function" && typeof allCoins !== "undefined" && allCoins && allCoins.length) renderHeatmap(); } catch (e) {}
  try { if (typeof renderAlerts === "function") renderAlerts(); } catch (e) {}
  try { if (typeof renderMine === "function") renderMine(); } catch (e) {}
  try {
    if (typeof linkedToast === "function") {
      linkedToast("主题：" + THEME_LABEL[next] + (next === "system" ? "（当前 " + (eff === "light" ? "亮色" : "暗色") + "）" : ""));
    }
  } catch (e) {}
  return next;
}
window.cycleTheme = cycleTheme;
window.getThemeMode = getThemeMode;
window.applyTheme = applyTheme;
window.currentThemeIsLight = currentThemeIsLight;
// system 模式下跟随系统主题变化
try {
  if (window.matchMedia) {
    var _themeMq = window.matchMedia("(prefers-color-scheme: light)");
    var _onSysTheme = function () {
      if (getThemeMode() !== "system") return;
      applyTheme();
      try { if (typeof applyChartTheme === "function") applyChartTheme(); } catch (e) {}
    };
    if (_themeMq.addEventListener) _themeMq.addEventListener("change", _onSysTheme);
    else if (_themeMq.addListener) _themeMq.addListener(_onSysTheme);
  }
} catch (e) {}
try { applyTheme(); } catch (e) {}

// ========== ② 全局快捷键 ==========
function focusCoinSearch() {
  try {
    showView("market");
    var f = document.getElementById("searchInput");
    if (f) { f.focus(); if (f.select) f.select(); }
  } catch (e) {}
}
var SHORTCUTS = [
  ["Ctrl / ⌘ + K", "搜索币种（跳到市场页并聚焦搜索框）"],
  ["Ctrl / ⌘ + R", "刷新全部数据"],
  ["Ctrl / ⌘ + E", "导出 AI 推荐 CSV"],
  ["Ctrl / ⌘ + P", "导出当前图表 PNG"],
  ["Ctrl / ⌘ + T", "切换主题（跟随系统 → 亮色 → 暗色）"],
  ["1 ~ 7", "切换主导航（市场 / 推荐 / 分析 / 联动 / 扫描 / 预警 / 我的）"],
  ["Esc", "关闭帮助浮层 / 退出输入框"],
  ["?", "显示本帮助"],
];
function showShortcuts() {
  try {
    var old = document.getElementById("kbdHelp");
    if (old) { old.remove(); return; }
    var rows = SHORTCUTS.map(function (r) {
      return '<div class="kbd-row"><span class="kbd">' + escapeHtml(r[0]) + '</span><span>' + escapeHtml(r[1]) + '</span></div>';
    }).join("");
    var d = document.createElement("div");
    d.id = "kbdHelp";
    d.className = "kbd-help";
    d.innerHTML = '<div class="kbd-help-box"><div class="kbd-help-head">键盘快捷键<span class="kbd-help-x" id="kbdHelpX">关闭</span></div>' + rows +
      '<div class="kbd-help-foot">输入框获得焦点时快捷键不生效（Esc 可退出输入框）</div></div>';
    document.body.appendChild(d);
    d.addEventListener("click", function (ev) {
      if (ev.target === d || (ev.target && ev.target.id === "kbdHelpX")) d.remove();
    });
  } catch (e) {}
}
window.showShortcuts = showShortcuts;
window.focusCoinSearch = focusCoinSearch;
try {
  document.addEventListener("keydown", function (e) {
    try {
      var t = e.target;
      var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing) {
        if (e.key === "Escape" && t.blur) t.blur();
        return;
      }
      if (e.key === "Escape") {
        var h = document.getElementById("kbdHelp");
        if (h) { h.remove(); e.preventDefault(); }
        return;
      }
      var mod = e.ctrlKey || e.metaKey;
      if (mod) {
        var k = String(e.key || "").toLowerCase();
        if (k === "k") { e.preventDefault(); focusCoinSearch(); return; }
        if (k === "r") { e.preventDefault(); if (typeof refreshAll === "function") refreshAll(); return; }
        if (k === "e") { e.preventDefault(); if (typeof exportRecommendCsv === "function") exportRecommendCsv(); return; }
        if (k === "p") { e.preventDefault(); if (typeof exportChartPng === "function") exportChartPng(); return; }
        if (k === "t") { e.preventDefault(); cycleTheme(); return; }
        return;
      }
      if (e.altKey) return;
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); showShortcuts(); return; }
      var navMap = { "1": "market", "2": "recommend", "3": "analysis", "4": "linkage", "5": "screener", "6": "alerts", "7": "mine" };
      if (navMap[e.key]) { e.preventDefault(); showView(navMap[e.key]); }
    } catch (err) {}
  });
} catch (e) {}

// ========== ③ 托盘状态（tooltip 显示当前分析币的涨跌；纯只读）==========
var _lastTrayText = "";
function pushTrayStatus() {
  try {
    if (!window.electronAPI || !window.electronAPI.setTrayStatus) return false;
    var parts = [];
    var sym = (typeof lastAnalysisSymbol !== "undefined" && lastAnalysisSymbol) ? lastAnalysisSymbol : "";
    if (sym) {
      var c = null;
      try { c = (allCoins || []).find(function (x) { return x.symbol === sym; }); } catch (e) {}
      if (c && isFinite(c.change)) {
        parts.push(String(sym).replace(/USDT$/, "") + " " + (c.change >= 0 ? "+" : "") + c.change.toFixed(2) + "%");
      }
    }
    try {
      var n = pendingAlertCount();
      if (n > 0) parts.push(n + " 条预警待触发");
    } catch (e) {}
    var txt = parts.length ? "NovaTrade · " + parts.join(" · ") + " · 单击显示" : "NovaTrade - 单击显示主窗口";
    if (txt === _lastTrayText) return true;
    _lastTrayText = txt;
    window.electronAPI.setTrayStatus(txt);
    return true;
  } catch (e) { return false; }
}
window.pushTrayStatus = pushTrayStatus;

// ========== ④ 仓位 / 风险计算器（纯本地算术，不请求接口、不下单）==========
var SIZE_KEY = "novatrade_size_cfg";
function sizeDefaults() { return { capital: 10000, riskPct: 1, entry: 0, stop: 0, dir: "long", lev: 10, fee: 0.1 }; }
function loadSizeCfg() {
  var c = null;
  try { c = JSON.parse(localStorage.getItem(SIZE_KEY) || "null"); } catch (e) {}
  var d = sizeDefaults();
  // 注意：目标必须是全新对象。写成 Object.assign(d, c) 会让 d 既是目标又是兜底来源，
  // 存储里的脏值会先污染 d，"回落默认"就落回脏值了（bt 那边踩过同一个坑）。
  var out = Object.assign({}, d, (c && typeof c === "object") ? c : {});
  ["capital", "riskPct", "entry", "stop", "lev", "fee"].forEach(function (k) {
    if (typeof out[k] !== "number" || !isFinite(out[k])) out[k] = d[k];
  });
  // 范围校验：0 杠杆、负手续费这类值"是数字"但会算出无意义的结果，必须挡掉
  if (!(out.capital > 0)) out.capital = d.capital;
  if (!(out.riskPct > 0) || out.riskPct > 100) out.riskPct = d.riskPct;
  if (!(out.lev >= 1)) out.lev = d.lev;
  if (!(out.fee >= 0)) out.fee = d.fee;
  if (!(out.entry >= 0)) out.entry = d.entry;
  if (!(out.stop >= 0)) out.stop = d.stop;
  if (out.dir !== "long" && out.dir !== "short") out.dir = d.dir;
  return out;
}
function saveSizeCfg(c) { try { localStorage.setItem(SIZE_KEY, JSON.stringify(c)); } catch (e) {} }
window.__sizeCfg = null;
function sizeCfg() { if (!window.__sizeCfg) window.__sizeCfg = loadSizeCfg(); return window.__sizeCfg; }
function sizeNum(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
function sizeMoney(v) {
  if (!isFinite(v)) return "--";
  var neg = v < 0; v = Math.abs(v);
  var parts = v.toFixed(2).split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + parts.join(".");
}
function sizeCompute(cfg) {
  var r = { ok: false, err: "", warn: [] };
  var cap = sizeNum(cfg.capital), rp = sizeNum(cfg.riskPct);
  var entry = sizeNum(cfg.entry), stop = sizeNum(cfg.stop);
  var lev = sizeNum(cfg.lev), fee = sizeNum(cfg.fee);
  var dir = cfg.dir === "short" ? "short" : "long";
  if (!(cap > 0)) { r.err = "请填写大于 0 的账户本金"; return r; }
  if (!(rp > 0) || rp > 100) { r.err = "单笔风险 % 应在 0 ~ 100 之间"; return r; }
  if (!(entry > 0)) { r.err = "请填写入场价"; return r; }
  if (!(stop > 0)) { r.err = "请填写止损价"; return r; }
  if (entry === stop) { r.err = "入场价与止损价不能相同"; return r; }
  if (!(lev >= 1)) { r.err = "杠杆应 ≥ 1"; return r; }
  if (!(fee >= 0)) fee = 0;
  // 方向与止损位置必须自洽，不一致时按止损位置纠正并提示
  if (dir === "long" && stop > entry) { dir = "short"; r.warn.push("止损价高于入场价，已按「做空」口径计算"); }
  else if (dir === "short" && stop < entry) { dir = "long"; r.warn.push("止损价低于入场价，已按「做多」口径计算"); }
  r.dir = dir;
  var stopDist = Math.abs(entry - stop);
  var stopDistPct = stopDist / entry * 100;
  var riskAmt = cap * rp / 100;                  // 计划允许亏损（不含手续费）
  var notional = riskAmt / (stopDistPct / 100);  // 名义价值
  var qty = notional / entry;
  var margin = notional / lev;
  var feeCost = notional * (fee / 100) * 2;      // 开 + 平双边
  var realRisk = riskAmt + feeCost;
  var beOffset = feeCost / qty;
  var breakEven = dir === "long" ? entry + beOffset : entry - beOffset;
  // 逐仓强平价（简化：未计维持保证金率与资金费）
  var liq = dir === "long" ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
  var tps = [1, 2, 3].map(function (n) {
    var p = dir === "long" ? entry + stopDist * n : entry - stopDist * n;
    var gross = riskAmt * n;
    return { n: n, price: p, gross: gross, net: gross - feeCost };
  });
  r.cap = cap; r.rp = rp; r.entry = entry; r.stop = stop; r.lev = lev; r.fee = fee;
  r.stopDist = stopDist; r.stopDistPct = stopDistPct;
  r.riskAmt = riskAmt; r.notional = notional; r.qty = qty; r.margin = margin;
  r.feeCost = feeCost; r.realRisk = realRisk; r.realRiskPct = realRisk / cap * 100;
  r.breakEven = breakEven; r.liq = liq; r.tps = tps;
  r.marginPct = margin / cap * 100;
  // 风险提示：这几种组合是真会亏钱的，不是装饰
  if (margin > cap) r.warn.push("所需保证金 " + sizeMoney(margin) + " 已超过本金 " + sizeMoney(cap) + " —— 杠杆不够，请减小仓位或提高杠杆");
  if (stopDistPct <= fee * 2) r.warn.push("止损距离仅 " + stopDistPct.toFixed(3) + "%，小于双边手续费 " + (fee * 2).toFixed(3) + "% —— 手续费会吃掉整个风险预算");
  var liqFirst = dir === "long" ? (liq > stop) : (liq < stop);
  if (liqFirst) r.warn.push("强平价 " + sizeMoney(liq) + " 比止损价 " + sizeMoney(stop) + " 更靠近入场价 —— 价格会先被强平而不是打到止损，请降杠杆或放宽止损");
  if (r.marginPct > 50) r.warn.push("保证金占本金 " + r.marginPct.toFixed(1) + "%，单笔占用偏重");
  r.ok = true;
  return r;
}
function sizeFormHtml(cfg) {
  function inp(k, label, step) {
    var v = (typeof cfg[k] === "number" && isFinite(cfg[k])) ? cfg[k] : "";
    return '<label>' + label + '<input type="number" step="' + (step || "any") + '" id="sz_' + k + '" value="' + v + '"></label>';
  }
  return '<div class="nf" id="sizeForm">' +
    inp("capital", "账户本金 (USDT)", "10") +
    inp("riskPct", "单笔风险 %", "0.1") +
    '<label>方向<select id="sz_dir"><option value="long"' + (cfg.dir === "long" ? " selected" : "") + '>做多</option><option value="short"' + (cfg.dir === "short" ? " selected" : "") + '>做空</option></select></label>' +
    inp("entry", "入场价") +
    inp("stop", "止损价") +
    inp("lev", "杠杆 (x)", "1") +
    inp("fee", "单边手续费 %", "0.01") +
    '<button class="btn-primary" onclick="sizeRecalc()">计算</button>' +
    '<button class="btn-ghost" onclick="sizeUseCurrent()">用当前分析带入</button>' +
    '<button class="btn-ghost" onclick="sizeReset()">重置</button>' +
    '</div>';
}
function sizeResultHtml(r) {
  if (!r.ok) return '<div class="empty-note" style="margin-top:var(--sp-4)">' + escapeHtml(r.err || "请填写完整参数") + '</div>';
  function item(label, value, cls, hl) {
    return '<div class="size-item' + (hl ? " hl" : "") + '"><div class="si-label">' + label + '</div><div class="si-value ' + (cls || "") + '">' + value + '</div></div>';
  }
  var warnHtml = r.warn.length ? '<div class="size-warn">' + r.warn.map(function (w) { return "⚠ " + escapeHtml(w); }).join("<br>") + '</div>' : "";
  var tpRows = r.tps.map(function (t) {
    return '<tr><td>' + t.n + 'R</td><td>' + formatPrice(t.price) + '</td><td class="up">+' + sizeMoney(t.gross) + '</td><td class="' + (t.net >= 0 ? "up" : "down") + '">' + (t.net >= 0 ? "+" : "") + sizeMoney(t.net) + '</td></tr>';
  }).join("");
  return '<div class="size-out" style="margin-top:var(--sp-4)">' +
    item("方向", r.dir === "long" ? "做多" : "做空", r.dir === "long" ? "up" : "down") +
    item("止损距离", r.stopDistPct.toFixed(3) + "%") +
    item("计划亏损", sizeMoney(r.riskAmt)) +
    item("仓位名义价值", sizeMoney(r.notional), "", true) +
    item("仓位数量", r.qty.toFixed(6)) +
    item("所需保证金", sizeMoney(r.margin)) +
    item("保证金占本金", r.marginPct.toFixed(2) + "%") +
    item("双边手续费", sizeMoney(r.feeCost)) +
    item("实际最大亏损", sizeMoney(r.realRisk) + " (" + r.realRiskPct.toFixed(2) + "%)", "down") +
    item("盈亏平衡价", formatPrice(r.breakEven)) +
    item("逐仓强平价(估)", formatPrice(r.liq), "down") +
    item("单笔亏损占本金", r.rp.toFixed(2) + "%") +
    '</div>' + warnHtml +
    '<div class="mini-title">分档目标（按 R 倍数）</div>' +
    '<div class="nt-wrap"><table class="nt"><thead><tr><th>档位</th><th>目标价</th><th>毛收益 (USDT)</th><th>净收益 (扣双边费)</th></tr></thead><tbody>' + tpRows + '</tbody></table></div>' +
    '<div class="size-note">' +
    '计算口径：仓位名义价值 = 计划亏损金额 ÷ 止损距离%；手续费按名义价值的单边 ' + r.fee + '% × 2 计入。<br>' +
    '「逐仓强平价」是简化估算（入场价 × (1 ∓ 1/杠杆)），<strong>未计维持保证金率与资金费</strong>，真实强平价会比这个更靠近入场价，请以交易所显示为准。<br>' +
    '<strong>本页只做仓位算术，不构成交易建议，也不产生任何下单动作。</strong>' +
    '</div>';
}
function sizeReadForm() {
  var g = function (id) { var el = document.getElementById(id); return el ? el.value : ""; };
  var cfg = sizeCfg();
  cfg.capital = sizeNum(g("sz_capital"));
  cfg.riskPct = sizeNum(g("sz_riskPct"));
  cfg.entry = sizeNum(g("sz_entry"));
  cfg.stop = sizeNum(g("sz_stop"));
  cfg.lev = sizeNum(g("sz_lev"));
  cfg.fee = sizeNum(g("sz_fee"));
  var d = document.getElementById("sz_dir");
  if (d) cfg.dir = d.value === "short" ? "short" : "long";
  saveSizeCfg(cfg);
  return cfg;
}
function sizePaint(cfg) {
  var wrap = document.getElementById("sizeWrap");
  if (!wrap) return;
  wrap.innerHTML = sizeFormHtml(cfg) + sizeResultHtml(sizeCompute(cfg));
}
function sizeRecalc() { sizePaint(sizeReadForm()); }
function sizeReset() {
  window.__sizeCfg = sizeDefaults();
  saveSizeCfg(window.__sizeCfg);
  sizePaint(window.__sizeCfg);
}
function sizeUseCurrent() {
  var sym = (typeof lastAnalysisSymbol !== "undefined" && lastAnalysisSymbol) ? lastAnalysisSymbol : "";
  var d = window.__lastAnalysisData;
  var rr = (d && d.a && d.a.riskReward) ? d.a.riskReward : null;
  var cfg = sizeReadForm();
  if (rr && isFinite(rr.entry) && isFinite(rr.stopLoss) && rr.entry > 0) {
    cfg.entry = rr.entry;
    cfg.stop = rr.stopLoss;
    cfg.dir = rr.stopLoss < rr.entry ? "long" : "short";
    saveSizeCfg(cfg);
    sizePaint(cfg);
    linkedToast("已带入 " + splitSymbol(sym).base + " 的入场 / 止损");
    return;
  }
  var c = null;
  try { c = (allCoins || []).find(function (x) { return x.symbol === sym; }); } catch (e) {}
  if (c && isFinite(c.price) && c.price > 0) {
    cfg.entry = c.price;
    saveSizeCfg(cfg);
    sizePaint(cfg);
    linkedToast("该币当前无风险回报参数（可能被门控拦截），已只带入现价，请手动填止损");
  } else {
    linkedToast("请先在「技术分析」里选中一个币种");
  }
}
function renderSizeCalc() {
  var wrap = document.getElementById("sizeWrap");
  if (!wrap) return;
  var cfg = sizeCfg();
  // 首次进入且还没填过入场价时，自动带入当前币的风险回报参数，省得手抄
  if (!(cfg.entry > 0)) {
    var d = window.__lastAnalysisData;
    var rr = (d && d.a && d.a.riskReward) ? d.a.riskReward : null;
    if (rr && isFinite(rr.entry) && isFinite(rr.stopLoss) && rr.entry > 0) {
      cfg.entry = rr.entry;
      cfg.stop = rr.stopLoss;
      cfg.dir = rr.stopLoss < rr.entry ? "long" : "short";
      saveSizeCfg(cfg);
    }
  }
  sizePaint(cfg);
}
window.renderSizeCalc = renderSizeCalc;
window.sizeRecalc = sizeRecalc;
window.sizeUseCurrent = sizeUseCurrent;
window.sizeReset = sizeReset;
window.sizeCompute = sizeCompute;
window.sizeDefaults = sizeDefaults;
window.loadSizeCfg = loadSizeCfg;

// ========== ⑤ 自定义价格预警（本地只读监控，命中即弹通知）==========
// 与「信号台账」里系统自动生成的跟踪提醒（alerts/tracks）完全独立：
// 这里存的是用户手设的条件，键名不同、生命周期不同、互不影响。
var ALERT_KEY = "novatrade_alerts_v1";
var ALERT_KINDS = ["above", "below", "chgUp", "chgDown"];
var ALERT_KIND_LABEL = { above: "价格 ≥", below: "价格 ≤", chgUp: "24h 涨幅 ≥", chgDown: "24h 跌幅 ≥" };
function alertId() { return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function loadAlerts() {
  var a = null;
  try { a = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"); } catch (e) { a = []; }
  if (!Array.isArray(a)) return [];
  return a.filter(function (x) {
    return x && typeof x === "object" && typeof x.symbol === "string" && x.symbol &&
      ALERT_KINDS.indexOf(x.kind) >= 0 && typeof x.value === "number" && isFinite(x.value);
  }).slice(0, 200);
}
function saveAlerts(a) { try { localStorage.setItem(ALERT_KEY, JSON.stringify((a || []).slice(0, 200))); } catch (e) {} }
function alertPendingCount() {
  return loadAlerts().filter(function (a) { return a.enabled && !a.triggeredAt; }).length;
}
function pendingAlertCount() { return alertPendingCount(); }
function alertUpdateBadge() {
  try {
    var b = document.getElementById("alertBadge");
    if (!b) return;
    var n = alertPendingCount();
    b.textContent = String(n);
    b.style.display = n > 0 ? "" : "none";
  } catch (e) {}
}
function alertCondText(a) {
  var v = ALERT_KIND_LABEL[a.kind] || "?";
  if (a.kind === "above" || a.kind === "below") return v + " " + formatPrice(a.value);
  return v + " " + Math.abs(a.value) + "%";
}
function alertAdd() {
  var g = function (id) { var el = document.getElementById(id); return el ? String(el.value || "").trim() : ""; };
  var sym = g("al_sym").toUpperCase();
  if (!sym) { linkedToast("请填写币种，例如 BTCUSDT"); return; }
  if (!/[A-Z0-9]{4,}$/.test(sym)) { linkedToast("币种格式看起来不对，应为 BTCUSDT 这种形式"); return; }
  var kind = g("al_kind") || "above";
  if (ALERT_KINDS.indexOf(kind) < 0) kind = "above";
  var val = parseFloat(g("al_val"));
  if (!isFinite(val) || val <= 0) { linkedToast("请填写大于 0 的目标值"); return; }
  if ((kind === "chgUp" || kind === "chgDown") && val > 100) { linkedToast("涨跌幅预警请填 0~100 之间的百分数"); return; }
  var list = loadAlerts();
  list.unshift({ id: alertId(), symbol: sym, kind: kind, value: val, note: g("al_note").slice(0, 60), enabled: true, createdAt: Date.now(), triggeredAt: 0 });
  saveAlerts(list);
  renderAlerts();
  linkedToast("已添加预警：" + splitSymbol(sym).base + " " + alertCondText({ kind: kind, value: val }));
  checkAlerts();   // 立刻判一次，避免"刚设完就满足"却要等 30 秒
}
function alertToggle(id) {
  var list = loadAlerts();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i].enabled = !list[i].enabled;
      if (list[i].enabled) list[i].triggeredAt = 0;   // 重新启用 = 重新武装
      break;
    }
  }
  saveAlerts(list);
  renderAlerts();
}
function alertRearm(id) {
  var list = loadAlerts();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) { list[i].enabled = true; list[i].triggeredAt = 0; list[i].hitDetail = ""; break; }
  }
  saveAlerts(list);
  renderAlerts();
  linkedToast("已重新武装该预警");
}
function alertRemove(id) {
  saveAlerts(loadAlerts().filter(function (a) { return a.id !== id; }));
  renderAlerts();
  linkedToast("已删除该预警");
}
function alertClearFired() {
  var before = loadAlerts().length;
  var left = loadAlerts().filter(function (a) { return !a.triggeredAt; });
  saveAlerts(left);
  renderAlerts();
  linkedToast("已清理 " + (before - left.length) + " 条已触发预警");
}
function alertUseCurrent() {
  var sym = (typeof lastAnalysisSymbol !== "undefined" && lastAnalysisSymbol) ? lastAnalysisSymbol : "";
  var c = null;
  try { c = (allCoins || []).find(function (x) { return x.symbol === sym; }); } catch (e) {}
  var symEl = document.getElementById("al_sym");
  if (symEl && sym) symEl.value = sym;
  var valEl = document.getElementById("al_val");
  if (valEl && c && isFinite(c.price) && c.price > 0) {
    // 默认给个"现价上方 2%"的做多突破提醒，用户可自行改
    valEl.value = String(+(c.price * 1.02).toFixed(6));
  }
  var kindEl = document.getElementById("al_kind");
  if (kindEl) kindEl.value = "above";
  linkedToast(sym ? "已带入 " + splitSymbol(sym).base + "，目标价默认为现价 +2%" : "请先在「技术分析」里选中一个币种");
}
function checkAlerts() {
  var list = loadAlerts();
  var now = Date.now();
  var fired = [];
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (!a.enabled || a.triggeredAt) continue;
    var c = null;
    try { c = (allCoins || []).find(function (x) { return x.symbol === a.symbol; }); } catch (e) {}
    if (!c) continue;
    var hit = false, detail = "";
    if (a.kind === "above" && isFinite(c.price) && c.price >= a.value) {
      hit = true; detail = "现价 " + formatPrice(c.price) + " ≥ " + formatPrice(a.value);
    } else if (a.kind === "below" && isFinite(c.price) && c.price <= a.value) {
      hit = true; detail = "现价 " + formatPrice(c.price) + " ≤ " + formatPrice(a.value);
    } else if (a.kind === "chgUp" && isFinite(c.change) && c.change >= a.value) {
      hit = true; detail = "24h " + (c.change >= 0 ? "+" : "") + c.change.toFixed(2) + "% ≥ " + a.value + "%";
    } else if (a.kind === "chgDown" && isFinite(c.change) && c.change <= -Math.abs(a.value)) {
      hit = true; detail = "24h " + c.change.toFixed(2) + "% ≤ -" + Math.abs(a.value) + "%";
    }
    if (hit) {
      a.triggeredAt = now;
      a.enabled = false;
      a.hitDetail = detail;
      fired.push({ a: a, detail: detail });
    }
  }
  if (!fired.length) return 0;
  saveAlerts(list);
  alertUpdateBadge();
  fired.forEach(function (f) {
    var base = splitSymbol(f.a.symbol).base;
    try { linkedToast(base + " 预警触发：" + f.detail); } catch (e) {}
    try { pushNotify(base + " 价格预警触发", f.detail + (f.a.note ? " · " + f.a.note : "")); } catch (e) {}
  });
  try {
    var v = document.getElementById("view-alerts");
    if (v && v.classList && v.classList.contains("active")) renderAlerts();
  } catch (e) {}
  return fired.length;
}
function checkAlertsNow() {
  var n = checkAlerts();
  linkedToast(n ? ("本次检查触发 " + n + " 条预警") : "本次检查没有预警被触发");
  renderAlerts();
}
function renderAlerts() {
  var formWrap = document.getElementById("alertFormWrap");
  var listWrap = document.getElementById("alertListWrap");
  if (!formWrap || !listWrap) return;
  formWrap.innerHTML =
    '<div class="nf" id="alertForm" style="margin-top:var(--sp-3)">' +
    '<label>币种<input type="text" id="al_sym" placeholder="BTCUSDT" style="min-width:130px"></label>' +
    '<label>条件<select id="al_kind">' +
    '<option value="above">价格 ≥ 目标</option>' +
    '<option value="below">价格 ≤ 目标</option>' +
    '<option value="chgUp">24h 涨幅 ≥ %</option>' +
    '<option value="chgDown">24h 跌幅 ≥ %</option>' +
    '</select></label>' +
    '<label>目标值<input type="number" step="any" id="al_val" placeholder="价格或百分数"></label>' +
    '<label>备注（可选）<input type="text" id="al_note" placeholder="例如：突破前高" style="min-width:170px"></label>' +
    '<button class="btn-primary" onclick="alertAdd()">添加预警</button>' +
    '</div>';
  var list = loadAlerts();
  if (!list.length) {
    listWrap.innerHTML = '<div class="empty-note" style="margin-top:var(--sp-4)">还没有自定义预警。上面填一个币种和条件，命中后会弹系统通知。</div>';
  } else {
    var active = list.filter(function (a) { return a.enabled && !a.triggeredAt; });
    var firedL = list.filter(function (a) { return !!a.triggeredAt; });
    var offL = list.filter(function (a) { return !a.enabled && !a.triggeredAt; });
    var rows = list.map(function (a) {
      var cls = a.triggeredAt ? "alert-row hit" : (a.enabled ? "alert-row" : "alert-row off");
      var state = a.triggeredAt
        ? '<span class="alert-state hit">已触发</span>'
        : (a.enabled ? '<span class="alert-state">监控中</span>' : '<span class="alert-state">已暂停</span>');
      var hitNote = a.triggeredAt && a.hitDetail ? '<div class="alert-cond" style="font-size:var(--fs-xs);color:var(--text-muted)">' + escapeHtml(a.hitDetail) + '</div>' : "";
      return '<div class="' + cls + '">' +
        '<span class="alert-sym">' + escapeHtml(splitSymbol(a.symbol).base) + '</span>' +
        '<div style="flex:1"><div class="alert-cond">' + escapeHtml(alertCondText(a)) +
        (a.note ? ' <span style="color:var(--text-muted)">· ' + escapeHtml(a.note) + '</span>' : '') + '</div>' + hitNote + '</div>' +
        state +
        (a.triggeredAt ? '<button class="btn-ghost" onclick="alertRearm(\'' + a.id + '\')">重新武装</button>' : '') +
        '<button class="btn-ghost" onclick="alertToggle(\'' + a.id + '\')">' + (a.enabled ? "暂停" : "启用") + '</button>' +
        '<button class="btn-danger-ghost" onclick="alertRemove(\'' + a.id + '\')">删除</button>' +
        '</div>';
    }).join("");
    listWrap.innerHTML =
      '<div class="mini-title">全部预警（' + list.length + '）· 监控中 ' + active.length + ' · 已触发 ' + firedL.length + ' · 已暂停 ' + offL.length +
      (firedL.length ? ' <button class="btn-danger-ghost" style="margin-left:auto" onclick="alertClearFired()">清理已触发</button>' : '') + '</div>' +
      rows;
  }
  alertUpdateBadge();
}
window.renderAlerts = renderAlerts;
window.alertAdd = alertAdd;
window.alertToggle = alertToggle;
window.alertRearm = alertRearm;
window.alertRemove = alertRemove;
window.alertClearFired = alertClearFired;
window.alertUseCurrent = alertUseCurrent;
window.checkAlerts = checkAlerts;
window.checkAlertsNow = checkAlertsNow;
window.alertPendingCount = alertPendingCount;
window.loadAlerts = loadAlerts;

// ========== ⑥ 组合持仓（本地手工记录，用只读行情算浮盈；不含任何下单能力）==========
var PORT_KEY = "novatrade_portfolio_v1";
function coinOf(sym) {
  try { return (allCoins || []).find(function (x) { return x.symbol === sym; }) || null; } catch (e) { return null; }
}
function loadPortfolio() {
  var a = null;
  try { a = JSON.parse(localStorage.getItem(PORT_KEY) || "[]"); } catch (e) { a = []; }
  if (!Array.isArray(a)) return [];
  return a.filter(function (x) {
    return x && typeof x === "object" && typeof x.symbol === "string" && x.symbol &&
      isFinite(Number(x.qty)) && Number(x.qty) > 0 &&
      isFinite(Number(x.entry)) && Number(x.entry) > 0;
  }).map(function (x) {
    return {
      id: x.id || ("p" + Math.random().toString(36).slice(2, 9)),
      symbol: String(x.symbol).toUpperCase(),
      side: x.side === "short" ? "short" : "long",
      qty: Number(x.qty),
      entry: Number(x.entry),
      lev: (isFinite(Number(x.lev)) && Number(x.lev) >= 1) ? Number(x.lev) : 1,
      openedAt: x.openedAt || Date.now(),
      note: typeof x.note === "string" ? x.note.slice(0, 60) : ""
    };
  }).slice(0, 200);
}
function savePortfolio(a) { try { localStorage.setItem(PORT_KEY, JSON.stringify((a || []).slice(0, 200))); } catch (e) {} }
function portRow(p) {
  var c = coinOf(p.symbol);
  var price = (c && isFinite(c.price) && c.price > 0) ? c.price : null;
  var notional = p.qty * p.entry;                 // 建仓成本（名义）
  var margin = notional / p.lev;
  var dirMul = p.side === "long" ? 1 : -1;
  var pnl = price === null ? null : (price - p.entry) * p.qty * dirMul;
  var pnlPctPrice = price === null ? null : (price / p.entry - 1) * 100 * dirMul;
  var pnlPctMargin = (pnl === null || margin <= 0) ? null : pnl / margin * 100;
  return {
    p: p, price: price, notional: notional, margin: margin,
    pnl: pnl, pnlPctPrice: pnlPctPrice, pnlPctMargin: pnlPctMargin,
    value: price === null ? notional : price * p.qty
  };
}
function portStats() {
  var rows = loadPortfolio().map(portRow);
  var s = { n: rows.length, notional: 0, margin: 0, value: 0, pnl: 0, longN: 0, shortN: 0, longNotional: 0, shortNotional: 0, missing: 0 };
  rows.forEach(function (r) {
    s.notional += r.notional; s.margin += r.margin; s.value += r.value;
    if (r.pnl === null) s.missing++; else s.pnl += r.pnl;
    if (r.p.side === "long") { s.longN++; s.longNotional += r.notional; }
    else { s.shortN++; s.shortNotional += r.notional; }
  });
  s.pnlPct = s.notional > 0 ? s.pnl / s.notional * 100 : 0;
  s.rows = rows;
  return s;
}
function portAdd() {
  var g = function (id) { var el = document.getElementById(id); return el ? String(el.value || "").trim() : ""; };
  var sym = g("pf_sym").toUpperCase();
  if (!sym) { linkedToast("请填写币种"); return; }
  var qty = parseFloat(g("pf_qty"));
  var entry = parseFloat(g("pf_entry"));
  if (!isFinite(qty) || qty <= 0) { linkedToast("数量要大于 0"); return; }
  if (!isFinite(entry) || entry <= 0) { linkedToast("成本价要大于 0"); return; }
  var lev = parseFloat(g("pf_lev"));
  if (!isFinite(lev) || lev < 1) lev = 1;
  var list = loadPortfolio();
  var side = g("pf_side") === "short" ? "short" : "long";
  list.unshift({ id: "p" + Date.now().toString(36), symbol: sym, side: side, qty: qty, entry: entry, lev: lev, openedAt: Date.now(), note: g("pf_note").slice(0, 60) });
  savePortfolio(list);
  renderMine();
  linkedToast("已记录持仓：" + splitSymbol(sym).base + " " + (side === "long" ? "多" : "空") + " " + qty);
}
function portRemove(id) {
  savePortfolio(loadPortfolio().filter(function (p) { return p.id !== id; }));
  renderMine();
  linkedToast("已删除该持仓");
}
function portClear() {
  var n = loadPortfolio().length;
  if (!n) { linkedToast("当前没有持仓记录"); return; }
  savePortfolio([]);
  renderMine();
  linkedToast("已清空 " + n + " 条持仓记录");
}
function portExportCsv() {
  var s = portStats();
  if (!s.rows.length) { linkedToast("没有持仓可导出"); return; }
  var rows = s.rows.map(function (r) {
    return [r.p.symbol, r.p.side === "long" ? "多" : "空", r.p.qty, r.p.entry, r.price === null ? "" : r.price,
      r.notional.toFixed(2), r.margin.toFixed(2), r.p.lev,
      r.pnl === null ? "" : r.pnl.toFixed(2), r.pnlPctPrice === null ? "" : r.pnlPctPrice.toFixed(3),
      new Date(r.p.openedAt).toISOString(), r.p.note];
  });
  var csv = toCsv(["币种", "方向", "数量", "成本价", "现价", "名义价值", "保证金", "杠杆", "浮动盈亏", "方向收益率%", "建仓时间", "备注"], rows);
  var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  downloadText("组合持仓_" + stamp + ".csv", csv);
}
function portHtml() {
  var s = portStats();
  var form =
    '<div class="nf" style="margin-bottom:var(--sp-4)">' +
    '<label>币种<input type="text" id="pf_sym" placeholder="BTCUSDT" style="min-width:130px"></label>' +
    '<label>方向<select id="pf_side"><option value="long">做多</option><option value="short">做空</option></select></label>' +
    '<label>数量<input type="number" step="any" id="pf_qty" style="min-width:110px"></label>' +
    '<label>成本价<input type="number" step="any" id="pf_entry" style="min-width:110px"></label>' +
    '<label>杠杆 (x)<input type="number" step="1" id="pf_lev" value="1" style="min-width:80px"></label>' +
    '<label>备注<input type="text" id="pf_note" style="min-width:140px"></label>' +
    '<button class="btn-primary" onclick="portAdd()">添加持仓</button>' +
    '</div>';
  if (!s.n) {
    return form + '<div class="empty-note">还没有持仓记录。这里只是把你自己的真实仓位记下来，用只读行情算浮盈和敞口 —— 不会连接任何交易所账户，也不会下单。</div>';
  }
  var pnlCls = s.pnl >= 0 ? "up" : "down";
  var cards =
    '<div class="port-cards">' +
    '<div class="port-card"><div class="pc-label">持仓笔数</div><div class="pc-value">' + s.n + '</div></div>' +
    '<div class="port-card"><div class="pc-label">名义价值合计</div><div class="pc-value">' + sizeMoney(s.notional) + '</div></div>' +
    '<div class="port-card"><div class="pc-label">浮动盈亏</div><div class="pc-value ' + pnlCls + '">' + (s.pnl >= 0 ? "+" : "") + sizeMoney(s.pnl) + '</div></div>' +
    '<div class="port-card"><div class="pc-label">方向收益率</div><div class="pc-value ' + pnlCls + '">' + (s.pnlPct >= 0 ? "+" : "") + s.pnlPct.toFixed(2) + '%</div></div>' +
    '<div class="port-card"><div class="pc-label">保证金占用</div><div class="pc-value">' + sizeMoney(s.margin) + '</div></div>' +
    '<div class="port-card"><div class="pc-label">多 / 空 笔数</div><div class="pc-value">' + s.longN + ' / ' + s.shortN + '</div></div>' +
    '</div>';
  var totalN = s.longNotional + s.shortNotional;
  var bar = totalN > 0
    ? '<div class="port-bar"><i style="width:' + (s.longNotional / totalN * 100).toFixed(2) + '%;background:var(--positive)"></i><i style="width:' + (s.shortNotional / totalN * 100).toFixed(2) + '%;background:var(--negative)"></i></div>' +
      '<div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">多头敞口 ' + (s.longNotional / totalN * 100).toFixed(1) + '% · 空头敞口 ' + (s.shortNotional / totalN * 100).toFixed(1) + '%</div>'
    : "";
  var warn = s.missing ? '<div class="port-warn">有 ' + s.missing + ' 个持仓的现价尚未加载（该币可能不在前 1489 个交易对里），暂未计入浮动盈亏</div>' : "";
  var rows = s.rows.map(function (r) {
    var dirMul = r.p.side === "long" ? 1 : -1;
    var cls = r.pnl === null ? "" : (r.pnl >= 0 ? "up" : "down");
    return '<tr>' +
      '<td>' + escapeHtml(splitSymbol(r.p.symbol).base) + '</td>' +
      '<td class="' + (r.p.side === "long" ? "up" : "down") + '">' + (r.p.side === "long" ? "多" : "空") + '</td>' +
      '<td>' + r.p.qty + '</td>' +
      '<td>' + formatPrice(r.p.entry) + '</td>' +
      '<td>' + (r.price === null ? "--" : formatPrice(r.price)) + '</td>' +
      '<td>' + sizeMoney(r.notional) + '</td>' +
      '<td>' + sizeMoney(r.margin) + '</td>' +
      '<td class="' + cls + '">' + (r.pnl === null ? "--" : (r.pnl >= 0 ? "+" : "") + sizeMoney(r.pnl)) + '</td>' +
      '<td class="' + cls + '">' + (r.pnlPctPrice === null ? "--" : (r.pnlPctPrice >= 0 ? "+" : "") + r.pnlPctPrice.toFixed(2) + "%") + '</td>' +
      '<td class="' + (r.pnlPctMargin === null ? "" : (r.pnlPctMargin >= 0 ? "up" : "down")) + '">' + (r.pnlPctMargin === null ? "--" : (r.pnlPctMargin >= 0 ? "+" : "") + r.pnlPctMargin.toFixed(1) + "%") + '</td>' +
      '<td style="color:var(--text-muted);font-size:var(--fs-xs)">' + escapeHtml(r.p.note || "") + '</td>' +
      '<td><button class="btn-danger-ghost" onclick="portRemove(\'' + r.p.id + '\')">删除</button></td>' +
      '</tr>';
  }).join("");
  return form + cards + bar + warn +
    '<div class="mini-title">持仓明细 <button class="btn-ghost" style="margin-left:auto" onclick="portExportCsv()">导出 CSV</button> <button class="btn-danger-ghost" onclick="portClear()">清空</button></div>' +
    '<div class="nt-wrap"><table class="nt"><thead><tr><th>币种</th><th>方向</th><th>数量</th><th>成本价</th><th>现价</th><th>名义价值</th><th>保证金</th><th>浮动盈亏</th><th>方向收益</th><th>保证金收益</th><th>备注</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<div class="size-note">浮动盈亏 = (现价 − 成本价) × 数量 × 方向；「保证金收益」按 名义价值 ÷ 杠杆 折算。全部为本地算术，未扣手续费与资金费。</div>';
}

// ========== ⑦ 交易日志 / 复盘（手工记录真实成交，和系统信号做对照）==========
var JR_KEY = "novatrade_journal_v1";
var JR_SRC_LABEL = { signal: "按信号做", manual: "自己判断", against: "逆信号做" };
function loadJournal() {
  var a = null;
  try { a = JSON.parse(localStorage.getItem(JR_KEY) || "[]"); } catch (e) { a = []; }
  if (!Array.isArray(a)) return [];
  return a.filter(function (x) {
    return x && typeof x === "object" && typeof x.symbol === "string" && x.symbol &&
      isFinite(Number(x.entry)) && Number(x.entry) > 0 &&
      isFinite(Number(x.exit)) && Number(x.exit) > 0 &&
      isFinite(Number(x.qty)) && Number(x.qty) > 0;
  }).map(function (x) {
    return {
      id: x.id || ("j" + Math.random().toString(36).slice(2, 9)),
      symbol: String(x.symbol).toUpperCase(),
      side: x.side === "short" ? "short" : "long",
      entry: Number(x.entry), exit: Number(x.exit), qty: Number(x.qty),
      fee: (isFinite(Number(x.fee)) && Number(x.fee) >= 0) ? Number(x.fee) : 0.1,
      src: JR_SRC_LABEL[x.src] ? x.src : "manual",
      closedAt: x.closedAt || Date.now(),
      note: typeof x.note === "string" ? x.note.slice(0, 80) : ""
    };
  }).slice(0, 500);
}
function saveJournal(a) { try { localStorage.setItem(JR_KEY, JSON.stringify((a || []).slice(0, 500))); } catch (e) {} }
function jrRow(t) {
  var dirMul = t.side === "long" ? 1 : -1;
  var gross = (t.exit - t.entry) * t.qty * dirMul;
  var feeCost = (t.entry + t.exit) * t.qty * (t.fee / 100);   // 开 + 平
  var net = gross - feeCost;
  var cost = t.entry * t.qty;
  return {
    t: t, gross: gross, feeCost: feeCost, net: net, cost: cost,
    pct: cost > 0 ? net / cost * 100 : 0,
    pctPrice: (t.exit / t.entry - 1) * 100 * dirMul,
    win: net > 0
  };
}
function jrStats(rows) {
  var s = { n: rows.length, wins: 0, loss: 0, net: 0, gross: 0, fee: 0, best: 0, worst: 0, avgWin: 0, avgLoss: 0, bySrc: {} };
  var winSum = 0, lossSum = 0;
  rows.forEach(function (r) {
    s.net += r.net; s.gross += r.gross; s.fee += r.feeCost;
    if (r.net > 0) { s.wins++; winSum += r.net; } else { s.loss++; lossSum += r.net; }
    if (r.net > s.best) s.best = r.net;
    if (r.net < s.worst) s.worst = r.net;
    var k = r.t.src;
    if (!s.bySrc[k]) s.bySrc[k] = { n: 0, wins: 0, net: 0 };
    s.bySrc[k].n++;
    if (r.net > 0) s.bySrc[k].wins++;
    s.bySrc[k].net += r.net;
  });
  s.winRate = s.n ? s.wins / s.n * 100 : 0;
  s.avgWin = s.wins ? winSum / s.wins : 0;
  s.avgLoss = s.loss ? lossSum / s.loss : 0;
  s.pf = lossSum !== 0 ? Math.abs(winSum / lossSum) : (winSum > 0 ? Infinity : 0);
  return s;
}
function jrAdd() {
  var g = function (id) { var el = document.getElementById(id); return el ? String(el.value || "").trim() : ""; };
  var sym = g("jr_sym").toUpperCase();
  var entry = parseFloat(g("jr_entry")), exit = parseFloat(g("jr_exit")), qty = parseFloat(g("jr_qty"));
  if (!sym) { linkedToast("请填写币种"); return; }
  if (!isFinite(entry) || entry <= 0) { linkedToast("入场价要大于 0"); return; }
  if (!isFinite(exit) || exit <= 0) { linkedToast("出场价要大于 0"); return; }
  if (!isFinite(qty) || qty <= 0) { linkedToast("数量要大于 0"); return; }
  var fee = parseFloat(g("jr_fee"));
  if (!isFinite(fee) || fee < 0) fee = 0.1;
  var list = loadJournal();
  list.unshift({
    id: "j" + Date.now().toString(36), symbol: sym,
    side: g("jr_side") === "short" ? "short" : "long",
    entry: entry, exit: exit, qty: qty, fee: fee,
    src: JR_SRC_LABEL[g("jr_src")] ? g("jr_src") : "manual",
    closedAt: Date.now(), note: g("jr_note").slice(0, 80)
  });
  saveJournal(list);
  renderMine();
  linkedToast("已记录一笔平仓交易");
}
function jrRemove(id) {
  saveJournal(loadJournal().filter(function (t) { return t.id !== id; }));
  renderMine();
  linkedToast("已删除该记录");
}
function jrClear() {
  var n = loadJournal().length;
  if (!n) { linkedToast("当前没有交易记录"); return; }
  saveJournal([]);
  renderMine();
  linkedToast("已清空 " + n + " 条交易记录");
}
function jrExportCsv() {
  var list = loadJournal();
  if (!list.length) { linkedToast("没有交易记录可导出"); return; }
  var rows = list.map(function (t) {
    var r = jrRow(t);
    return [new Date(t.closedAt).toISOString(), t.symbol, t.side === "long" ? "多" : "空",
      t.entry, t.exit, t.qty, t.fee, r.gross.toFixed(2), r.feeCost.toFixed(2), r.net.toFixed(2),
      r.pctPrice.toFixed(3), r.pct.toFixed(3), JR_SRC_LABEL[t.src], t.note];
  });
  var csv = toCsv(["平仓时间", "币种", "方向", "入场价", "出场价", "数量", "单边手续费%", "毛盈亏", "手续费", "净盈亏", "价格变动%", "净收益率%", "来源", "备注"], rows);
  var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  downloadText("交易日志_" + stamp + ".csv", csv);
}
function jrHtml() {
  var list = loadJournal();
  var rows = list.map(jrRow);
  var s = jrStats(rows);
  var form =
    '<div class="nf" style="margin-bottom:var(--sp-4)">' +
    '<label>币种<input type="text" id="jr_sym" placeholder="BTCUSDT" style="min-width:130px"></label>' +
    '<label>方向<select id="jr_side"><option value="long">做多</option><option value="short">做空</option></select></label>' +
    '<label>入场价<input type="number" step="any" id="jr_entry" style="min-width:110px"></label>' +
    '<label>出场价<input type="number" step="any" id="jr_exit" style="min-width:110px"></label>' +
    '<label>数量<input type="number" step="any" id="jr_qty" style="min-width:100px"></label>' +
    '<label>单边手续费 %<input type="number" step="0.01" id="jr_fee" value="0.1" style="min-width:90px"></label>' +
    '<label>这笔的来源<select id="jr_src"><option value="signal">按信号做</option><option value="manual">自己判断</option><option value="against">逆信号做</option></select></label>' +
    '<label>备注<input type="text" id="jr_note" style="min-width:150px"></label>' +
    '<button class="btn-primary" onclick="jrAdd()">记录一笔</button>' +
    '</div>';
  if (!s.n) {
    return form + '<div class="empty-note">还没有交易记录。把你真实做过的单子记进来，就能看出「按信号做」和「自己判断」哪个更赚钱 —— 这是这个页面唯一的目的。</div>';
  }
  var netCls = s.net >= 0 ? "up" : "down";
  var pfTxt = s.pf === Infinity ? "∞" : s.pf.toFixed(2);
  var cards =
    '<div class="port-cards">' +
    '<div class="port-card"><div class="pc-label">总笔数</div><div class="pc-value">' + s.n + '</div></div>' +
    '<div class="port-card"><div class="pc-label">胜率</div><div class="pc-value">' + s.winRate.toFixed(1) + '%</div></div>' +
    '<div class="port-card"><div class="pc-label">净盈亏</div><div class="pc-value ' + netCls + '">' + (s.net >= 0 ? "+" : "") + sizeMoney(s.net) + '</div></div>' +
    '<div class="port-card"><div class="pc-label">盈亏比</div><div class="pc-value">' + pfTxt + '</div></div>' +
    '<div class="port-card"><div class="pc-label">平均盈利</div><div class="pc-value up">' + (s.avgWin ? "+" + sizeMoney(s.avgWin) : "--") + '</div></div>' +
    '<div class="port-card"><div class="pc-label">平均亏损</div><div class="pc-value down">' + (s.avgLoss ? sizeMoney(s.avgLoss) : "--") + '</div></div>' +
    '<div class="port-card"><div class="pc-label">最好 / 最差</div><div class="pc-value" style="font-size:var(--fs-md)"><span class="up">+' + sizeMoney(s.best) + '</span> / <span class="down">' + sizeMoney(s.worst) + '</span></div></div>' +
    '<div class="port-card"><div class="pc-label">手续费合计</div><div class="pc-value">' + sizeMoney(s.fee) + '</div></div>' +
    '</div>';
  var srcRows = Object.keys(JR_SRC_LABEL).map(function (k) {
    var b = s.bySrc[k];
    if (!b) return "";
    var wr = b.n ? b.wins / b.n * 100 : 0;
    var cls = b.net >= 0 ? "up" : "down";
    return '<tr><td>' + JR_SRC_LABEL[k] + '</td><td>' + b.n + '</td><td>' + wr.toFixed(1) + '%</td>' +
      '<td class="' + cls + '">' + (b.net >= 0 ? "+" : "") + sizeMoney(b.net) + '</td></tr>';
  }).join("");
  var detail = rows.map(function (r) {
    var cls = r.net >= 0 ? "up" : "down";
    return '<tr>' +
      '<td style="font-size:var(--fs-xs);color:var(--text-muted)">' + new Date(r.t.closedAt).toISOString().slice(0, 10) + '</td>' +
      '<td>' + escapeHtml(splitSymbol(r.t.symbol).base) + '</td>' +
      '<td class="' + (r.t.side === "long" ? "up" : "down") + '">' + (r.t.side === "long" ? "多" : "空") + '</td>' +
      '<td>' + formatPrice(r.t.entry) + '</td>' +
      '<td>' + formatPrice(r.t.exit) + '</td>' +
      '<td>' + r.t.qty + '</td>' +
      '<td class="' + cls + '">' + (r.net >= 0 ? "+" : "") + sizeMoney(r.net) + '</td>' +
      '<td class="' + cls + '">' + (r.pct >= 0 ? "+" : "") + r.pct.toFixed(2) + '%</td>' +
      '<td style="font-size:var(--fs-xs)">' + JR_SRC_LABEL[r.t.src] + '</td>' +
      '<td style="font-size:var(--fs-xs);color:var(--text-muted)">' + escapeHtml(r.t.note || "") + '</td>' +
      '<td><button class="btn-danger-ghost" onclick="jrRemove(\'' + r.t.id + '\')">删除</button></td>' +
      '</tr>';
  }).join("");
  return form + cards +
    '<div class="mini-title">按「这笔的来源」拆开看</div>' +
    '<div class="nt-wrap"><table class="nt"><thead><tr><th>来源</th><th>笔数</th><th>胜率</th><th>净盈亏</th></tr></thead><tbody>' + srcRows + '</tbody></table></div>' +
    '<div class="size-note" style="margin-top:var(--sp-2)">这一栏是整页最有用的地方：如果「按信号做」长期跑不赢「自己判断」，说明信号质量或你的执行有问题；反之说明应该更纪律化。样本少于 20 笔时不要下结论。</div>' +
    '<div class="mini-title">交易明细 <button class="btn-ghost" style="margin-left:auto" onclick="jrExportCsv()">导出 CSV</button> <button class="btn-danger-ghost" onclick="jrClear()">清空</button></div>' +
    '<div class="nt-wrap"><table class="nt"><thead><tr><th>平仓日</th><th>币种</th><th>方向</th><th>入场</th><th>出场</th><th>数量</th><th>净盈亏</th><th>净收益</th><th>来源</th><th>备注</th><th></th></tr></thead><tbody>' + detail + '</tbody></table></div>' +
    '<div class="size-note">净盈亏 = (出场 − 入场) × 数量 × 方向 − 双边手续费。手续费按 (入场+出场) × 数量 × 单边费率 估算。</div>';
}

// ========== 我的交易：页签路由 ==========
function switchMinePane(pane) {
  if (pane !== "m_journal") pane = "m_port";
  window.__minePane = pane;
  try {
    document.querySelectorAll("#mineTabs .ana-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.mpane === pane);
    });
    ["m_port", "m_journal"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("active", id === pane);
    });
  } catch (e) {}
  renderMine();
}
function renderMine() {
  try {
    var pw = document.getElementById("portWrap");
    if (pw) pw.innerHTML = portHtml();
  } catch (e) { console.error("[app] portfolio render:", e); }
  try {
    var jw = document.getElementById("journalWrap");
    if (jw) jw.innerHTML = jrHtml();
  } catch (e) { console.error("[app] journal render:", e); }
}
window.switchMinePane = switchMinePane;
window.renderMine = renderMine;
window.portAdd = portAdd;
window.portRemove = portRemove;
window.portClear = portClear;
window.portExportCsv = portExportCsv;
window.portStats = portStats;
window.loadPortfolio = loadPortfolio;
window.jrAdd = jrAdd;
window.jrRemove = jrRemove;
window.jrClear = jrClear;
window.jrExportCsv = jrExportCsv;
window.jrStats = jrStats;
window.jrRow = jrRow;
window.loadJournal = loadJournal;

// ========== ⑧ 资金面扩展：基差 / 多空比历史曲线 / 恐惧贪婪指数 ==========
function sparkRow(label, vals, ref) {
  var v = (vals || []).filter(function (x) { return isFinite(x); });
  if (v.length < 2) return "";
  var w = 260, h = 40;
  var min = Math.min.apply(null, v), max = Math.max.apply(null, v);
  var span = (max - min) || 1;
  var pts = v.map(function (val, i) {
    var x = (i / (v.length - 1)) * w;
    var y = h - ((val - min) / span) * h;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  var last = v[v.length - 1];
  var cls = last >= (ref === undefined ? 1 : ref) ? "up" : "down";
  return '<div style="display:flex;align-items:center;gap:var(--sp-3);margin-bottom:6px">' +
    '<span style="min-width:112px;font-size:var(--fs-xs);color:var(--text-secondary)">' + escapeHtml(label) + '</span>' +
    '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="flex:1;height:40px;min-width:120px">' +
    '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/>' +
    '</svg>' +
    '<span class="' + cls + '" style="min-width:56px;text-align:right;font-size:var(--fs-sm);font-weight:600">' + last.toFixed(3) + '</span>' +
    '<span style="min-width:78px;text-align:right;font-size:10px;color:var(--text-muted)">' + min.toFixed(2) + ' ~ ' + max.toFixed(2) + '</span>' +
    '</div>';
}
var FNG_CN = { "Extreme Fear": "极度恐惧", "Fear": "恐惧", "Neutral": "中性", "Greed": "贪婪", "Extreme Greed": "极度贪婪" };
function fngColorVar(v) {
  if (v <= 24) return "var(--negative)";
  if (v <= 44) return "var(--warning)";
  if (v <= 55) return "var(--text-secondary)";
  if (v <= 74) return "var(--positive)";
  return "var(--positive)";
}
window.__fngCache = window.__fngCache || { ts: 0, data: null };
function fngHtml(r) {
  var arr = (r && Array.isArray(r.data)) ? r.data : [];
  if (!arr.length) return '<div class="ai-rr-placeholder">恐惧贪婪指数暂不可用（第三方接口，可能被限流或需代理）</div>';
  var cur = Number(arr[0].value);
  var label = FNG_CN[arr[0].value_classification] || arr[0].value_classification || "";
  var col = fngColorVar(cur);
  var hist = arr.map(function (x) { return Number(x.value); }).reverse();   // 接口返回新→旧，反转成旧→新
  var w = 260, h = 40;
  var min = Math.min.apply(null, hist), max = Math.max.apply(null, hist);
  var span = (max - min) || 1;
  var pts = hist.map(function (val, i) {
    var x = (i / (hist.length - 1)) * w;
    var y = h - ((val - min) / span) * h;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  var days = arr.length;
  var avg = hist.reduce(function (a, b) { return a + b; }, 0) / hist.length;
  return '<div class="fng-row">' +
    '<div class="fng-dial" style="border-color:' + col + '"><b style="color:' + col + '">' + cur.toFixed(0) + '</b><span>' + escapeHtml(label) + '</span></div>' +
    '<div style="flex:1;min-width:220px">' +
      '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:56px">' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/>' +
      '</svg>' +
      '<div class="fng-legend">近 ' + days + ' 天 · 均值 ' + avg.toFixed(1) + ' · 区间 ' + min + ' ~ ' + max + '（0 极度恐惧 → 100 极度贪婪）</div>' +
    '</div></div>' +
    '<div class="size-note">该指数由 alternative.me 提供，只反映整体市场情绪，<strong>不参与本应用的主评分</strong>。用法上有两个方向：① 与自己的评分共振时提高信心；② 极度贪婪（&gt; 80）常是风险区，极度恐惧（&lt; 20）常是机会区 —— 属逆势参考，不是买卖信号。</div>';
}
async function paintDerivExtra(sym, d) {
  var box = document.getElementById("derivExtra");
  if (!box) return;
  var html = "";
  // ---- 基差（标记价 vs 指数价）----
  var pr = d && d.premium;
  if (pr && !pr.__error && isFinite(Number(pr.markPrice)) && isFinite(Number(pr.indexPrice))) {
    var mark = Number(pr.markPrice), idx = Number(pr.indexPrice);
    var basis = mark - idx;
    var basisPct = idx > 0 ? basis / idx * 100 : 0;
    var bCls = basis >= 0 ? "up" : "down";
    html += '<div class="mini-title">基差（标记价 − 指数价）</div>' +
      '<div class="size-out">' +
      '<div class="size-item"><div class="si-label">标记价</div><div class="si-value">' + formatPrice(mark) + '</div></div>' +
      '<div class="size-item"><div class="si-label">指数价（现货锚）</div><div class="si-value">' + formatPrice(idx) + '</div></div>' +
      '<div class="size-item hl"><div class="si-label">基差</div><div class="si-value ' + bCls + '">' + (basis >= 0 ? "+" : "") + formatPrice(basis) + '</div></div>' +
      '<div class="size-item hl"><div class="si-label">基差 %</div><div class="si-value ' + bCls + '">' + (basisPct >= 0 ? "+" : "") + basisPct.toFixed(3) + '%</div></div>' +
      '</div>' +
      '<div class="size-note">基差为正（期货贵于现货）通常意味着多头情绪偏热、杠杆多头拥挤；为负则偏空。绝对值越大，越容易出现向现货收敛的回摆。该值会随资金费结算周期波动。</div>';
  }
  // ---- 多空比历史曲线（数据已在 deriv:snapshot 里，无需额外请求）----
  var lsA = (d && Array.isArray(d.lsAccount)) ? d.lsAccount : [];
  var lsT = (d && Array.isArray(d.lsTop)) ? d.lsTop : [];
  var tk = (d && Array.isArray(d.taker)) ? d.taker : [];
  if (lsA.length >= 2 || lsT.length >= 2 || tk.length >= 2) {
    var span = Math.max(lsA.length, lsT.length, tk.length);
    html += '<div class="mini-title">历史曲线（近 ' + span + ' 个周期 · 参考线 1.00）</div>' +
      sparkRow("账户多空比", lsA.map(function (x) { return Number(x.longShortRatio); }), 1) +
      sparkRow("大户持仓多空比", lsT.map(function (x) { return Number(x.longShortRatio); }), 1) +
      sparkRow("主动买卖比", tk.map(function (x) { return Number(x.buySellRatio); }), 1) +
      '<div class="size-note">三条线都在 1.00 上方 = 多头占优；下方 = 空头占优。曲线<strong>拐点</strong>比绝对值更有意义：例如账户多空比一路走高而主动买卖比转弱，往往对应散户追多、主动卖压在增。</div>';
  }
  html += '<div class="mini-title">恐惧贪婪指数</div><div id="fngBox"><div class="ai-rr-placeholder">正在获取...</div></div>';
  box.innerHTML = html;
  // ---- 恐惧贪婪（异步，失败只影响这一块）----
  var fngBox = document.getElementById("fngBox");
  if (!fngBox) return;
  try {
    var cached = window.__fngCache;
    if (cached.data && Date.now() - cached.ts < 600000) { fngBox.innerHTML = fngHtml(cached.data); return; }
    if (!window.binanceAPI || !window.binanceAPI.fng) {
      fngBox.innerHTML = '<div class="ai-rr-placeholder">当前运行环境不支持该数据源（需通过 NovaTrade 主程序启动）</div>';
      return;
    }
    var r = await window.binanceAPI.fng(30);
    if (!r || r.__error) {
      fngBox.innerHTML = '<div class="ai-rr-placeholder">恐惧贪婪指数暂不可用' + (r && r.__error ? "（" + escapeHtml(r.__error) + "）" : "") + '</div>';
      return;
    }
    window.__fngCache = { ts: Date.now(), data: r };
    fngBox.innerHTML = fngHtml(r);
  } catch (e) {
    try { fngBox.innerHTML = '<div class="ai-rr-placeholder">恐惧贪婪指数获取失败：' + escapeHtml(e.message || String(e)) + '</div>'; } catch (e2) {}
  }
}
window.paintDerivExtra = paintDerivExtra;
window.sparkRow = sparkRow;
window.fngHtml = fngHtml;

// ========== ⑨ 盘口与强平：订单簿深度墙 / 大额成交（鲸鱼）/ 强平流 ==========
window.__flow = window.__flow || { depth: null, whales: null, ts: 0, sym: "" };
window.__liq = window.__liq || { ws: null, status: "idle", events: [], err: "", manual: false, retry: 0, timer: null, nextRetryAt: 0 };
var FLOW_TTL = 20000;

function depthBuckets(levels, step, n) {
  var m = {};
  (levels || []).forEach(function (lv) {
    var p = Number(lv[0]), q = Number(lv[1]);
    if (!isFinite(p) || !isFinite(q) || p <= 0 || q <= 0) return;
    var b = Math.round(p / step) * step;
    m[b] = (m[b] || 0) + q;
  });
  var arr = Object.keys(m).map(function (k) {
    var price = Number(k);
    return { price: price, qty: m[k], notional: price * m[k] };
  });
  arr.sort(function (a, b) { return b.notional - a.notional; });
  return arr.slice(0, n).sort(function (a, b) { return b.price - a.price; });
}
function depthHtml(depth) {
  if (!depth || depth.__error) return '<div class="ai-rr-placeholder">盘口数据不可用' + (depth && depth.__error ? "（" + escapeHtml(depth.__error) + "）" : "") + '</div>';
  var bids = depth.bids || [], asks = depth.asks || [];
  if (!bids.length || !asks.length) return '<div class="ai-rr-placeholder">盘口为空</div>';
  var bestBid = Number(bids[0][0]), bestAsk = Number(asks[0][0]);
  var mid = (bestBid + bestAsk) / 2;
  var step = mid * 0.001;                     // 0.1% 一档，用来找"墙"
  var bTop = depthBuckets(bids, step, 10);
  var aTop = depthBuckets(asks, step, 10);
  var maxN = Math.max.apply(null, bTop.concat(aTop).map(function (x) { return x.notional; }).concat([1]));
  function lines(arr, side) {
    return arr.map(function (x) {
      var pct = Math.max(2, x.notional / maxN * 100);
      return '<div class="depth-line ' + side + '"><i style="width:' + pct.toFixed(1) + '%"></i>' +
        '<span>' + formatPrice(x.price) + '</span><span>' + (x.notional / 1e6).toFixed(2) + 'M</span></div>';
    }).join("");
  }
  var bidSum = bTop.reduce(function (a, b) { return a + b.notional; }, 0);
  var askSum = aTop.reduce(function (a, b) { return a + b.notional; }, 0);
  var ratio = askSum > 0 ? bidSum / askSum : 0;
  var rCls = ratio >= 1 ? "up" : "down";
  return '<div class="depth-cols">' +
    '<div><div class="depth-head"><span>买盘（支撑墙）</span><span>金额</span></div>' + lines(bTop, "bid") + '</div>' +
    '<div><div class="depth-head"><span>卖盘（压力墙）</span><span>金额</span></div>' + lines(aTop, "ask") + '</div>' +
    '</div>' +
    '<div class="liq-tags" style="margin-top:var(--sp-3)">' +
    '<div class="liq-tag">买盘合计 <b class="up">' + (bidSum / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">卖盘合计 <b class="down">' + (askSum / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">买卖墙比 <b class="' + rCls + '">' + ratio.toFixed(2) + '</b></div>' +
    '<div class="liq-tag">买卖价差 <b>' + ((bestAsk - bestBid) / mid * 100).toFixed(3) + '%</b></div>' +
    '</div>' +
    '<div class="size-note">按 0.1% 价格区间聚合，取金额最大的各 10 档 —— 目的是看<strong>挂单密集区（墙）</strong>，而不是逐档盘口。买卖墙比 &gt; 1 表示买盘更厚。注意：挂单可以随时撤，墙不等于真实支撑，仅作参考。</div>';
}
function whalesHtml(trades, minNotional) {
  if (!Array.isArray(trades)) return '<div class="ai-rr-placeholder">逐笔成交不可用' + (trades && trades.__error ? "（" + escapeHtml(trades.__error) + "）" : "") + '</div>';
  var rows = trades.map(function (t) {
    var p = Number(t.p), q = Number(t.q);
    return { p: p, q: q, notional: p * q, ts: Number(t.T) || 0, sell: t.m === true };
  }).filter(function (t) { return isFinite(t.notional) && t.notional >= minNotional; })
    .sort(function (a, b) { return b.notional - a.notional; })
    .slice(0, 20);
  if (!rows.length) return '<div class="ai-rr-placeholder">最近 ' + trades.length + ' 笔成交里没有超过 ' + (minNotional / 1e3).toFixed(0) + 'K 的单子，可以把阈值调低</div>';
  var buySum = 0, sellSum = 0;
  rows.forEach(function (r) { if (r.sell) sellSum += r.notional; else buySum += r.notional; });
  var html = '<div class="liq-tags">' +
    '<div class="liq-tag">大单买入 <b class="up">' + (buySum / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">大单卖出 <b class="down">' + (sellSum / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">笔数 <b>' + rows.length + '</b></div>' +
    '</div>';
  html += rows.map(function (r) {
    var t = r.ts ? new Date(r.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
    return '<div class="whale-row">' +
      '<span class="w-t">' + t + '</span>' +
      '<span class="' + (r.sell ? "down" : "up") + '">' + (r.sell ? "主动卖出" : "主动买入") + '</span>' +
      '<span style="color:var(--text-muted)">@ ' + formatPrice(r.p) + '</span>' +
      '<span class="w-q">' + (r.notional / 1e3).toFixed(1) + 'K USDT</span>' +
      '</div>';
  }).join("");
  return html;
}
function liqStatsHtml() {
  var L = window.__liq;
  var now = Date.now();
  var win = 300000;   // 5 分钟滚动窗口
  var ev = (L.events || []).filter(function (e) { return now - e.ts <= win; });
  var longLiq = 0, shortLiq = 0;
  ev.forEach(function (e) { if (e.side === "long") longLiq += e.notional; else shortLiq += e.notional; });
  var st = L.status;
  var stTxt = st === "open" ? "已连接" : st === "connecting" ? "连接中…" : st === "error" ? ("连接失败" + (L.err ? "（" + L.err + "）" : "")) : st === "closed" ? "已断开" : "未连接";
  var dotCls = st === "open" ? "on" : (st === "error" ? "err" : "");
  var html = '<div class="flow-status"><span class="flow-dot ' + dotCls + '"></span>强平流：' + escapeHtml(stTxt) +
    ' · 近 5 分钟收到 ' + ev.length + ' 条</div>';
  html += '<div class="liq-tags" style="margin-top:var(--sp-3)">' +
    '<div class="liq-tag">多单被强平 <b class="down">' + (longLiq / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">空单被强平 <b class="up">' + (shortLiq / 1e6).toFixed(2) + 'M</b></div>' +
    '<div class="liq-tag">净差 <b>' + ((longLiq - shortLiq) / 1e6).toFixed(2) + 'M</b></div>' +
    '</div>';
  if (st === "error") {
    var retryIn = (L.timer && L.nextRetryAt) ? Math.max(0, Math.ceil((L.nextRetryAt - now) / 1000)) : 0;
    html += '<div class="size-warn">强平流连不上，' + (retryIn ? '约 ' + retryIn + ' 秒后自动重试（第 ' + (L.retry || 1) + ' 次）。' : '正在重试。') +
      '这是 WebSocket 实时流，会跟随「设置」里的代理；若持续失败，请确认代理已开启并允许 WebSocket 转发。</div>';
  } else if (!ev.length) {
    html += '<div class="ai-rr-placeholder">还没收到强平事件。全市场强平流是稀疏事件，安静行情下几分钟没有一条很正常。</div>';
  } else {
    html += ev.slice(0, 20).map(function (e) {
      var t = new Date(e.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      return '<div class="whale-row">' +
        '<span class="w-t">' + t + '</span>' +
        '<span style="font-weight:600">' + escapeHtml(splitSymbol(e.symbol).base) + '</span>' +
        '<span class="' + (e.side === "long" ? "down" : "up") + '">' + (e.side === "long" ? "多单爆仓" : "空单爆仓") + '</span>' +
        '<span style="color:var(--text-muted)">@ ' + formatPrice(e.price) + '</span>' +
        '<span class="w-q">' + (e.notional / 1e3).toFixed(1) + 'K</span>' +
        '</div>';
    }).join("");
  }
  html += '<div class="size-note">数据源：币安合约全市场强平推送（<code>!forceOrder@arr</code>）。REST 端点 <code>allForceOrders</code> 已被币安下线，所以只能用 WS。<br>读法：<strong>多单被强平</strong>意味着价格急跌把多头打爆（常见于恐慌杀跌的尾部）；<strong>空单被强平</strong>意味着急涨打爆空头（常见于逼空）。单边金额突然放大往往出现在短期极值附近。</div>';
  return html;
}
function liqRepaint() {
  try {
    var el = document.getElementById("liqBox");
    if (el) el.innerHTML = liqStatsHtml();
  } catch (e) {}
}
function liqOnMessage(raw) {
  var msg = null;
  try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
  if (Array.isArray(msg)) { msg.forEach(liqOnMessage); return; }
  var o = msg && msg.o;
  if (!o || !o.s) return;
  var price = Number(o.ap) || Number(o.p) || 0;
  var qty = Number(o.z) || Number(o.q) || 0;
  if (!(price > 0) || !(qty > 0)) return;
  // S = 强平单的方向：SELL 说明是多头被强平（被迫卖出），BUY 说明是空头被强平
  var side = (o.S === "BUY") ? "short" : "long";
  window.__liq.events.unshift({ symbol: String(o.s), side: side, price: price, qty: qty, notional: price * qty, ts: Number(o.T) || Date.now() });
  if (window.__liq.events.length > 300) window.__liq.events.length = 300;
  liqRepaint();
}
var LIQ_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";
function liqClearTimer() {
  var L = window.__liq;
  if (L.timer) { clearTimeout(L.timer); L.timer = null; }
  L.nextRetryAt = 0;
}
// 断线后指数退避重连：2s → 4s → … → 60s 封顶，带少量抖动；用户手动断开后不再重连
function liqScheduleReconnect() {
  var L = window.__liq;
  if (L.manual || L.timer) return;
  L.retry = (L.retry || 0) + 1;
  var delay = Math.min(60000, 1000 * Math.pow(2, Math.min(L.retry, 6))) + Math.floor(Math.random() * 500);
  L.nextRetryAt = Date.now() + delay;
  L.timer = setTimeout(function () { L.timer = null; L.nextRetryAt = 0; liqConnect(true); }, delay);
}
// 页面渲染时调用：没连上、也没在等待重连、用户也没手动断开，就发起一次连接
function liqEnsure() {
  var L = window.__liq;
  if (!L.manual && !L.ws && !L.timer) liqConnect(true);
}
function liqConnect(isAuto) {
  var L = window.__liq;
  // 来自按钮的手动连接：清零退避计数；自动重连保留计数继续递增
  if (!isAuto) { L.manual = false; L.retry = 0; }
  liqClearTimer();
  try {
    if (L.ws) return;
    if (typeof WebSocket === "undefined") { L.status = "error"; L.err = "当前环境无 WebSocket"; liqRepaint(); return; }
    L.status = "connecting";
    L.err = "";
    liqRepaint();
    var ws = new WebSocket(LIQ_URL);
    L.ws = ws;
    ws.onopen = function () { L.status = "open"; L.err = ""; L.retry = 0; liqRepaint(); };
    ws.onmessage = function (ev) { liqOnMessage(ev && ev.data); };
    ws.onerror = function () { L.status = "error"; if (!L.err) L.err = "WebSocket 错误"; liqRepaint(); };
    ws.onclose = function () {
      if (L.ws === ws) L.ws = null;
      if (L.manual) { L.status = "idle"; }
      else {
        if (L.status !== "error") L.status = "closed";
        liqScheduleReconnect();
      }
      liqRepaint();
    };
  } catch (e) {
    L.status = "error";
    L.err = e.message || String(e);
    L.ws = null;
    liqScheduleReconnect();
    liqRepaint();
  }
}
function liqDisconnect() {
  var L = window.__liq;
  L.manual = true;
  liqClearTimer();
  try { if (L.ws) L.ws.close(); } catch (e) {}
  L.ws = null;
  L.status = "idle";
  liqRepaint();
}
async function renderFlowPane(symbol) {
  var wrap = document.getElementById("flowWrap");
  if (!wrap) return;
  var sym = symbol || (typeof selectedCoin !== "undefined" && selectedCoin) || (typeof lastAnalysisSymbol !== "undefined" && lastAnalysisSymbol) || "";
  if (!sym) { wrap.innerHTML = '<div class="ai-rr-placeholder">请先在左侧选择一个币种</div>'; return; }
  var cached = window.__flow;
  var fresh = cached.sym === sym && cached.ts && (Date.now() - cached.ts < FLOW_TTL) && cached.depth && cached.whales;
  var whaleMin = window.__whaleMin || 100000;
  if (!fresh) {
    wrap.innerHTML = '<div class="ai-rr-placeholder">正在获取盘口与逐笔成交...</div>';
    var depth = null, trades = null;
    if (!window.binanceAPI || !window.binanceAPI.getFuturesDepth) {
      wrap.innerHTML = '<div class="ai-rr-placeholder">当前运行环境不支持盘口数据（需通过 NovaTrade 主程序启动）</div>';
      return;
    }
    try { depth = await window.binanceAPI.getFuturesDepth(sym, 500); } catch (e) { depth = { __error: e.message }; }
    try { trades = await window.binanceAPI.getAggTrades(sym, 1000); } catch (e) { trades = { __error: e.message }; }
    window.__flow = { sym: sym, ts: Date.now(), depth: depth, whales: trades };
  }
  var d2 = window.__flow.depth, t2 = window.__flow.whales;
  wrap.innerHTML =
    '<div class="deriv-head"><span class="deriv-sym">' + escapeHtml(splitSymbol(sym).base) + ' 盘口与强平</span>' +
    '<span class="deriv-meta">更新 ' + new Date(window.__flow.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + '</span></div>' +
    '<div class="mini-title">订单簿深度墙（只读）</div>' + depthHtml(d2) +
    '<div class="mini-title">大额成交 / 鲸鱼监控' +
    ' <select id="whaleMin" style="margin-left:auto;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text-primary);padding:3px 6px;font-size:var(--fs-xs)" onchange="whaleMinChange(this.value)">' +
    [50000, 100000, 500000, 1000000].map(function (v) {
      return '<option value="' + v + '"' + (v === whaleMin ? " selected" : "") + '>≥ ' + (v / 1e3).toFixed(0) + 'K USDT</option>';
    }).join("") + '</select></div>' + whalesHtml(t2, whaleMin) +
    '<div class="mini-title">强平流（WebSocket 实时）' +
    ' <button class="btn-ghost" style="margin-left:auto" onclick="liqConnect()">连接</button>' +
    ' <button class="btn-ghost" onclick="liqDisconnect()">断开</button></div>' +
    '<div id="liqBox">' + liqStatsHtml() + '</div>';
  liqEnsure();
}
function whaleMinChange(v) {
  var n = parseFloat(v);
  window.__whaleMin = (isFinite(n) && n > 0) ? n : 100000;
  var wrap = document.getElementById("flowWrap");
  if (!wrap) return;
  var box = document.getElementById("whaleMin");
  var parent = box ? box.closest(".mini-title") : null;
  if (parent && parent.nextElementSibling) parent.nextElementSibling.innerHTML = whalesHtml(window.__flow.whales, window.__whaleMin);
}
window.renderFlowPane = renderFlowPane;
window.depthHtml = depthHtml;
window.whalesHtml = whalesHtml;
window.liqStatsHtml = liqStatsHtml;
window.liqConnect = liqConnect;
window.liqDisconnect = liqDisconnect;
window.liqOnMessage = liqOnMessage;
window.depthBuckets = depthBuckets;
window.whaleMinChange = whaleMinChange;

// ========== ⑩ 完整回测（门控 + 实际止损止盈 + 净值曲线 + 稳健性检验）==========
// 与上面的「阈值回测」的区别：上面只算固定持有 h1/h4 根的远期收益（近似），
// 这里逐根 K 线模拟真实持仓 —— 用到 calcRiskReward 给出的**实际入场/止损/止盈**，
// 并叠加日线趋势门控，最后给出以 R 为单位的净值曲线、最大回撤、夏普与样本内外对比。
window.__btFullCache = window.__btFullCache || {};
var BT_FULL_KEY = "novatrade_btfull_cfg";
function btFullDefaults() { return { tpR: 2, maxHold: 48, useDaily: true, noOverlap: true, slip: 0.02, funding: 0.01 }; }
function loadBtFullCfg() {
  var c = null;
  try { c = JSON.parse(localStorage.getItem(BT_FULL_KEY) || "null"); } catch (e) {}
  var d = btFullDefaults();
  var out = Object.assign({}, d, (c && typeof c === "object") ? c : {});
  if (typeof out.tpR !== "number" || !isFinite(out.tpR) || out.tpR <= 0) out.tpR = d.tpR;
  if (typeof out.maxHold !== "number" || !isFinite(out.maxHold) || out.maxHold < 2) out.maxHold = d.maxHold;
  if (typeof out.useDaily !== "boolean") out.useDaily = d.useDaily;
  if (typeof out.noOverlap !== "boolean") out.noOverlap = d.noOverlap;
  if (typeof out.slip !== "number" || !isFinite(out.slip) || out.slip < 0) out.slip = d.slip;
  if (typeof out.funding !== "number" || !isFinite(out.funding) || out.funding < 0) out.funding = d.funding;
  return out;
}
function saveBtFullCfg(c) { try { localStorage.setItem(BT_FULL_KEY, JSON.stringify(c)); } catch (e) {} }
// 取回测用 K 线：<=1400 根走普通接口；更长的历史走主进程的本地 K 线库（分页拉取 + 落盘增量更新）
async function btLoadBars(sym, tf, want) {
  var kl;
  if (want > 1400 && window.binanceAPI && window.binanceAPI.getHistory) {
    kl = await window.binanceAPI.getHistory(sym, tf, want);
  } else {
    kl = await window.binanceAPI.getKlines(sym, tf, Math.min(1500, want));
  }
  if (!kl || !Array.isArray(kl) || kl.__error) throw new Error((kl && kl.__error) || "K 线拉取失败");
  return dropOpenCandle(kl);   // 回测只用已收盘 K 线，与实盘信号口径一致
}
async function btDailySeries(sym) {
  var ck = "d|" + sym;
  var hit = window.__btFullCache[ck];
  if (hit && Date.now() - hit.ts < BT_TTL) return hit.series;
  var kl = null;
  try { kl = await window.binanceAPI.getKlines(sym, "1d", 1000); } catch (e) { return null; }
  if (!kl || !Array.isArray(kl) || kl.__error) return null;
  kl = dropOpenCandle(kl);
  var times = [], closes = [];
  for (var i = 0; i < kl.length; i++) { times.push(kl[i][0]); closes.push(parseFloat(kl[i][4])); }
  if (closes.length < 50) return null;
  var series = { times: times, closes: closes, e20: emaArr(closes, 20), e50: emaArr(closes, 50) };
  window.__btFullCache[ck] = { ts: Date.now(), series: series };
  return series;
}
function btCostOf(cfg, full) { return { fee: cfg.fee, slip: full.slip, funding: full.funding }; }
// 信号只依赖评分引擎（与止盈倍数 / 最长持有无关），所以按「币|周期|根数|步长|采集用的最长持有」缓存，参数扫描时复用
async function btSignalsFor(sym, cfg, maxHoldRef, token, onProgress) {
  var key = ["sig", sym, cfg.tf, cfg.bars, cfg.step, maxHoldRef].join("|");
  var hit = window.__btFullCache[key];
  if (hit && Date.now() - hit.ts < BT_TTL) return hit;
  var kl = await btLoadBars(sym, cfg.tf, cfg.bars + cfg.step + maxHoldRef + 130);
  if (kl.length < BT_MIN_WARMUP + maxHoldRef + 20) throw new Error("样本不足：仅取到 " + kl.length + " 根已收盘 K 线");
  var sc = await btCollectSignals(kl, Object.assign({ sym: sym }, cfg), maxHoldRef, {
    isAborted: function () { return window.__btRun !== token; }, onProgress: onProgress
  });
  var out = { ts: Date.now(), kl: kl, signals: sc.signals, vetoed: sc.vetoed, bars: sc.bars };
  window.__btFullCache[key] = out;
  return out;
}
async function btFullSim(sym, cfg, full, token, onProgress) {
  var cost = btCostOf(cfg, full);
  var key = ["f2", sym, cfg.tf, cfg.bars, cfg.step, cost.fee, cost.slip, cost.funding, full.tpR, full.maxHold, full.useDaily ? 1 : 0, full.noOverlap ? 1 : 0].join("|");
  var hit = window.__btFullCache[key];
  if (hit && Date.now() - hit.ts < BT_TTL) return hit;
  var sg = await btSignalsFor(sym, cfg, full.maxHold, token, onProgress);
  var daily = full.useDaily ? await btDailySeries(sym) : null;
  var res = btRunSignals(sg.signals, sg.kl, daily, cfg.tf, full, cost);
  res.vetoed = sg.vetoed; res.bars = sg.bars;
  window.__btFullCache[key] = Object.assign({ ts: Date.now() }, res);
  return res;
}
function btEquitySvg(path, w, h) {
  var eq = path.eq;
  if (eq.length < 2) return "";
  var min = Math.min.apply(null, eq), max = Math.max.apply(null, eq);
  var span = (max - min) || 1;
  var pts = eq.map(function (v, i) {
    var x = (i / (eq.length - 1)) * w;
    var y = h - ((v - min) / span) * h;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  var zeroY = h - ((0 - min) / span) * h;
  var up = eq[eq.length - 1] >= 0;
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:200px">' +
    '<line x1="0" y1="' + zeroY.toFixed(1) + '" x2="' + w + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3 3"/>' +
    '<polyline points="' + pts + '" fill="none" stroke="' + (up ? "var(--positive)" : "var(--negative)") + '" stroke-width="1.5"/>' +
    '</svg>';
}
function btFullFormHtml(full) {
  return '<div class="nf" style="margin:var(--sp-3) 0">' +
    '<label>止盈 R 倍数<input type="number" step="0.5" id="bf_tpR" value="' + full.tpR + '" style="min-width:90px"></label>' +
    '<label>最长持有 K 线数<input type="number" step="1" id="bf_maxHold" value="' + full.maxHold + '" style="min-width:110px"></label>' +
    '<label>单边滑点 %<input type="number" step="0.01" min="0" id="bf_slip" value="' + full.slip + '" style="min-width:90px"></label>' +
    '<label>资金费率 %/8h<input type="number" step="0.005" min="0" id="bf_funding" value="' + full.funding + '" style="min-width:100px"></label>' +
    '<label class="nf-check"><input type="checkbox" id="bf_useDaily"' + (full.useDaily ? " checked" : "") + '><span>应用日线趋势门控</span></label>' +
    '<label class="nf-check"><input type="checkbox" id="bf_noOverlap"' + (full.noOverlap ? " checked" : "") + '><span>同一币种不重叠持仓</span></label>' +
    '<button class="btn-primary" onclick="runFullBacktest()">跑完整回测</button>' +
    '<button class="btn-ghost" onclick="runBtSweep()">参数稳定性扫描</button>' +
    '<label>组合币数<input type="number" step="1" min="2" max="40" id="bf_portN" value="' + (full.portN || 10) + '" style="min-width:70px"></label>' +
    '<button class="btn-ghost" onclick="runBtPortfolio()">多币种组合回测</button>' +
    '<button class="btn-ghost" onclick="exportFullBacktestCsv()">导出逐笔 CSV</button>' +
    '</div>';
}
function btFullResultHtml(res, cfg) {
  if (!res || !res.trades) return "";
  var trades = res.trades;
  if (!trades.length) {
    return '<div class="empty-note">没有产生任何交易。可能是：门控把信号全拦了（日线不顺向）、或阈值太严、或样本太短。可试试点「跑完整回测」前把日线门控关掉对比。</div>';
  }
  var st = btFullStats(trades);
  var path = btEquityPath(trades);
  var split = btSplitStats(trades, 0.7);
  var mc = btMonteCarlo(trades, 400);
  function chip(label, value, cls) {
    return '<div class="size-item' + (cls === "hl" ? " hl" : "") + '"><div class="si-label">' + label + '</div><div class="si-value">' + value + '</div></div>';
  }
  var sumCls = st.sumR >= 0 ? "up" : "down";
  var html = '<div class="size-out" style="margin-top:var(--sp-3)">' +
    chip("交易笔数", st.n) +
    chip("胜率", st.winRate.toFixed(1) + "%") +
    chip("累计净收益", (st.sumR >= 0 ? "+" : "") + st.sumR.toFixed(2) + " R", "hl") +
    chip("每笔期望", (st.avgR >= 0 ? "+" : "") + st.avgR.toFixed(3) + " R", "hl") +
    (st.avgLo !== null ? chip("期望 95% 区间", st.avgLo.toFixed(3) + " ~ " + st.avgHi.toFixed(3) + " R", st.avgLo > 0 ? "hl" : "") : "") +
    chip("盈亏比", st.pf === Infinity ? "∞" : st.pf.toFixed(2)) +
    chip("最大回撤", "-" + st.mdd.toFixed(2) + " R", "hl") +
    chip("收益/回撤", st.mdd > 0 ? (st.sumR / st.mdd).toFixed(2) : "∞") +
    chip("单笔波动 σ", st.sd.toFixed(2) + " R") +
    chip("近似夏普", st.sharpe.toFixed(2)) +
    chip("平均持有", st.avgBars.toFixed(1) + " 根") +
    chip("最大单笔盈利", "+" + st.maxWin.toFixed(2) + " R") +
    chip("最大单笔亏损", st.maxLoss.toFixed(2) + " R") +
    chip("重叠跳过", (res.overlapSkipped || 0) + " 个") +
    '</div>';
  if (st.avgLo !== null && st.avgLo <= 0 && st.avgR > 0) {
    html += '<div class="size-note"><span class="bt-tag warn">期望为正，但 95% 区间跨过 0</span> 样本量还不足以说明「真的有优势」，更像是运气。</div>';
  }
  html += '<div class="mini-title">以 R 为单位的净值曲线（' + trades.length + ' 笔）</div>' +
    '<div class="eq-chart">' + btEquitySvg(path, 600, 200) + '</div>' +
    '<div class="size-note">纵轴是累计净 R（已扣双边手续费），虚线为 0 轴。曲线形状比终值更重要：<strong>是否长期横盘、是否靠最后几笔拉起来</strong>，这两点决定了策略能不能用。</div>';
  // 出场原因分布
  var reasonRows = Object.keys(st.byReason).map(function (k) {
    return '<tr><td>' + escapeHtml(k) + '</td><td>' + st.byReason[k] + '</td><td>' + (st.byReason[k] / st.n * 100).toFixed(1) + '%</td></tr>';
  }).join("");
  html += '<div class="mini-title">出场原因分布</div><div class="nt-wrap"><table class="nt"><thead><tr><th>原因</th><th>笔数</th><th>占比</th></tr></thead><tbody>' + reasonRows + '</tbody></table></div>';
  // 样本内 / 样本外
  function splitBox(title, s) {
    if (!s) return '<div class="split-box"><h4>' + title + '</h4><div class="ai-rr-placeholder">样本不足</div></div>';
    var cls = s.sumR >= 0 ? "ok" : "bad";
    return '<div class="split-box"><h4>' + title + '</h4>' +
      '<div style="font-size:var(--fs-sm);line-height:2">' +
      '笔数 <b>' + s.n + '</b><br>' +
      '胜率 <b>' + s.winRate.toFixed(1) + '%</b><br>' +
      '累计 <b class="' + (s.sumR >= 0 ? "up" : "down") + '">' + (s.sumR >= 0 ? "+" : "") + s.sumR.toFixed(2) + ' R</b><br>' +
      '每笔 <b class="' + (s.avgR >= 0 ? "up" : "down") + '">' + (s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(3) + ' R</b><br>' +
      '回撤 <b>-' + s.mdd.toFixed(2) + ' R</b>' +
      '</div><div style="margin-top:8px"><span class="bt-tag ' + cls + '">' + (s.avgR > 0 ? "正期望" : "负期望") + '</span></div></div>';
  }
  var verdict = "";
  if (split.is && split.os) {
    if (split.is.avgR > 0 && split.os.avgR > 0) verdict = '<span class="bt-tag ok">样本外仍为正 —— 参数没有被过拟合的明显迹象</span>';
    else if (split.is.avgR > 0 && split.os.avgR <= 0) verdict = '<span class="bt-tag bad">样本内为正、样本外转负 —— 典型的过拟合征兆，不要据此改阈值</span>';
    else if (split.is.avgR <= 0 && split.os.avgR > 0) verdict = '<span class="bt-tag warn">样本内为负、样本外为正 —— 更像是运气或样本太小，样本量不够时别下结论</span>';
    else verdict = '<span class="bt-tag bad">两段都是负期望 —— 该参数组合在历史上不成立</span>';
  }
  html += '<div class="mini-title">稳健性检验：样本内 / 样本外（前 70% / 后 30%）</div>' +
    '<div class="split-grid">' + splitBox("样本内（前 " + split.cut + " 笔）", split.is) + splitBox("样本外（后 " + (trades.length - split.cut) + " 笔）", split.os) + '</div>' +
    '<div style="margin-top:var(--sp-2)">' + verdict + '</div>' +
    '<div class="size-note">为什么要分段：在同一段历史上反复调参数，总能调出漂亮的结果，但那是拟合噪声。真正有意义的只有<strong>样本外</strong>那一栏。</div>';
  // 蒙特卡洛
  if (mc) {
    var barsHtml = "";
    var lo = mc.finals[0], hi = mc.finals[mc.finals.length - 1];
    var nBars = 40;
    var hist = new Array(nBars).fill(0);
    var width = (hi - lo) || 1;
    for (var i = 0; i < mc.finals.length; i++) {
      var b = Math.floor((mc.finals[i] - lo) / width * (nBars - 1));
      hist[Math.max(0, Math.min(nBars - 1, b))]++;
    }
    var maxH = Math.max.apply(null, hist) || 1;
    barsHtml = '<div class="mc-bars">' + hist.map(function (v, idx) {
      var center = lo + (idx / (nBars - 1)) * width;
      return '<i class="' + (center < 0 ? "neg" : "") + '" style="height:' + Math.max(2, v / maxH * 100).toFixed(1) + '%"></i>';
    }).join("") + '</div>' +
      '<div class="fng-legend" style="margin-top:4px">横轴 ' + lo.toFixed(2) + ' R → ' + hi.toFixed(2) + ' R（红柱 = 亏损区间，共 ' + mc.iters + ' 次洗牌）</div>';
    html += '<div class="mini-title">蒙特卡洛：打乱成交顺序 ' + mc.iters + ' 次</div>' +
      '<div class="liq-tags">' +
      '<div class="liq-tag">终值 5% 分位 <b class="' + (mc.finalP5 >= 0 ? "up" : "down") + '">' + mc.finalP5.toFixed(2) + ' R</b></div>' +
      '<div class="liq-tag">终值中位 <b class="' + (mc.finalP50 >= 0 ? "up" : "down") + '">' + mc.finalP50.toFixed(2) + ' R</b></div>' +
      '<div class="liq-tag">终值 95% 分位 <b class="' + (mc.finalP95 >= 0 ? "up" : "down") + '">' + mc.finalP95.toFixed(2) + ' R</b></div>' +
      '<div class="liq-tag">回撤中位 <b>- ' + mc.mddP50.toFixed(2) + ' R</b></div>' +
      '<div class="liq-tag">回撤 95% 分位 <b>- ' + mc.mddP95.toFixed(2) + ' R</b></div>' +
      '<div class="liq-tag">亏损概率 <b class="' + (mc.lossProb < 50 ? "up" : "down") + '">' + mc.lossProb.toFixed(1) + '%</b></div>' +
      '</div>' + barsHtml +
      '<div class="size-note">打乱顺序不改变总收益（因为期望是线性的），改变的是<strong>路径</strong>：它告诉你「同样的收益，实际可能经历多大的回撤」。5% 分位终值才是你应该按它做心理准备的数字，而不是那个中位数。</div>';
  }
  // 滚动窗口稳定性
  var wins = btWindows(trades, 4);
  if (wins.length) {
    var wrows = wins.map(function (w) {
      var ws = w.stats;
      return '<tr><td>第 ' + w.idx + ' 段（' + new Date(w.from).toLocaleDateString("zh-CN") + ' ~ ' + new Date(w.to).toLocaleDateString("zh-CN") + '）</td><td>' + ws.n + '</td><td>' +
        ws.winRate.toFixed(1) + '%</td><td class="' + (ws.avgR >= 0 ? "up" : "down") + '">' + (ws.avgR >= 0 ? "+" : "") + ws.avgR.toFixed(3) + '</td><td>-' + ws.mdd.toFixed(2) + '</td></tr>';
    }).join("");
    var allPos = wins.every(function (w) { return w.stats.avgR > 0; });
    html += '<div class="mini-title">滚动窗口稳定性（按时间分 4 段）</div><div class="nt-wrap"><table class="nt"><thead><tr><th>时间段</th><th>笔数</th><th>胜率</th><th>每笔期望 R</th><th>最大回撤 R</th></tr></thead><tbody>' + wrows + '</tbody></table></div>' +
      '<div style="margin-top:var(--sp-2)"><span class="bt-tag ' + (allPos ? "ok" : "warn") + '">' + (allPos ? "四段期望均为正" : "并非每段都为正 —— 收益依赖特定行情") + '</span></div>';
  }
  var bb = btBlockBootstrap(trades, 400);
  if (bb) {
    html += '<div class="size-note">按块重采样（保留连续亏损的聚集，块长 ' + bb.block + '）：终值 5% 分位 <b class="' + (bb.finalP5 >= 0 ? "up" : "down") + '">' + bb.finalP5.toFixed(2) + ' R</b>，回撤 95% 分位 <b>- ' + bb.mddP95.toFixed(2) + ' R</b>，亏损概率 <b>' + bb.lossProb.toFixed(1) + '%</b>。通常比「打乱顺序」更悲观，更接近真实风险。</div>';
  }
  html += '<div class="size-note" style="margin-top:var(--sp-3);border-top:1px solid var(--border-soft);padding-top:var(--sp-3)">' +
    '<strong>口径说明（重要）：</strong>入场/止损/止盈全部取自应用自身的 <code>calcRiskReward</code>（支撑阻力位 + ATR 缓冲），因此已包含「过热区不做多」「贴近支撑不做空」两处否决；' +
    '出场按逐根 K 线的最高/最低价判断，先到先算（同一根内若止损与止盈都触及，按<strong>先止损</strong>处理，属保守假设）。' +
    '日线门控使用<strong>已收盘</strong>的日线，不含未来函数。<br>' +
    '<strong>成本模型：</strong>往返手续费 + 单边滑点（进出各一次）+ 资金费率（保守地多空都按支付计）；开盘即越过止损价按开盘价成交（跳空）；同一币种默认不重叠持仓，避免样本重复计数。<br>' +
    '<strong>已知不覆盖：</strong>BTC 趋势一票否决（依赖实时 BTC 分析，历史逐点还原成本过高）、币种池的幸存者偏差（只能测当前仍在交易的币）、滑点随成交量放大的非线性。' +
    '本页只做历史统计，<strong>不构成交易建议，也不会修改任何线上阈值</strong>。</div>';
  return html;
}
function renderBtFull(sym) {
  var box = document.getElementById("btFullBox");
  if (!box) return;
  var full = loadBtFullCfg();
  var cached = window.__btFullResult && window.__btFullResult.sym === sym ? window.__btFullResult : null;
  box.innerHTML =
    '<div class="mini-title" style="margin-top:var(--sp-5)">完整回测（含门控 + 实际止损止盈）</div>' +
    '<div class="size-note">上面那张表只算「固定持有 N 根」的远期收益，是<strong>近似</strong>；这一段逐根 K 线模拟真实持仓：用应用自身的支撑阻力 + ATR 止损止盈，并按可选日线门控过滤。</div>' +
    btFullFormHtml(full) +
    '<div id="btFullStatus" class="bt-status"></div>' +
    (cached ? btFullResultHtml(cached.res, cached.cfg) : '<div class="empty-note">还没跑过完整回测。参数沿用上面的周期 / 根数 / 步长 / 手续费。</div>') +
    '<div id="btSweepBox">' + (window.__btSweepHtml && window.__btSweepSym === sym ? window.__btSweepHtml : "") + '</div>' +
    '<div id="btPortBox">' + (window.__btPortHtml || "") + '</div>';
}
function btFullStatus(msg) {
  var el = document.getElementById("btFullStatus");
  if (el) el.innerHTML = msg || "";
}
async function runFullBacktest() {
  var sym = lastAnalysisSymbol || selectedCoin || "";
  if (sym && !/USDT$/.test(sym)) sym = sym + "USDT";
  if (!sym) { linkedToast("先选一个币种再做回测"); return; }
  var cfg = btReadForm();
  var full = loadBtFullCfg();
  var tpEl = document.getElementById("bf_tpR"), mhEl = document.getElementById("bf_maxHold"), dEl = document.getElementById("bf_useDaily");
  if (tpEl) { var v1 = parseFloat(tpEl.value); if (isFinite(v1) && v1 > 0) full.tpR = Math.min(20, v1); }
  if (mhEl) { var v2 = parseFloat(mhEl.value); if (isFinite(v2) && v2 >= 2) full.maxHold = Math.min(500, Math.round(v2)); }
  if (dEl) full.useDaily = !!dEl.checked;
  btReadFullExtras(full);
  saveBtFullCfg(full);
  var token = ++window.__btRun;
  btFullStatus('<span class="bt-spin">正在逐根模拟持仓…</span>');
  try {
    var res = await btFullSim(sym, cfg, full, token, function (k) {
      if (window.__btRun === token) btFullStatus('<span class="bt-spin">正在逐根模拟持仓… 已产生 ' + k + ' 笔交易</span>');
    });
    if (window.__btRun !== token) return;
    window.__btFullResult = { sym: sym, cfg: cfg, full: full, res: res, ts: Date.now() };
    renderBtFull(sym);
    linkedToast("完整回测完成：" + res.trades.length + " 笔（门控拦掉 " + res.gateBlocked + " 个信号）");
  } catch (e) {
    if (window.__btRun !== token) return;
    if (e && e.message === "__aborted__") return;
    btFullStatus('<span class="bt-err">完整回测失败：' + escapeHtml(e && e.message) + '</span>');
    console.warn("[app] full backtest failed:", e && e.message);
  }
}
function btReadFullExtras(full) {
  var num = function (id, lo, hi) { var el = document.getElementById(id); if (!el) return null; var v = parseFloat(el.value); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null; };
  var sl = num("bf_slip", 0, 2); if (sl !== null) full.slip = sl;
  var fu = num("bf_funding", 0, 1); if (fu !== null) full.funding = fu;
  var pn = num("bf_portN", 2, 40); if (pn !== null) full.portN = Math.round(pn);
  var no = document.getElementById("bf_noOverlap"); if (no) full.noOverlap = !!no.checked;
  return full;
}
// ---- 参数稳定性扫描：止盈倍数 × 最长持有，看「好结果」是孤岛还是一片 ----
var BT_SWEEP_TP = [1, 1.5, 2, 3];
var BT_SWEEP_HOLD = [12, 24, 48, 96];
function btHeatStyle(v) {
  if (v === null || !isFinite(v)) return "";
  var a = Math.min(0.45, Math.abs(v) * 1.2);
  return "background:" + (v >= 0 ? "rgba(34,197,94," : "rgba(239,68,68,") + a.toFixed(2) + ")";
}
function btSweepResultHtml(rows, cur) {
  var cell = function (r) {
    var os = r.os ? r.os.avgR : null;
    var isCur = r.tpR === cur.tpR && r.maxHold === cur.maxHold;
    return '<td style="' + btHeatStyle(r.all ? r.all.avgR : null) + (isCur ? ";outline:1px solid var(--accent, #58a6ff)" : "") + '">' +
      (r.all ? (r.all.avgR >= 0 ? "+" : "") + r.all.avgR.toFixed(3) : "--") +
      '<div class="bt-dim" style="font-size:11px">n=' + r.n + ' · 样本外 ' + (os === null ? "--" : (os >= 0 ? "+" : "") + os.toFixed(3)) + '</div></td>';
  };
  var head = '<tr><th>止盈 R ＼ 最长持有</th>' + BT_SWEEP_HOLD.map(function (h) { return '<th>' + h + ' 根</th>'; }).join("") + '</tr>';
  var body = BT_SWEEP_TP.map(function (tp) {
    return '<tr><th>' + tp + ' R</th>' + BT_SWEEP_HOLD.map(function (h) {
      var r = rows.find(function (x) { return x.tpR === tp && x.maxHold === h; });
      return r ? cell(r) : '<td>--</td>';
    }).join("") + '</tr>';
  }).join("");
  var posAll = rows.filter(function (r) { return r.all && r.all.avgR > 0; }).length;
  var posOs = rows.filter(function (r) { return r.os && r.os.avgR > 0; }).length;
  return '<div class="mini-title" style="margin-top:var(--sp-5)">参数稳定性扫描（每笔期望 R；格内为笔数与样本外期望）</div>' +
    '<div class="nt-wrap"><table class="nt">' + head + body + '</table></div>' +
    '<div class="size-note">' + rows.length + ' 个组合里整体为正 <b>' + posAll + '</b> 个、样本外为正 <b>' + posOs + '</b> 个。' +
    '<strong>好结果应当是连成一片的</strong>：如果只有一两格为正、旁边全是负，那是拟合出来的孤岛，不要采用。信号只算一次，各组合共用同一批信号与同一起点，因此可直接比较。</div>';
}
async function runBtSweep() {
  var sym = lastAnalysisSymbol || selectedCoin || "";
  if (sym && !/USDT$/.test(sym)) sym = sym + "USDT";
  if (!sym) { linkedToast("先选一个币种再做扫描"); return; }
  var cfg = btReadForm(), full = btReadFullExtras(loadBtFullCfg());
  var tpEl = document.getElementById("bf_tpR"), mhEl = document.getElementById("bf_maxHold"), dEl = document.getElementById("bf_useDaily");
  if (tpEl && isFinite(parseFloat(tpEl.value)) && parseFloat(tpEl.value) > 0) full.tpR = Math.min(20, parseFloat(tpEl.value));
  if (mhEl && isFinite(parseFloat(mhEl.value)) && parseFloat(mhEl.value) >= 2) full.maxHold = Math.min(500, Math.round(parseFloat(mhEl.value)));
  if (dEl) full.useDaily = !!dEl.checked;
  saveBtFullCfg(full);
  var token = ++window.__btRun;
  btFullStatus('<span class="bt-spin">正在采集信号…</span>');
  try {
    var maxHold = Math.max.apply(null, BT_SWEEP_HOLD);
    var sg = await btSignalsFor(sym, cfg, maxHold, token, function (k) {
      if (window.__btRun === token) btFullStatus('<span class="bt-spin">正在采集信号… 已得到 ' + k + ' 个</span>');
    });
    if (window.__btRun !== token) return;
    var daily = full.useDaily ? await btDailySeries(sym) : null;
    var rows = btSweep(sg.signals, sg.kl, daily, cfg.tf, full, btCostOf(cfg, full), BT_SWEEP_TP, BT_SWEEP_HOLD);
    window.__btSweepHtml = btSweepResultHtml(rows, full);
    window.__btSweepSym = sym;
    window.__btSweepRows = rows;
    var box = document.getElementById("btSweepBox"); if (box) box.innerHTML = window.__btSweepHtml;
    btFullStatus("");
  } catch (e) {
    if (e && e.message === "__aborted__") return;
    btFullStatus('<span class="bt-err">参数扫描失败：' + escapeHtml(e && e.message) + '</span>');
  }
}
// ---- 多币种组合回测：对成交额前 N 的币各跑一遍，按信号时间合并成一条净值曲线 ----
async function runBtPortfolio() {
  var cfg = btReadForm(), full = btReadFullExtras(loadBtFullCfg());
  var tpEl = document.getElementById("bf_tpR"), mhEl = document.getElementById("bf_maxHold"), dEl = document.getElementById("bf_useDaily");
  if (tpEl && isFinite(parseFloat(tpEl.value)) && parseFloat(tpEl.value) > 0) full.tpR = Math.min(20, parseFloat(tpEl.value));
  if (mhEl && isFinite(parseFloat(mhEl.value)) && parseFloat(mhEl.value) >= 2) full.maxHold = Math.min(500, Math.round(parseFloat(mhEl.value)));
  if (dEl) full.useDaily = !!dEl.checked;
  saveBtFullCfg(full);
  var syms = (allCoins || []).filter(function (c) { return c.volume > 10000000; }).slice(0, full.portN || 10).map(function (c) { return c.symbol; });
  if (syms.length < 2) { linkedToast("可用币种太少，先等行情加载完"); return; }
  var token = ++window.__btRun;
  var lists = [], failed = 0;
  try {
    for (var i = 0; i < syms.length; i++) {
      if (window.__btRun !== token) return;
      btFullStatus('<span class="bt-spin">组合回测 ' + (i + 1) + ' / ' + syms.length + '：' + escapeHtml(syms[i]) + '</span>');
      try {
        var r = await btFullSim(syms[i], cfg, full, token, null);
        lists.push({ sym: syms[i], trades: r.trades });
      } catch (e) {
        if (e && e.message === "__aborted__") return;
        failed++;
      }
    }
    var merged = btMergeTrades(lists);
    var perSym = lists.map(function (l) {
      var st = btFullStats(l.trades);
      return '<tr><td>' + escapeHtml(l.sym.replace(/USDT$/, "")) + '</td><td>' + l.trades.length + '</td><td class="' + (st && st.avgR >= 0 ? "up" : "down") + '">' + (st ? (st.avgR >= 0 ? "+" : "") + st.avgR.toFixed(3) : "--") + '</td></tr>';
    }).join("");
    window.__btPortTrades = merged;
    window.__btPortHtml = '<div class="mini-title" style="margin-top:var(--sp-5)">多币种组合回测（' + lists.length + ' 个币' + (failed ? "，" + failed + " 个失败" : "") + '）</div>' +
      '<div class="size-note">币种池取<strong>当前</strong>成交额靠前的币，存在幸存者偏差（已下架 / 已衰落的币不在其中），结果偏乐观。每笔仍按 1R 等风险计，未考虑同时持仓的总风险敞口。</div>' +
      btFullResultHtml({ trades: merged, overlapSkipped: 0 }, cfg) +
      '<div class="nt-wrap"><table class="nt"><thead><tr><th>币种</th><th>笔数</th><th>每笔期望 R</th></tr></thead><tbody>' + perSym + '</tbody></table></div>';
    var box = document.getElementById("btPortBox"); if (box) box.innerHTML = window.__btPortHtml;
    btFullStatus("");
  } catch (e) {
    btFullStatus('<span class="bt-err">组合回测失败：' + escapeHtml(e && e.message) + '</span>');
  }
}
window.runBtSweep = runBtSweep;
window.runBtPortfolio = runBtPortfolio;
function exportFullBacktestCsv() {
  var r = window.__btFullResult;
  if (!r || !r.res || !r.res.trades || !r.res.trades.length) { linkedToast("还没有完整回测结果可导出"); return; }
  var rows = r.res.trades.map(function (t) {
    return [new Date(t.ts).toISOString(), t.dir === "long" ? "多" : "空", t.score, t.entry, t.stop, t.tp, t.exit,
      t.reason, t.bars, t.grossR.toFixed(4), t.feeR.toFixed(4), (t.slipR || 0).toFixed(4), (t.fundR || 0).toFixed(4), t.netR.toFixed(4), t.gate];
  });
  var csv = toCsv(["信号时间", "方向", "评分", "入场价", "止损价", "止盈价", "出场价", "出场原因", "持有K线数", "毛收益R", "手续费R", "滑点R", "资金费R", "净收益R", "日线门控"], rows);
  var stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  downloadText("完整回测逐笔_" + r.sym.replace(/USDT$/, "") + "_" + stamp + ".csv", csv);
}
window.runFullBacktest = runFullBacktest;
window.exportFullBacktestCsv = exportFullBacktestCsv;
window.renderBtFull = renderBtFull;
window.btFullSim = btFullSim;
window.btFullStats = btFullStats;
window.btSplitStats = btSplitStats;
window.btMonteCarlo = btMonteCarlo;
window.btEquityPath = btEquityPath;
window.btAtr = btAtr;
window.btDailyGateAt = btDailyGateAt;
window.loadBtFullCfg = loadBtFullCfg;
window.btFullDefaults = btFullDefaults;