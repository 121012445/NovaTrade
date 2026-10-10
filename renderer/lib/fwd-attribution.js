// 信号台账的「门控归因」统计（纯函数，无 DOM 依赖）。经典脚本，定义全局 fa* 函数。
//
// 回答的问题：每一道门控拦下来的信号，事后表现是不是真的比放行的差？
// 做法：按方向分别统计「放行」组与「被某道门控拦截」组的 1h / 4h 方向命中率、1h 与 4h 结果是否一致、4h 方向收益，
// 并给 4h 命中率配 Wilson 95% 置信区间。只有当两组的区间不重叠时才下结论，否则一律视为「差异不显著」。
//
// 注意：被拦截的信号往往同时触发多道门控。「仅被此门控拦截」那一列排除了其他门控的干扰，最能说明这道门控本身的作用。
var FA_GATES = [
  { key: "overheat", dir: "long", label: "过热区（70–74 分不做多）", blocks: function (g) { return g.overheat === true; } },
  { key: "dailyL", dir: "long", label: "日线趋势门控（多）", blocks: function (g) { return g.dailyOK === false; } },
  { key: "stopCapL", dir: "long", label: "止损距离上限（多）", blocks: function (g) { return g.stopCapVeto === true; } },
  { key: "score39", dir: "short", label: "空头评分门槛（需 <39）", blocks: function (g) { return g.score39 === false; } },
  { key: "dailyS", dir: "short", label: "日线趋势门控（空）", blocks: function (g) { return g.dailyOK === false; } },
  { key: "btcVeto", dir: "short", label: "BTC 偏多否决做空", blocks: function (g) { return g.btcVeto === true; } },
  { key: "nearSup", dir: "short", label: "距支撑 <1ATR 不做空", blocks: function (g) { return g.nearSupVeto === true; } },
  { key: "stopCapS", dir: "short", label: "止损距离上限（空）", blocks: function (g) { return g.stopCapVeto === true; } }
];
var FA_MIN_N = 20;

// Wilson 95% 区间（百分比）。n=0 返回 null
function faWilson(hits, n) {
  if (!n) return null;
  var z = 1.96, p = hits / n, d = 1 + z * z / n;
  var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { lo: Math.max(0, c - h) * 100, hi: Math.min(1, c + h) * 100 };
}

function faStats(recs) {
  var n = recs.length;
  if (!n) return { n: 0 };
  var h1 = 0, h1n = 0, h4 = 0, both = 0, mixed = 0, bothMiss = 0, ret = 0;
  recs.forEach(function (r) {
    if (r.r4h.hit) h4++;
    ret += r.r4h.pct * (r.dir === "long" ? 1 : -1);
    if (r.r1h) {
      h1n++;
      if (r.r1h.hit) h1++;
      if (r.r1h.hit && r.r4h.hit) both++;
      else if (!r.r1h.hit && !r.r4h.hit) bothMiss++;
      else mixed++;
    }
  });
  return {
    n: n, h4Rate: h4 / n * 100, h4Ci: faWilson(h4, n), h1Rate: h1n ? h1 / h1n * 100 : null,
    bothHit: h1n ? both / h1n * 100 : null, mixed: h1n ? mixed / h1n * 100 : null, bothMiss: h1n ? bothMiss / h1n * 100 : null,
    avgRet4h: ret / n
  };
}

// 两组比较：返回 "harmful"（拦下的明显更好）/ "useful"（拦下的明显更差）/ "unclear" / "insufficient"
function faVerdict(blocked, passed) {
  if (!blocked.n || !passed.n || blocked.n < FA_MIN_N || passed.n < FA_MIN_N) return "insufficient";
  if (blocked.h4Ci.lo > passed.h4Ci.hi) return "harmful";
  if (blocked.h4Ci.hi < passed.h4Ci.lo) return "useful";
  return "unclear";
}

// records：前向验证记录。只统计 4h 已结算、带 gates 字段的记录（旧版本没有 gates 的记录无法归因）
function faAttribution(records) {
  var usable = (records || []).filter(function (r) {
    return r && r.gates && typeof r.gates === "object" && r.r4h && typeof r.r4h.hit === "boolean" && isFinite(r.r4h.pct) && (r.dir === "long" || r.dir === "short");
  });
  var out = { total: usable.length, dirs: {} };
  ["long", "short"].forEach(function (dir) {
    var mine = usable.filter(function (r) { return r.dir === dir; });
    var gates = FA_GATES.filter(function (g) { return g.dir === dir; });
    var passed = mine.filter(function (r) { return r.gated === true; });
    var blockedAll = mine.filter(function (r) { return r.gated === false; });
    var ps = faStats(passed);
    out.dirs[dir] = {
      passed: ps, blocked: faStats(blockedAll),
      overall: faVerdict(faStats(blockedAll), ps),
      gates: gates.map(function (g) {
        var by = mine.filter(function (r) { return g.blocks(r.gates); });
        var only = by.filter(function (r) { return gates.every(function (o) { return o === g || !o.blocks(r.gates); }); });
        var onlyStats = faStats(only);
        return { key: g.key, label: g.label, any: faStats(by), only: onlyStats, verdict: faVerdict(onlyStats, ps) };
      })
    };
  });
  return out;
}

// ===== 随机基线对照 =====
// 问题：信号挑的方向，是否比「同一批币、同一时间点、随机给方向」更准？
// 做法（置换检验）：保持多 / 空笔数不变，把方向在这些记录之间随机打乱 iters 次，得到随机情况下 4h 命中笔数的分布，
// p 值 = 随机命中数 ≥ 实际命中数的比例。p < 0.05 才说明方向选择确实带来了优势。
// 同时给出「全做多」「全做空」的命中率（反映这段时间的大盘漂移），以及相对 BTC 的方向超额收益（需要 BTC 同期价格）。
function faRng(seed) {   // 可复现的伪随机数（mulberry32）
  var a = (seed >>> 0) || 1;
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// records：已结算 4h 的记录；opts: { onlyPassed, iters, rng }
function faBaseline(records, opts) {
  var o = opts || {};
  var rs = (records || []).filter(function (r) {
    return r && r.r4h && typeof r.r4h.hit === "boolean" && isFinite(r.r4h.pct) && (r.dir === "long" || r.dir === "short") && (!o.onlyPassed || r.gated !== false);
  });
  var n = rs.length;
  if (!n) return { n: 0 };
  // up[i]：这条记录 4h 后价格是否上涨（由方向与命中反推，与原始结算口径一致）
  var up = rs.map(function (r) { return r.dir === "long" ? r.r4h.hit : !r.r4h.hit; });
  var longs = rs.filter(function (r) { return r.dir === "long"; }).length;
  var actual = rs.filter(function (r) { return r.r4h.hit; }).length;
  var upN = up.filter(Boolean).length;
  var iters = o.iters || 2000, rng = o.rng || Math.random;
  var idx = rs.map(function (_, i) { return i; }), sims = [], ge = 0;
  for (var k = 0; k < iters; k++) {
    for (var i = n - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    var hits = 0;
    for (var m = 0; m < n; m++) hits += (m < longs) === up[idx[m]] ? 1 : 0;   // 前 longs 个位置分配为多，其余为空
    sims.push(hits);
    if (hits >= actual) ge++;
  }
  sims.sort(function (a, b) { return a - b; });
  var q = function (p) { return sims[Math.min(sims.length - 1, Math.max(0, Math.round((sims.length - 1) * p)))] / n * 100; };
  // 相对 BTC 的方向超额收益：多单 = 币涨幅 − BTC 涨幅；空单取相反数
  var ex = rs.filter(function (r) { return isFinite(r.r4h.btcPct); }).map(function (r) {
    return (r.dir === "long" ? 1 : -1) * (r.r4h.pct - r.r4h.btcPct);
  });
  return {
    n: n, longN: longs, shortN: n - longs,
    hitRate: actual / n * 100,
    randMean: sims.reduce(function (s, x) { return s + x; }, 0) / sims.length / n * 100,
    randLo: q(0.025), randHi: q(0.975),
    pValue: (ge + 1) / (iters + 1),
    allLongRate: upN / n * 100, allShortRate: (n - upN) / n * 100,
    excessN: ex.length,
    excessAvg: ex.length ? ex.reduce(function (s, x) { return s + x; }, 0) / ex.length : null,
    excessHit: ex.length ? ex.filter(function (x) { return x > 0; }).length / ex.length * 100 : null
  };
}

// ===== 按行情状态分组 =====
// 很多规则只在某一种行情里有效（例如趋势跟随在震荡市里反复止损）。每条信号记录当时的三个维度：
//   state：该币自身的市场状态（ADX>25 趋势明确 / ADX<20 震荡市 / 其余弱趋势）
//   btc：BTC 环境（ADX>25 且评分≥65 上升 / ADX>25 且评分<45 下降 / 其余无明确趋势）
//   vol：波动（布林带宽占中轨 <3% 低 / 3–8% 中 / >8% 高）
var FA_REGIME_DIMS = [
  { key: "state", label: "该币状态", values: { trend: "趋势明确", range: "震荡市", weak: "弱趋势" } },
  { key: "btc", label: "BTC 环境", values: { up: "BTC 上升", down: "BTC 下降", flat: "BTC 无明确趋势" } },
  { key: "vol", label: "波动", values: { low: "低波动", mid: "中等波动", high: "高波动" } }
];

// a：多周期合并分析结果；btc：window.__btcRegime（{ score, adx }）
function faRegimeOf(a, btc) {
  var ms = a && a.marketState;
  var state = ms === "趋势明确" ? "trend" : ms === "震荡市" ? "range" : "weak";
  var b = "flat";
  if (btc && isFinite(btc.adx) && btc.adx > 25) b = btc.score >= SIGNAL_LONG_MIN ? "up" : btc.score < SIGNAL_SHORT_MAX ? "down" : "flat";
  var bw = parseFloat(a && a.indicators && a.indicators.bbWidth);
  var vol = !isFinite(bw) ? "mid" : bw < 3 ? "low" : bw > 8 ? "high" : "mid";
  return { state: state, btc: b, vol: vol };
}

// 返回 [{ key, label, rows: [{ value, label, stats, weak }] }]。weak = 样本 ≥30 且 4h 命中率区间上限 < 50%
function faRegimeStats(records, opts) {
  var o = opts || {};
  var rs = (records || []).filter(function (r) {
    return r && r.regime && r.r4h && typeof r.r4h.hit === "boolean" && isFinite(r.r4h.pct) && (!o.onlyPassed || r.gated !== false);
  });
  return FA_REGIME_DIMS.map(function (d) {
    return {
      key: d.key, label: d.label,
      rows: Object.keys(d.values).map(function (v) {
        var st = faStats(rs.filter(function (r) { return r.regime[d.key] === v; }));
        return { value: v, label: d.values[v], stats: st, weak: !!(st.n >= 30 && st.h4Ci && st.h4Ci.hi < 50) };
      })
    };
  });
}

// 当前行情状态里，有没有哪个维度在历史上显著偏弱。返回偏弱的标签列表（空数组 = 没有）
function faWeakRegimes(stats, regime) {
  var out = [];
  (stats || []).forEach(function (d) {
    var row = d.rows.find(function (x) { return regime && x.value === regime[d.key]; });
    if (row && row.weak) out.push(row.label + "（4h 命中 " + row.stats.h4Rate.toFixed(0) + "%，n=" + row.stats.n + "）");
  });
  return out;
}
