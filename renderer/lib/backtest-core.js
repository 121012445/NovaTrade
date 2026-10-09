// NovaTrade 回测核心（纯函数，无 DOM / 网络依赖）。经典脚本，定义全局 bt* 函数。
// 应用（app.js）与 Node 测试 / 回测 CLI（bt/engine.js）共用这一份，保证口径一致。
//
// 流程：btCollectSignals（逐点喂已收盘数据给评分引擎，得到信号）→ btRunSignals（按成本模型逐根模拟持仓）。
// 两步拆开是为了做参数扫描：信号只依赖评分引擎，与止盈倍数 / 最长持有无关，只需算一次。
var BT_WINDOW = 200;          // 每次打分只喂最近 N 根（实盘分析用的就是 150 根；也避免长历史下 O(n²) 变慢）
var BT_MIN_WARMUP = 110;      // analyzeCoin 需要 SMA99 + EMA_Ribbon(50) + 形态识别(30)，留足预热

function btAtr(ohlc, idx, period) {
  period = period || 14;
  if (!ohlc || idx < period) return 0;
  var sum = 0;
  for (var i = idx - period + 1; i <= idx; i++) {
    var h = ohlc[i][2], l = ohlc[i][3], pc = ohlc[i - 1][4];
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

function emaArr(arr, n) {
  var k = 2 / (n + 1), out = [], e = null;
  for (var i = 0; i < arr.length; i++) { e = (e === null) ? arr[i] : arr[i] * k + e * (1 - k); out.push(e); }
  return out;
}

// 取 t 时刻「已经收盘」的最后一根日线 —— 正在走的那根日线不能用，否则就是未来函数
function btDailyGateAt(series, t) {
  var PASS = { down: true, up: true, below20: true, above20: true, idx: -1 };
  if (!series || !series.times || series.times.length < 51) return PASS;
  var lo = 0, hi = series.times.length - 1, best = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (series.times[mid] + 86400000 <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 1) return PASS;
  var c = series.closes[best], e20 = series.e20[best], e50 = series.e50[best];
  return { down: e20 < e50, up: e20 > e50, below20: c < e20, above20: c > e20, idx: best };
}

function btFullStats(trades) {
  var n = trades.length;
  if (!n) return null;
  var sum = 0, wins = 0, gw = 0, gl = 0, eq = 0, peak = 0, mdd = 0, bars = 0, rets = [];
  var byReason = {};
  for (var i = 0; i < n; i++) {
    var t = trades[i];
    sum += t.netR; rets.push(t.netR); bars += t.bars;
    if (t.netR > 0) { wins++; gw += t.netR; } else if (t.netR < 0) { gl += -t.netR; }
    eq += t.netR;
    if (eq > peak) peak = eq;
    if (peak - eq > mdd) mdd = peak - eq;
    byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  }
  var mean = sum / n;
  var varc = 0;
  for (var j = 0; j < n; j++) varc += (rets[j] - mean) * (rets[j] - mean);
  var sd = n > 1 ? Math.sqrt(varc / (n - 1)) : 0;
  return {
    n: n, winRate: wins / n * 100, sumR: sum, avgR: mean, sd: sd,
    sharpe: sd > 0 ? mean / sd * Math.sqrt(n) : 0,   // 以"整段"为口径的近似夏普
    mdd: mdd, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    avgBars: bars / n, byReason: byReason,
    maxWin: Math.max.apply(null, rets), maxLoss: Math.min.apply(null, rets),
    // 每笔期望的 95% 置信区间（正态近似）：区间包含 0 就说明「期望为正」这个结论统计上站不住
    avgLo: n > 1 ? mean - 1.96 * sd / Math.sqrt(n) : null,
    avgHi: n > 1 ? mean + 1.96 * sd / Math.sqrt(n) : null
  };
}

function btEquityPath(trades) {
  var eq = 0, peak = 0, out = [0], dd = [0];
  for (var i = 0; i < trades.length; i++) {
    eq += trades[i].netR;
    if (eq > peak) peak = eq;
    out.push(eq); dd.push(eq - peak);
  }
  return { eq: out, dd: dd };
}

function btSplitStats(trades, ratio) {
  var cut = Math.max(1, Math.floor(trades.length * (ratio === undefined ? 0.7 : ratio)));
  return {
    is: btFullStats(trades.slice(0, cut)),
    os: btFullStats(trades.slice(cut)),
    cut: cut
  };
}

function btMonteCarlo(trades, iters) {
  iters = iters || 400;
  var rets = trades.map(function (t) { return t.netR; });
  if (rets.length < 5) return null;
  var finals = [], mdds = [];
  for (var k = 0; k < iters; k++) {
    // Fisher-Yates 洗牌：检验"结果是否依赖成交的先后顺序"
    var a = rets.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    var eq = 0, peak = 0, mdd = 0;
    for (var m = 0; m < a.length; m++) {
      eq += a[m];
      if (eq > peak) peak = eq;
      if (peak - eq > mdd) mdd = peak - eq;
    }
    finals.push(eq); mdds.push(mdd);
  }
  finals.sort(function (x, y) { return x - y; });
  mdds.sort(function (x, y) { return x - y; });
  function q(arr, p) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))]; }
  return {
    iters: iters, finals: finals, mdds: mdds,
    finalP5: q(finals, 0.05), finalP50: q(finals, 0.5), finalP95: q(finals, 0.95),
    mddP50: q(mdds, 0.5), mddP95: q(mdds, 0.95),
    lossProb: finals.filter(function (v) { return v < 0; }).length / finals.length * 100
  };
}

// ---------- 周期与成本模型 ----------
var BT_BAR_MS = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3, "2h": 7200e3, "4h": 14400e3, "6h": 21600e3, "12h": 43200e3, "1d": 86400e3 };
function btBarMs(tf) { return BT_BAR_MS[tf] || 3600e3; }
// 成本参数（全部以 % 计）：
//   fee      往返手续费（开仓 + 平仓合计）
//   slip     单边滑点（进出场各吃一次）
//   funding  每 8 小时资金费率；保守起见多空都按「支付」计，不给空头记收入
function btDefaultCost() { return { fee: 0.08, slip: 0.02, funding: 0.01 }; }

function btParseKlines(kl) {
  var n = kl.length, closes = new Array(n), ohlc = new Array(n);
  for (var j = 0; j < n; j++) {
    var k = kl[j];
    closes[j] = parseFloat(k[4]);
    ohlc[j] = [Number(k[0]), parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])];
  }
  return { closes: closes, ohlc: ohlc, n: n };
}

// 时间片让出：避免长循环冻住界面（浏览器里用 setTimeout 0；Node 里同样适用）
function btYield() { return new Promise(function (r) { setTimeout(r, 0); }); }

// 第一步：逐点收集信号。hooks: { isAborted(): bool, onProgress(count) }
// 只使用「采样点及之前」的数据；传入的 kl 应当是已收盘 K 线。
async function btCollectSignals(kl, cfg, maxHoldRef, hooks) {
  var h = hooks || {};
  var P = btParseKlines(kl), n = P.n;
  var start = Math.max(BT_MIN_WARMUP, n - cfg.bars - maxHoldRef);
  var signals = [], vetoed = 0, lastYield = Date.now(), steps = 0;
  for (var i = start; i < n - 1; i += cfg.step) {
    if (h.isAborted && h.isAborted()) throw new Error("__aborted__");
    var from = Math.max(0, i + 1 - BT_WINDOW);
    var winC = P.closes.slice(from, i + 1), winO = P.ohlc.slice(from, i + 1);
    var w = analyzeCoin(winC, cfg.sym || "", winO);
    // calcRiskReward 内部已含「过热区不做多」「贴近支撑不做空」「止损距离上限」三处否决（返回 null）
    var rr = calcRiskReward(w, winO);
    if (!rr || !isFinite(rr.entry) || !isFinite(rr.stopLoss) || !(rr.entry > 0)) { vetoed++; }
    else {
      var risk = Math.abs(rr.entry - rr.stopLoss);
      if (!(risk > 0)) { vetoed++; }
      else {
        signals.push({
          i: i, ts: P.ohlc[i][0], score: w.score, dir: rr.stopLoss < rr.entry ? "long" : "short",
          entry: rr.entry, stop: rr.stopLoss, risk: risk, atr: btAtr(P.ohlc, i, 14)
        });
      }
    }
    steps++;
    // 按时间（约 30ms）而不是按笔数让出，慢机器上界面也不会卡住
    if (Date.now() - lastYield > 30) {
      if (h.onProgress) h.onProgress(signals.length);
      await btYield();
      lastYield = Date.now();
    }
  }
  return { signals: signals, vetoed: vetoed, steps: steps, bars: n, start: start };
}

// 第二步：按成本模型逐根模拟持仓。
//   full: { tpR, maxHold, useDaily, noOverlap }
//   daily: btDailySeries 的结果（可为 null）
// 同一根 K 线内止损与止盈都触及，按先止损（保守）；开盘即跳过止损价按开盘价成交（跳空）。
function btRunSignals(signals, kl, daily, tf, full, cost) {
  var P = btParseKlines(kl), n = P.n, ohlc = P.ohlc;
  var c = Object.assign(btDefaultCost(), cost || {});
  var barMs = btBarMs(tf);
  var noOverlap = full.noOverlap !== false;
  var trades = [], gateBlocked = 0, overlapSkipped = 0, truncated = 0, lastExit = -1;
  for (var s = 0; s < signals.length; s++) {
    var sig = signals[s], i = sig.i;
    if (i + full.maxHold >= n) { truncated++; continue; }       // 持仓窗口超出数据末尾：不计入
    if (noOverlap && i <= lastExit) { overlapSkipped++; continue; }   // 上一笔还没平仓：同一币种不重复开仓
    var dir = sig.dir, entry = sig.entry, stop = sig.stop, risk = sig.risk;
    var tp = dir === "long" ? entry + risk * full.tpR : entry - risk * full.tpR;
    var gateTag = "未启用";
    if (full.useDaily) {
      var g = btDailyGateAt(daily, ohlc[i][0]);
      var ok = dir === "short" ? (g.down || g.below20) : (g.up || g.above20);
      if (!ok) { gateBlocked++; continue; }
      gateTag = dir === "short" ? (g.down ? "日线EMA死叉" : "破日线EMA20") : (g.up ? "日线EMA金叉" : "站上日线EMA20");
    }
    var exitPrice = null, exitIdx = -1, reason = "";
    for (var m = i + 1; m <= i + full.maxHold && m < n; m++) {
      var op = ohlc[m][1], hi = ohlc[m][2], lo = ohlc[m][3];
      if (dir === "long") {
        if (op <= stop) { exitPrice = op; exitIdx = m; reason = "止损(跳空)"; break; }
        if (lo <= stop) { exitPrice = stop; exitIdx = m; reason = "止损"; break; }
        if (hi >= tp) { exitPrice = tp; exitIdx = m; reason = "止盈"; break; }
      } else {
        if (op >= stop) { exitPrice = op; exitIdx = m; reason = "止损(跳空)"; break; }
        if (hi >= stop) { exitPrice = stop; exitIdx = m; reason = "止损"; break; }
        if (lo <= tp) { exitPrice = tp; exitIdx = m; reason = "止盈"; break; }
      }
    }
    if (exitPrice === null) {
      exitIdx = Math.min(i + full.maxHold, n - 1);
      exitPrice = P.closes[exitIdx];
      reason = "到期";
    }
    var riskPct = risk / entry;                                   // 风险占入场价的比例
    var grossR = (dir === "long" ? (exitPrice - entry) : (entry - exitPrice)) / risk;
    var feeR = (c.fee / 100) / riskPct;                           // 往返手续费折算成 R
    var slipR = (c.slip / 100 * 2) / riskPct;                     // 进出场各一次滑点
    var heldMs = (exitIdx - i) * barMs;
    var fundR = (c.funding / 100) * (heldMs / (8 * 3600e3)) / riskPct;
    lastExit = exitIdx;
    trades.push({
      ts: ohlc[i][0], dir: dir, score: sig.score, entry: entry, stop: stop, tp: tp,
      exit: exitPrice, bars: exitIdx - i, reason: reason, risk: risk, atr: sig.atr,
      grossR: grossR, feeR: feeR, slipR: slipR, fundR: fundR,
      netR: grossR - feeR - slipR - fundR, gate: gateTag
    });
  }
  return { trades: trades, vetoed: 0, gateBlocked: gateBlocked, overlapSkipped: overlapSkipped, truncated: truncated };
}

// 参数扫描：同一批信号，遍历 止盈倍数 × 最长持有。返回每个组合的整体 / 样本内 / 样本外统计。
// 所有组合共用同一个起点，保证可比；信号来自 maxHoldRef = max(maxHolds) 的采集。
function btSweep(signals, kl, daily, tf, base, cost, tpList, holdList) {
  var rows = [];
  for (var a = 0; a < tpList.length; a++) {
    for (var b = 0; b < holdList.length; b++) {
      var full = Object.assign({}, base, { tpR: tpList[a], maxHold: holdList[b] });
      var r = btRunSignals(signals, kl, daily, tf, full, cost);
      var split = btSplitStats(r.trades, 0.7);
      rows.push({ tpR: tpList[a], maxHold: holdList[b], n: r.trades.length, all: btFullStats(r.trades), is: split.is, os: split.os });
    }
  }
  return rows;
}

// 滚动窗口稳定性：把交易按时间平均分成 k 段，逐段统计。每段期望都为正才叫稳定。
function btWindows(trades, k) {
  var n = trades.length, out = [];
  if (n < k * 3) return out;
  var size = Math.floor(n / k);
  for (var w = 0; w < k; w++) {
    var seg = trades.slice(w * size, w === k - 1 ? n : (w + 1) * size);
    out.push({ idx: w + 1, from: seg[0].ts, to: seg[seg.length - 1].ts, stats: btFullStats(seg) });
  }
  return out;
}

// 多币种合并：按信号时间排序，得到组合层面的交易序列（每笔仍按 1R 等风险计）
function btMergeTrades(lists) {
  var all = [];
  lists.forEach(function (l) { l.trades.forEach(function (t) { all.push(Object.assign({ sym: l.sym }, t)); }); });
  all.sort(function (a, b) { return a.ts - b.ts; });
  return all;
}

// 按块重采样（block bootstrap）：保留相邻交易的聚集（连续亏损），比整体洗牌更接近真实回撤风险
function btBlockBootstrap(trades, iters, block) {
  var rets = trades.map(function (t) { return t.netR; }), n = rets.length;
  if (n < 8) return null;
  iters = iters || 400;
  block = Math.max(2, block || Math.round(Math.sqrt(n)));
  var finals = [], mdds = [];
  for (var k = 0; k < iters; k++) {
    var eq = 0, peak = 0, mdd = 0, cnt = 0;
    while (cnt < n) {
      var st = Math.floor(Math.random() * n);
      for (var j = 0; j < block && cnt < n; j++, cnt++) {
        eq += rets[(st + j) % n];
        if (eq > peak) peak = eq;
        if (peak - eq > mdd) mdd = peak - eq;
      }
    }
    finals.push(eq); mdds.push(mdd);
  }
  finals.sort(function (x, y) { return x - y; });
  mdds.sort(function (x, y) { return x - y; });
  function q(arr, p) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * p)))]; }
  return {
    iters: iters, block: block,
    finalP5: q(finals, 0.05), finalP50: q(finals, 0.5), finalP95: q(finals, 0.95),
    mddP50: q(mdds, 0.5), mddP95: q(mdds, 0.95),
    lossProb: finals.filter(function (v) { return v < 0; }).length / finals.length * 100
  };
}
