// NovaTrade 评分引擎（纯函数，无 DOM 依赖）：形态识别、analyzeCoin 打分、等级推导、BTC 联动修正、已收盘 K 线过滤。
// 经典脚本（非模块），与 indicators.js / analysis-core.js 共享全局作用域；
// 浏览器按 <script> 顺序加载，Node（回测 CLI / 单元测试）由 bt/engine.js 按同样顺序在 vm 中加载。

/* ===== 已收盘 K 线过滤 =====
   币安返回的最后一根 K 线通常还在走（closeTime 在未来）。拿它算指标有两个问题：
   ① 信号会随这根 K 线的每次跳动来回翻转（重绘）；
   ② 量比 = 当前这根的量 / 前 20 根均量，K 线刚开始时量天然很小，放量信号会被系统性漏掉。
   而回测只用已收盘 K 线，实盘不过滤就与回测口径不一致。
   依据：原始 K 线第 7 项 closeTime（毫秒）。asOfMs 默认取当前时间；
   用本地缓存兜底时要传「缓存写入时间」，否则当时还没走完的那根会被误判为已收盘。
   注意：依赖本机时钟大致准确（系统时间被改快时会把未收盘 K 线误当已收盘）。 */
function dropOpenCandle(rows, asOfMs) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const last = rows[rows.length - 1];
  const closeTime = Number(last && last[6]);
  const asOf = isFinite(asOfMs) && asOfMs > 0 ? asOfMs : Date.now();
  return (isFinite(closeTime) && closeTime >= asOf) ? rows.slice(0, -1) : rows;
}
window.dropOpenCandle = dropOpenCandle;

function formatPrice(t) {
  if (!t && t !== 0) return "--";
  const e = parseFloat(t);
  if (isNaN(e)) return "--";
  if (e >= 1000) return e.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (e >= 10) return e.toFixed(2);
  if (e >= 1) return e.toFixed(3);
  if (e >= 0.01) return e.toFixed(4);
  if (e >= 0.0001) return e.toFixed(6);
  return e.toFixed(8);
}

function detectPatterns(ohlc) {
  const patterns = [];
  const len = ohlc.length;
  if (len < 10) return patterns;
  const last = ohlc[len-1], prev = ohlc[len-2];
  // ohlc 行格式: [time, open, high, low, close, volume]
  const open = last[1], high = last[2], low = last[3], close = last[4];
  const body = Math.abs(close-open), range = high-low;
  const upperWick = high-Math.max(open,close);
  const lowerWick = Math.min(open,close)-low;
  const isBull = close > open;
  if (range > 0 && lowerWick > body*2 && upperWick < range*0.3) {
    if (isBull) patterns.push({n:"锤子线（看涨反转）", t:"bull"});
    else patterns.push({n:"吊颈线（看跌警示）", t:"bear"});
  }
  if (range > 0 && upperWick > body*2 && lowerWick < range*0.3) {
    if (isBull) patterns.push({n:"倒锤子线（需确认）", t:"bull"});
    else patterns.push({n:"流星线（看跌反转）", t:"bear"});
  }
  if (prev && range > 0) {
    const prevBody = Math.abs(prev[4]-prev[1]), prevBull = prev[4] > prev[1];
    if (body > prevBody*1.3 && !prevBull && isBull && close > prev[1] && open <= prev[4]) patterns.push({n:"看涨吞没", t:"bull"});
    else if (body > prevBody*1.3 && prevBull && !isBull && close < prev[1] && open >= prev[4]) patterns.push({n:"看跌吞没", t:"bear"});
  }
  if (range > 0 && body < range*0.1) patterns.push({n:"十字星（变盘信号）", t:"neutral"});
  if (len >= 3) {
    const l3 = ohlc[len-3];
    if (isBull && prev[4] > prev[1] && l3[4] > l3[1]) patterns.push({n:"三阳推进", t:"bull"});
    if (!isBull && prev[4] < prev[1] && l3[4] < l3[1]) patterns.push({n:"三阴推进", t:"bear"});
  }
  return patterns;
}

window._origDetectPatterns = detectPatterns;
window.detectPatterns = detectPatternsEnhanced;

function analyzeCoin(closes, symbol, ohlc) {
  const now = closes[closes.length-1], prev = closes[closes.length-2];
  const change = ((now-prev)/prev)*100;
  const ma7 = Indicators.SMA(closes,7), ma25 = Indicators.SMA(closes,25), ma99 = Indicators.SMA(closes,99);
  const macd = Indicators.MACD(closes), macdHist = Indicators.MACDHist(closes);
  const rsi = Indicators.RSI(closes), bb = Indicators.BB(closes);
  const adx = Indicators.ADX(closes, 14, 14, ohlc), di = Indicators.DI(closes, 14, ohlc);
  const ribbon = Indicators.EMA_Ribbon(closes, [7,15,25,50]);
  const volumes = ohlc ? ohlc.map(k => parseFloat(k[5])||0) : null;
  const volAvg = volumes ? volumes.slice(-20).reduce((a,b)=>a+b,0)/20 : null;
  const lastVol = volumes ? volumes[volumes.length-1] : 0;
  const volRatio = volAvg ? lastVol/volAvg : 1;
  const signals = [];
  const isStrongTrend = adx && adx.adx > 25, isRanging = adx && adx.adx < 20;
  let score = 50;
  const ma7p = Indicators.SMA(closes.slice(0,-1),7), ma25p = Indicators.SMA(closes.slice(0,-1),25), ma99p = Indicators.SMA(closes.slice(0,-1),99);
  if (ma7 > ma25 && ma7p !== null && ma25p !== null && ma7p <= ma25p) { score += 10; signals.push({n:"MA7金叉MA25（新信号）",t:"bull"}); }
  else if (ma7 < ma25 && ma7p !== null && ma25p !== null && ma7p >= ma25p) { score -= 10; signals.push({n:"MA7死叉MA25（新信号）",t:"bear"}); }
  else if (ma7 > ma25) { score += 6; signals.push({n:"MA7位于MA25上方（多头排列）",t:"bull"}); }
  else if (ma7 < ma25) { score -= 6; signals.push({n:"MA7位于MA25下方（空头排列）",t:"bear"}); }
  if (ma25 > ma99 && ma25p !== null && ma99p !== null && ma25p <= ma99p) { score += 7; signals.push({n:"MA25金叉MA99（新信号）",t:"bull"}); }
  else if (ma25 < ma99 && ma25p !== null && ma99p !== null && ma25p >= ma99p) { score -= 7; signals.push({n:"MA25死叉MA99（新信号）",t:"bear"}); }
  else if (ma25 > ma99) { score += 4; signals.push({n:"MA25位于MA99上方（中期多头）",t:"bull"}); }
  else if (ma25 < ma99) { score -= 4; signals.push({n:"MA25位于MA99下方（中期空头）",t:"bear"}); }
  if (macdHist !== null && macd !== null) {
    if (macdHist > 0 && macd > 0) { score += 6; signals.push({n:"MACD零轴上方柱为正，多头动能",t:"bull"}); }
    else if (macdHist < 0 && macd < 0) { score -= 6; signals.push({n:"MACD零轴下方柱为负，空头动能",t:"bear"}); }
    else if (macdHist > 0) { score += 3; signals.push({n:"MACD柱翻正（动能修复早期）",t:"bull"}); }
    else if (macdHist < 0) { score -= 3; signals.push({n:"MACD柱翻负（动能转弱早期）",t:"bear"}); }
  }
  const rsiW = isStrongTrend ? 3 : 10;
  if (rsi < 30) { score += rsiW; signals.push({n:"RSI="+rsi.toFixed(1)+(isStrongTrend?"，趋势中超卖（弱化反转）":"，超卖区域"),t:"bull"}); }
  else if (rsi > 70) { score -= rsiW; signals.push({n:"RSI="+rsi.toFixed(1)+(isStrongTrend?"，趋势中超买（弱化反转）":"，超买区域"),t:"bear"}); }
  if (bb) {
    const bbPos = (now-bb.low)/(bb.up-bb.low);
    const bbW = isStrongTrend ? 2 : 5;
    if (bbPos < 0.2) { score += bbW; signals.push({n:"价格触及布林带下轨",t:"bull"}); }
    else if (bbPos > 0.8) { score -= bbW; signals.push({n:"价格触及布林带上轨",t:"bear"}); }
  }
  if (isStrongTrend && di && di.pdi > di.mdi) { score += 5; signals.push({n:"ADX趋势明确，DI+占优",t:"bull"}); }
  else if (isStrongTrend && di && di.mdi > di.pdi) { score -= 5; signals.push({n:"ADX趋势明确，DI-占优",t:"bear"}); }
  const lastCandle = ohlc ? ohlc[ohlc.length-1] : null;
  if (volRatio > 1.5 && lastCandle) {
    if (lastCandle[4] > lastCandle[1]) { score += 4; signals.push({n:"放量上涨（"+volRatio.toFixed(1)+"倍）",t:"bull"}); }
    else if (lastCandle[4] < lastCandle[1]) { score -= 4; signals.push({n:"放量下跌（"+volRatio.toFixed(1)+"倍）",t:"bear"}); }
  }
  const patterns = detectPatterns(ohlc);
  patterns.forEach(p => { score += p.t==="bull"?3:(p.t==="bear"?-3:0); signals.push(p); });
  const dominance = Math.abs(score-50)/50;
  const totalSignals = signals.length;
  let rec, badge;
  if (score >= 70) { rec="强烈买入"; badge="strong-buy"; }
  else if (score >= SIGNAL_LONG_MIN) { rec="买入"; badge="buy"; }
  else if (score >= SHORT_SCORE_MIN) { rec="持有"; badge="hold"; }
  else if (score >= 30) { rec="卖出"; badge="sell"; }
  else { rec="强烈卖出"; badge="strong-sell"; }
  const marketState = isStrongTrend?"趋势明确":isRanging?"震荡市":"弱趋势";
  const confidence = Math.min(95, Math.max(10, Math.round(Math.abs(score-50)*2)));
  const bullish = signals.filter(s=>s.t==="bull").length;
  const bearish = signals.filter(s=>s.t==="bear").length;
  const text = score>=SIGNAL_LONG_MIN
    ? "技术指标显示看涨信号，建议关注买入机会。当前"+marketState+"，综合"+signals.length+"个信号中"+bullish+"个看涨、"+bearish+"个看跌。"
    : score>=SHORT_SCORE_MIN
    ? "市场处于平衡状态，建议观望等待更明确的信号。综合"+signals.length+"个技术分析信号。"
    : "技术指标显示看跌信号，建议谨慎操作。当前"+marketState+"，注意风险控制。";
  return {
    price: now, change: change, score: score, rec: rec, badge: badge,
    signals: signals, dominance: dominance, totalSignals: totalSignals,
    marketState: marketState, confidence: confidence, text: text,
    trendDir: score >= SIGNAL_LONG_MIN ? "看涨" : score >= SHORT_SCORE_MIN ? "震荡" : "看跌",
    bullish: bullish, bearish: bearish,
    indicators: {
      ma7: formatPrice(ma7), ma25: formatPrice(ma25), ma99: formatPrice(ma99),
      macd: formatPrice(macd), macdHist: formatPrice(macdHist),
      rsi: (rsi !== null && rsi !== undefined) ? rsi.toFixed(1) : "--",
      bbLow: formatPrice(bb ? bb.low : 0), bbUp: formatPrice(bb ? bb.up : 0),
      bbWidth: bb ? ((bb.up - bb.low) / bb.mid * 100).toFixed(2) : "--",
      adx: adx ? adx.adx.toFixed(1) : "--", pdi: di ? di.pdi.toFixed(1) : "--", mdi: di ? di.mdi.toFixed(1) : "--"
    },
    volRatio: volRatio,
  };
}
// 根据 score 统一推导推荐等级/方向/置信度（供多周期聚合与 BTC 联动修正后重新定级）
function deriveLevels(a) {
  const s = a.score;
  a.rec = s>=70?"强烈买入":s>=SIGNAL_LONG_MIN?"买入":s>=SHORT_SCORE_MIN?"持有":s>=30?"卖出":"强烈卖出";
  a.badge = s>=70?"strong-buy":s>=SIGNAL_LONG_MIN?"buy":s>=SHORT_SCORE_MIN?"hold":s>=30?"sell":"strong-sell";
  a.trendDir = s>=SIGNAL_LONG_MIN?"看涨":s>=SHORT_SCORE_MIN?"震荡":"看跌";
  a.direction = a.trendDir; // 1006：同步 direction，避免多周期聚合后残留基底周期单方结论
  a.trend = s>=SIGNAL_LONG_MIN?"上涨趋势":s>=SHORT_SCORE_MIN?"震荡":"下跌趋势";
  a.signal = s>=SIGNAL_LONG_MIN?"买入信号":s>=SHORT_SCORE_MIN?"中性":"卖出信号";
  a.confidence = Math.min(95, Math.max(10, Math.round(Math.abs(s-50)*2)));
  return a;
}
// BTC 联动修正：仅当 BTC 处于明确趋势（ADX>25）时打分；BTC 自身不联动
// 1006 做空门控①：BTC 明确偏多（ADX>25 且 score≥65）时，山寨做空一票否决（打 shortVeto 标记，
// 由 calcRiskReward 据此拒绝给出做空建议）；对称 ±8 打分保留用于多头侧。
function applyBtcRegime(a) {
  a.shortVeto = false; a.btcHit = false;   // 每次重新判定，不沿用复制来的旧标记
  const btc = window.__btcRegime;
  if (!btc || !isFinite(btc.adx) || btc.adx <= 25) return a;
  if (a.symbol === "BTCUSDT" || a.symbol === "BTCUSDC") return a;
  if (btc.score < SIGNAL_SHORT_MAX && a.score >= SIGNAL_LONG_MIN) { a.score = Math.max(0, a.score - 8); a.signals.push({n:"BTC趋势偏空，多头信号打折",t:"bear"}); deriveLevels(a); }
  else if (btc.score >= SIGNAL_LONG_MIN && a.score < SIGNAL_SHORT_MAX) { a.score = Math.min(100, a.score + 8); a.signals.push({n:"BTC趋势偏多，空头信号打折",t:"bull"}); deriveLevels(a); }
  if (btc.score >= SIGNAL_LONG_MIN && a.score < SHORT_SCORE_MIN) {
    a.btcHit = true;                                  // 台账记录用：这道门控本来会不会拦
    if (gateCfg().btcVeto) { a.shortVeto = true; a.signals.push({n:"BTC趋势偏多，做空信号否决→观望",t:"neutral"}); }
  }
  return a;
}
