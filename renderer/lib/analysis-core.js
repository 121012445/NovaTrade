// ===== NovaTrade 增强分析模块 =====
// ===== 信号门槛统一口径（唯一来源，其他位置禁止写死数字）=====
// 多头信号：score ≥ SIGNAL_LONG_MIN(65)；空头信号：score < SIGNAL_SHORT_MAX(45)，但 1006 起做空收紧为
// score < SHORT_SCORE_MIN(39) 才给出做空建议（45-44 区间并入观望）；39-64 一律观望、不提供方向与 TP/SL。
// 依据回测 A/B（bt/VERDICT_20261002）：65 vs 55 每笔期望 +0.33U→+0.47U、收益/回撤 3.06→4.54。
// 做空收紧依据前向验证（FWD_MONITOR 20261006，n=14 空单命中 35.7%、赢小亏大 +1.45%/-6.09%）：只空 score≤39 的子集命中 50%。
// 1007 过热区过滤（依据 FWD_MONITOR 20261007 裁决B）：70-74 段 4h 命中率 14.29%/-0.44%，比 65-69 段
// 40.00%/+0.29% 低 25.71pp ≥ 5pp → 过热区标签升级为过滤规则，score∈[70,75) 不再给出做多建议。
// 1007 多头 regime 门控（对称于 1006 空头日线门控）：做多推荐需日线 EMA20>EMA50 上行；空头日做多同样观望。
// 1007 做空处置（裁决C 缓行）：不关闭做空，保留 1006 门控，等 gated=true 空单结算满 20 笔后再复评。
// 本文件由多段独立 <script> 组成，段间仅通过 window 共享；本段最先声明（var 挂 window），
// 供本段 calcRiskReward 及后段（评级/推荐/计数/前向验证/颜色）裸引用。
var SIGNAL_LONG_MIN = 65;
var SIGNAL_SHORT_MAX = 45;
var SHORT_SCORE_MIN = 39; // 1006：空侧收紧门槛，score < 39 才允许做空建议
var OVERHEAT_MIN = 70;    // 1007：过热区下界（含）
var OVERHEAT_MAX = 75;    // 1007：过热区上界（不含），[70,75) 为过热过滤区
var MIN_ACTION_CONFIDENCE = 50; // 低于此值只展示方向观察，不给交易动作
var FWD_QUALITY_MIN_N = 30;     // 前向验证至少积累 30 条后才判断是否可行动
var FWD_QUALITY_MIN_HIT = 50;   // 命中率低于随机基线时降级为仅观察
// 1010 止损距离上限（2026-10-10 新增，依据 CHANGELOG §十一 的对照回测）：
// 止损距离被钳制在 1~2 倍 ATR，但 ATR 本身没有上限 —— 实测出现过止损距离 24.6%、最高 44.7% 的信号，
// 单笔风险是正常单（中位约 2%）的 10~20 倍。这里给「止损距离占价格的比例」设一个硬天花板。
//
// 对照回测（24 币 / 1h / 4 个时间窗口 / 日线门控开，累计 R 口径）：
//   窗口       关闭     10%     12%     15%     20%
//   bars=450  -10.4   -12.4   -11.4    -7.5   -10.4
//   bars=600  +42.0   +38.0   +39.0   +45.9   +43.0
//   bars=750  +36.3   +32.4   +33.3   +40.3   +37.3
//   bars=900   -4.2   -14.1   -10.2    -4.2    -4.5
// 15% 在四个窗口上**全部不劣于关闭**（三个更优、一个持平），而 10%/12% 四个窗口全部更差。
// ⇒ 收得太紧会砍掉真正赚钱的大波动单（宽止损单在 bars=900 上累计 +30.8R），只有放到 15% 才只砍病态尾部。
// 该阈值只移除约 1% 的信号，把最大止损距离从 24.6%/44.7% 压到约 15%。
//
// 【定性】这是**尾部风险护栏**，不是收益优化器 —— 不要指望它提高胜率（实测胜率几乎不变）。
// 设为 0 可关闭；回测 A/B 时可用 window.__maxStopPct 临时覆盖。
var MAX_STOP_PCT = 15.0;
window.MAX_STOP_PCT = MAX_STOP_PCT;
// 统一的信号否决判定：新增否决类型只需改这一处，避免在 7 个调用点各写一遍 ||
function isVetoed(a) {
  if (!a) return false;
  return !!(a.shortVeto || a.nearSupportVeto || a.overheatVeto || a.stopCapVeto);
}
window.isVetoed = isVetoed;
window.SIGNAL_LONG_MIN = SIGNAL_LONG_MIN;
window.SIGNAL_SHORT_MAX = SIGNAL_SHORT_MAX;
window.SHORT_SCORE_MIN = SHORT_SCORE_MIN;
window.OVERHEAT_MIN = OVERHEAT_MIN;
window.OVERHEAT_MAX = OVERHEAT_MAX;
// 融合 TrendIQ 核心功能

function findSupportResistance(ohlc, lookback = 50) {
  if (!ohlc || ohlc.length < 10) return { supports: [], resistances: [] };
  const data = ohlc.slice(-lookback);
  const supports = [];
  const resistances = [];
  const window = 5;
  for (let i = window; i < data.length - window; i++) {
    const isLow = data[i][3] <= Math.min(...data.slice(i-window,i+window+1).map(k=>k[3]));
    const isHigh = data[i][2] >= Math.max(...data.slice(i-window,i+window+1).map(k=>k[2]));
    if (isLow) supports.push({ price: data[i][3], time: data[i][0] });
    if (isHigh) resistances.push({ price: data[i][2], time: data[i][0] });
  }
  // Cluster nearby levels
  function cluster(levels, threshold = 0.02) {
    if (levels.length === 0) return [];
    const clusters = [];
    const sorted = levels.sort((a,b) => a.price - b.price);
    let group = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].price - group[0].price) / group[0].price < threshold) {
        group.push(sorted[i]);
      } else {
        clusters.push({ price: group.reduce((s,g)=>s+g.price,0)/group.length, strength: group.length, times: group.map(g=>g.time) });
        group = [sorted[i]];
      }
    }
    if (group.length > 0) clusters.push({ price: group.reduce((s,g)=>s+g.price,0)/group.length, strength: group.length, times: group.map(g=>g.time) });
    return clusters.sort((a,b) => b.strength - a.strength);
  }
  return { supports: cluster(supports), resistances: cluster(resistances) };
}

// 取某周期 OHLC 中距现价最近的上方阻力 / 下方支撑（各 1 个）
function nearestSRLevels(ohlc, price, lookback) {
  if (!ohlc || ohlc.length < 30 || !isFinite(price)) return null;
  const { supports, resistances } = findSupportResistance(ohlc, lookback || Math.min(ohlc.length, 120));
  const res = (resistances||[]).filter(r => r.price > price).sort((a,b) => a.price - b.price)[0] || null;
  const sup = (supports||[]).filter(s => s.price < price).sort((a,b) => b.price - a.price)[0] || null;
  if (!res && !sup) return null;
  return { res: res, sup: sup };
}

// 1h/4h/1d 三周期的最近支撑阻力统一渲染（阻力=现价上方最近，支撑=现价下方最近）
function multiTfSrHtml(tfOhlc, price) {
  if (!tfOhlc || !isFinite(price)) return "";
  let rows = "";
  for (const tf of ["1h","4h","1d"]) {
    const lv = nearestSRLevels(tfOhlc[tf], price);
    if (!lv) continue;
    rows += "<div class='trendiq-sr-row sr-multi'>" +
      "<span class='trendiq-sr-label'>" + tf.toUpperCase() + "</span>" +
      "<span class='trendiq-sr-val resistance'>" + (lv.res ? formatPrice(lv.res.price) : "--") + "</span>" +
      "<span class='trendiq-sr-val support'>" + (lv.sup ? formatPrice(lv.sup.price) : "--") + "</span>" +
      "</div>";
  }
  if (!rows) return "";
  return "<div class='trendiq-sr-row sr-multi sr-head'><span class='trendiq-sr-label'>周期</span>" +
    "<span class='trendiq-sr-label'>阻力 · 上方最近</span>" +
    "<span class='trendiq-sr-label'>支撑 · 下方最近</span></div>" + rows;
}

function findTrendlines(ohlc, maxCandles = 100) {
  if (!ohlc || ohlc.length < 20) return { uptrend: null, downtrend: null };
  const data = ohlc.slice(-maxCandles);
  const highs = data.map((k,i) => ({ price: k[2], idx: i }));
  const lows = data.map((k,i) => ({ price: k[3], idx: i }));
  function linearRegression(points) {
    if (points.length < 2) return null;
    const n = points.length;
    let sx=0, sy=0, sxy=0, sxx=0;
    points.forEach(p => { sx+=p.idx; sy+=p.price; sxy+=p.idx*p.price; sxx+=p.idx*p.idx; });
    const slope = (n*sxy-sx*sy)/(n*sxx-sx*sx);
    const intercept = (sy-slope*sx)/n;
    const r2 = Math.abs(slope) > 0.0001 ? 1 : 0;
    return { slope, intercept, r2, endPrice: slope*(n-1)+intercept };
  }
  // Find swing points for trendlines
  function swingPoints(points, span=5) {
    const sw = [];
    for (let i=span; i<points.length-span; i++) {
      const slice = points.slice(i-span, i+span+1);
      if (points[i].price === Math.min(...slice.map(p=>p.price))) sw.push(points[i]);
      if (points[i].price === Math.max(...slice.map(p=>p.price))) sw.push({...points[i], isHigh: true});
    }
    return sw;
  }
  const lowSwings = swingPoints(lows.map(p=>({price:p.price,idx:p.idx})), 5);
  const highSwings = swingPoints(highs.map(p=>({price:p.price,idx:p.idx})), 5);
  const uptrend = linearRegression(lowSwings.slice(-4).map(p=>({idx:p.idx,price:p.price})));
  const downtrend = linearRegression(highSwings.slice(-4).map(p=>({idx:p.idx,price:p.price})));
  return { uptrend, downtrend };
}

function detectAdvancedPatterns(ohlc) {
  const patterns = [];
  const len = ohlc.length;
  if (len < 30) return patterns;
  const closes = ohlc.map(k=>parseFloat(k[4]));
  const highs = ohlc.map(k=>parseFloat(k[2]));
  const lows = ohlc.map(k=>parseFloat(k[3]));
  const last = ohlc[len-1], prev = ohlc[len-2];
  const body = Math.abs(last[4]-last[1]), range = last[2]-last[3];
  const isBull = last[4] > last[1];

  // Double Top
  if (len >= 20) {
    const recentHighs = [];
    for (let i=len-20; i<len-5; i++) {
      let isPeak = true;
      for (let j=Math.max(0,i-2); j<=Math.min(len-1,i+2); j++) {
        if (i!==j && highs[j]>=highs[i]) isPeak=false;
      }
      if (isPeak) recentHighs.push({idx:i, price:highs[i]});
    }
    if (recentHighs.length >= 2) {
      const h1 = recentHighs[recentHighs.length-2], h2 = recentHighs[recentHighs.length-1];
      const neckline = Math.min(...lows.slice(h1.idx+1, h2.idx+1));
      if (Math.abs(h1.price-h2.price)/h1.price < 0.02 && last[4] < neckline*1.02) {
        patterns.push({n:"双顶（看跌反转）", t:"bear", level: neckline});
      }
    }
  }
  // Double Bottom
  if (len >= 20) {
    const recentLows = [];
    for (let i=len-20; i<len-5; i++) {
      let isValley = true;
      for (let j=Math.max(0,i-2); j<=Math.min(len-1,i+2); j++) {
        if (i!==j && lows[j]<=lows[i]) isValley=false;
      }
      if (isValley) recentLows.push({idx:i, price:lows[i]});
    }
    if (recentLows.length >= 2) {
      const l1 = recentLows[recentLows.length-2], l2 = recentLows[recentLows.length-1];
      const neckline = Math.max(...highs.slice(l1.idx+1, l2.idx+1));
      if (Math.abs(l1.price-l2.price)/l1.price < 0.02 && last[4] > neckline*0.98) {
        patterns.push({n:"双底（看涨反转）", t:"bull", level: neckline});
      }
    }
  }
  // Rising Wedge
  if (len >= 20) {
    const slice = ohlc.slice(-20);
    const sliceHighs = slice.map(k=>k[2]), sliceLows = slice.map(k=>k[3]);
    const hRise = (sliceHighs[sliceHighs.length-1]-sliceHighs[0])/sliceHighs[0];
    const lRise = (sliceLows[sliceLows.length-1]-sliceLows[0])/sliceLows[0];
    if (hRise > 0 && lRise > 0 && lRise > hRise && hRise < 0.15) {
      patterns.push({n:"上升楔形（看跌反转）", t:"bear"});
    }
  }
  // Bull Flag
  if (len >= 15) {
    const recent = closes.slice(-15);
    const prior = closes.slice(-30, -15);
    const priorRally = prior[prior.length-1] > prior[0] * 1.05;
    const flagConsolidation = Math.max(...recent)/Math.min(...recent) < 1.08;
    if (priorRally && flagConsolidation && isBull) {
      patterns.push({n:"牛市旗（看涨延续）", t:"bull"});
    }
  }
  // Head and Shoulders (simplified)
  if (len >= 30) {
    const slice = ohlc.slice(-30);
    const shHighs = slice.map((k,i)=>({price:k[2],idx:i}));
    const peaks = [];
    for (let i=3; i<shHighs.length-3; i++) {
      const window = shHighs.slice(i-3,i+4);
      if (shHighs[i].price === Math.max(...window.map(w=>w.price))) peaks.push(shHighs[i]);
    }
    if (peaks.length >= 3) {
      const p1=peaks[peaks.length-3], p2=peaks[peaks.length-2], p3=peaks[peaks.length-1];
      const avgNeck = (p1.price + p3.price) / 2;
      if (Math.abs(p1.price-p3.price)/p1.price < 0.03 && p2.price > p1.price*1.03 && last[4] < avgNeck*1.02) {
        patterns.push({n:"头肩顶（看跌反转）", t:"bear", level: avgNeck});
      }
    }
  }
  // Cup and Handle
  if (len >= 30) {
    const slice = closes.slice(-30);
    const cupLow = Math.min(...slice);
    const cupHigh = Math.max(...slice.slice(0,15));
    const handle = slice.slice(15);
    const handleLow = Math.min(...handle);
    if (cupHigh > cupLow*1.1 && handleLow > cupLow*0.95 && last[4] > handle[handle.length-1]*1.01) {
      patterns.push({n:"杯柄形态（看涨延续）", t:"bull"});
    }
  }
  // Ascending Triangle
  if (len >= 25) {
    const slice = ohlc.slice(-25);
    const highs25 = slice.map(k=>k[2]), lows25 = slice.map(k=>k[3]);
    const topResistance = highs25.slice(-10);
    const consistentTop = topResistance.slice(1).every((h,i)=>Math.abs(h-topResistance[0])/topResistance[0]<0.03);
    const risingLows = lows25[lows25.length-1] > lows25[0]*1.02;
    if (consistentTop && risingLows && isBull && last[2] > topResistance[0]*0.99) {
      patterns.push({n:"上升三角形（看涨突破）", t:"bull", level: topResistance[0]});
    }
  }
  // Descending Triangle
  if (len >= 25) {
    const slice = ohlc.slice(-25);
    const highs25 = slice.map(k=>k[2]), lows25 = slice.map(k=>k[3]);
    const botSupport = lows25.slice(-10);
    const consistentBot = botSupport.slice(1).every((l,i)=>Math.abs(l-botSupport[0])/botSupport[0]<0.03);
    const fallingHighs = highs25[highs25.length-1] < highs25[0]*0.98;
    if (consistentBot && fallingHighs && !isBull && last[4] < botSupport[0]*0.99) {
      patterns.push({n:"下降三角形（看跌突破）", t:"bear", level: botSupport[0]});
    }
  }
  return patterns;
}

function calcRiskReward(analysis, ohlc, livePrice) {
  if (!analysis || !ohlc || ohlc.length < 20) return null;
  const last = ohlc[ohlc.length-1];
  // ohlc 为已收盘 K 线（结构位 / ATR 的来源）；livePrice 为此刻的最新价，缺省时退回最后一根收盘价。
  // 入场价必须是「现在能成交的价格」，否则 4h 基底下入场价最多会落后 4 小时。
  const price = (isFinite(livePrice) && livePrice > 0) ? livePrice : last[4];
  const { supports, resistances } = findSupportResistance(ohlc);
  // ATR-based calculation
  const atrPeriod = 14;
  let atr = 0;
  if (ohlc.length >= atrPeriod + 1) {
    const trs = [];
    for (let i = 1; i < ohlc.length; i++) {
      const high = ohlc[i][2], low = ohlc[i][3];
      const prevClose = ohlc[i-1][4];
      trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    atr = trs.slice(-atrPeriod).reduce((a,b)=>a+b,0) / atrPeriod;
  }
  atr = atr || price * 0.02;
  let entry, stopLoss, direction;
  const supBelow = supports.map(s=>s.price).filter(p=>p<price);
  const resAbove = resistances.map(r=>r.price).filter(p=>p>price);
  if (analysis.score >= SIGNAL_LONG_MIN) {
    // 1007 过热区过滤（裁决B）：score∈[70,75) 前向验证 4h 命中率仅 14.29%（65-69 段为 40.00%），拒绝给出做多 TP/SL
    if (analysis.score >= OVERHEAT_MIN && analysis.score < OVERHEAT_MAX) { analysis.overheatVeto = true; return null; }
    direction = "long";
    entry = price;
    // 止损挂在最近支撑下方 0.5ATR，距离限制在 1~2 倍 ATR，否则回退 1.5ATR
    stopLoss = supBelow.length ? Math.max(...supBelow) - atr*0.5 : price - atr*1.5;
    if (price - stopLoss < atr || price - stopLoss > atr*2) stopLoss = price - atr*1.5;
  } else if (analysis.score < SHORT_SCORE_MIN) {
    // 1006 做空门控②：BTC 明确偏多（ADX>25 且 score≥65）时空单一票否决 → 观望
    if (analysis.shortVeto) return null;
    // 1006 做空门控③：现价距最近支撑 <1ATR 不空（反弹最易发生在支撑位，入场即接飞刀）
    if (supBelow.length) {
      const __nearestSup = Math.max(...supBelow);
      if (price - __nearestSup < atr) { analysis.nearSupportVeto = true; return null; }
    }
    direction = "short";
    entry = price;
    stopLoss = resAbove.length ? Math.min(...resAbove) + atr*0.5 : price + atr*1.5;
    if (stopLoss - price < atr || stopLoss - price > atr*2) stopLoss = price + atr*1.5;
  } else return null;
  const risk = Math.abs(entry - stopLoss);
  // 1010 止损距离上限：止损由 ATR 推导，而 ATR 无上限，极端波动币会给出 20%+ 的止损。
  // 超过上限就直接否决这条信号（尾部风险护栏，见 CHANGELOG §十一 的对照回测）。
  const __stopCap = (typeof window !== "undefined" && typeof window.__maxStopPct === "number")
    ? window.__maxStopPct : MAX_STOP_PCT;
  if (__stopCap > 0 && risk / entry * 100 > __stopCap) { analysis.stopCapVeto = true; return null; }
  // 止盈三档：优先锚定真实结构位（跳过过近、挂不住的），结构位不足时才按 R 倍数补足
  const buf = atr * 0.25;
  const dirLong = direction === "long";
  let lvls;
  if (dirLong) {
    lvls = resAbove.filter(p => p - buf > entry + risk * 0.5).sort((a,b)=>a-b);
  } else {
    lvls = supBelow.filter(p => p + buf < entry - risk * 0.5).sort((a,b)=>b-a);
  }
  const tps = [];
  let prev = entry;
  for (let n = 0; n < 3; n++) {
    const mult = n + 1;
    const rTarget = dirLong ? entry + risk * mult : entry - risk * mult;
    let tp = (lvls.length > n) ? (dirLong ? lvls[n] - buf : lvls[n] + buf) : rTarget;
    // 相邻两档至少间隔 0.5R，避免重叠/倒挂
    if (dirLong) { if (tp < prev + risk * 0.5) tp = Math.max(rTarget, prev + risk * 0.5); }
    else { if (tp > prev - risk * 0.5) tp = Math.min(rTarget, prev - risk * 0.5); }
    tps.push({ label: "TP" + mult + (lvls.length > n ? "·结构位" : "·" + mult + "R"), price: tp, rr: (Math.abs(tp - entry) / risk).toFixed(2) + ":1" });
    prev = tp;
  }
  const takeProfit = tps[1].price; // 兼容旧字段：基准盈亏比取 TP2
  const rr = risk > 0 ? (Math.abs(takeProfit - entry) / risk).toFixed(2) : "0.00";
  const riskPct = (risk / entry * 100).toFixed(2);
  // 返回原始数值，由各显示层统一 formatPrice（避免二次格式化把 "84,869.30" 解析成 84）
  return {
    direction, entry: entry, stopLoss: stopLoss,
    takeProfit: takeProfit,
    tps: tps,
    rr: rr + ":1", riskPct: riskPct + "%"
  };
}

// Override detectPatterns to include advanced ones
// _origDetectPatterns will be set after detectPatterns is defined
function detectPatternsEnhanced(ohlc) {
  const basic = (window._origDetectPatterns && window._origDetectPatterns !== detectPatternsEnhanced) 
    ? window._origDetectPatterns(ohlc) 
    : [];
  const advanced = detectAdvancedPatterns(ohlc);
  return [...basic, ...advanced];
}

// analyzeCoinEnhanced will be defined after analyzeCoin is loaded

console.log("[app] Enhanced analysis module loaded");
