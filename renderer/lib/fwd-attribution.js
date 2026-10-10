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
