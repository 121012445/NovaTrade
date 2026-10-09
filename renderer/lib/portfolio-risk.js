// 持仓组合的风险概览（纯函数，无 DOM / 网络依赖）。经典脚本，定义全局 pr* 函数。
//
// 回答的问题不是「赚了多少」，而是「这几笔仓位是不是其实在押同一件事」：
// 币圈的币种普遍和 BTC 高度同向，名义上持有 5 个币，风险上可能只相当于 1.5 笔独立仓位。
//   - 集中度：最大单笔占比、HHI；
//   - 方向：净敞口 / 总敞口；
//   - 加权杠杆；
//   - 相关性：按方向调整后的两两相关（做多 A 同时做空 B，A、B 高度正相关 = 对冲，风险相互抵消），
//     并折算成「有效独立仓位数」N_eff = 1 / (wᵀ R' w)，w 为名义占比，R'ij = si·sj·ρij。
// rows: [{ symbol, side:"long"|"short", notional, lev }]；corrOf(a, b) 返回两个币的收益率相关系数（取不到返回 null）
var PR_DEFAULT_CORR = 0.5;   // 取不到相关系数时的保守假设（加密币种之间普遍为正相关）

function prRisk(rows, corrOf) {
  var pos = (rows || []).filter(function (r) { return r && r.notional > 0; });
  var n = pos.length;
  if (!n) return null;
  var gross = 0, longN = 0, shortN = 0, levW = 0;
  pos.forEach(function (r) {
    gross += r.notional;
    if (r.side === "long") longN += r.notional; else shortN += r.notional;
    levW += r.notional * (r.lev > 0 ? r.lev : 1);
  });
  var w = pos.map(function (r) { return r.notional / gross; });
  var sgn = pos.map(function (r) { return r.side === "long" ? 1 : -1; });

  var top = 0, hhi = 0;
  w.forEach(function (x, i) { hhi += x * x; if (x > w[top]) top = i; });

  var missing = 0, quad = 0, offNum = 0, offDen = 0;
  for (var i = 0; i < n; i++) {
    for (var j = 0; j < n; j++) {
      var rho;
      if (i === j) rho = 1;
      else if (pos[i].symbol === pos[j].symbol) rho = 1;
      else {
        var c = corrOf ? corrOf(pos[i].symbol, pos[j].symbol) : null;
        if (typeof c === "number" && isFinite(c)) rho = c;
        else { rho = PR_DEFAULT_CORR; if (i < j) missing++; }
      }
      var adj = sgn[i] * sgn[j] * rho;
      quad += w[i] * w[j] * adj;
      if (i !== j) { offNum += w[i] * w[j] * adj; offDen += w[i] * w[j]; }
    }
  }
  var neff = quad > 1e-9 ? Math.max(1, Math.min(n, 1 / quad)) : n;
  var avgCorr = offDen > 0 ? offNum / offDen : null;
  var net = longN - shortN;
  var out = {
    n: n, gross: gross, net: net, netPct: gross > 0 ? net / gross * 100 : 0,
    longPct: gross > 0 ? longN / gross * 100 : 0,
    top: { symbol: pos[top].symbol, pct: w[top] * 100 }, hhi: hhi,
    avgLev: levW / gross, neff: neff, avgCorr: avgCorr, corrMissing: missing, warnings: []
  };
  if (n >= 2 && out.top.pct > 40) out.warnings.push("单一仓位占比 " + out.top.pct.toFixed(0) + "%（" + pos[top].symbol.replace(/USDT$/, "") + "），集中度偏高");
  if (n >= 3 && Math.abs(out.netPct) > 80) out.warnings.push("方向高度单边：净敞口占总敞口 " + Math.abs(out.netPct).toFixed(0) + "%（" + (net >= 0 ? "偏多" : "偏空") + "）");
  if (n >= 2 && avgCorr !== null && avgCorr > 0.6) out.warnings.push("各仓位按方向调整后的平均相关系数 " + avgCorr.toFixed(2) + "，实质上在押同一个方向");
  if (n >= 3 && neff < n / 2) out.warnings.push("名义上 " + n + " 笔仓位，风险上约等于 " + neff.toFixed(1) + " 笔独立仓位");
  if (out.avgLev > 5) out.warnings.push("加权杠杆 " + out.avgLev.toFixed(1) + "x，较高的杠杆会放大回撤并更易触发强平");
  if (missing > 0) out.warnings.push(missing + " 对仓位缺少相关性数据，已按 ρ=" + PR_DEFAULT_CORR + " 保守估计");
  return out;
}
