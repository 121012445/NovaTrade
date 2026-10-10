// 把信号台账 / 模拟跟踪记录转成 K 线图上的标记（纯函数，无 DOM 依赖）。经典脚本，定义全局 sgMarks。
//
// records：前向验证记录（见 recordFwdSignals）；tracks：模拟跟踪记录；candleTimes：图上每根 K 线的开盘时间（秒，升序）。
// 每条记录落到「包含该时刻」的那根 K 线上；同一根 K 线上同方向的多条信号只保留最新一条，避免标记叠在一起看不清。
// 颜色：4h 命中 = 绿，未中 = 红，待结算 / 无数据 = 灰；被门控拦截的信号文字前加「拦」。
var SG_MAX_MARKS = 200;

function sgBarIndex(times, tSec) {
  var lo = 0, hi = times.length - 1, best = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (times[mid] <= tSec) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// opts: { symbol, colors: { up, down, neutral, accent }, focusTs }
function sgMarks(records, tracks, candleTimes, opts) {
  var o = opts || {}, col = o.colors || { up: "#22c55e", down: "#ef4444", neutral: "#9ca3af", accent: "#3b82f6" };
  var times = candleTimes || [];
  if (times.length < 2) return [];
  var step = times[times.length - 1] - times[times.length - 2];
  var lastEnd = times[times.length - 1] + step;
  var sym = o.symbol;
  var byKey = {};
  (records || []).forEach(function (r) {
    if (!r || r.symbol !== sym || (r.dir !== "long" && r.dir !== "short")) return;
    var tSec = Math.floor(r.ts / 1000);
    if (tSec >= lastEnd) return;
    var idx = sgBarIndex(times, tSec);
    if (idx < 0) return;
    var key = "s|" + times[idx] + "|" + r.dir;
    var prev = byKey[key];
    if (prev && prev.ts === o.focusTs) return;                       // 焦点信号不被覆盖
    if (prev && prev.ts > r.ts && r.ts !== o.focusTs) return;        // 否则保留最新的一条
    var long = r.dir === "long";
    var res = r.r4h, mark = res ? (res.hit ? "✓" : "✗") : (r.expired ? "?" : "…");
    byKey[key] = {
      ts: r.ts,
      m: {
        time: times[idx], position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown",
        color: res ? (res.hit ? col.up : col.down) : col.neutral,
        text: (r.gated === false ? "拦" : "") + (long ? "多" : "空") + (r.score === undefined ? "" : Math.round(r.score)) + mark,
        size: r.ts === o.focusTs ? 2 : 1, id: "sig-" + r.ts
      }
    };
  });
  (tracks || []).forEach(function (t) {
    if (!t || t.symbol !== sym || !t.createdAt) return;
    var tSec = Math.floor(t.createdAt / 1000);
    if (tSec >= lastEnd) return;
    var idx = sgBarIndex(times, tSec);
    if (idx < 0) return;
    var st = t.status === "target" ? "达标" : t.status === "invalid" ? "止损" : t.status === "cancelled" ? "停" : "跟踪";
    byKey["t|" + times[idx] + "|" + t.createdAt] = {
      ts: t.createdAt,
      m: { time: times[idx], position: t.direction === "long" ? "belowBar" : "aboveBar", shape: "circle", color: col.accent, text: "模拟" + st, size: 1, id: "trk-" + t.createdAt }
    };
  });
  var out = Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (a, b) { return a.m.time - b.m.time || a.ts - b.ts; });
  if (out.length > SG_MAX_MARKS) out = out.slice(out.length - SG_MAX_MARKS);
  return out.map(function (x) { return x.m; });
}
