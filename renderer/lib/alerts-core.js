// 价格 / 涨跌幅 / 评分预警的判定逻辑（纯函数，无 DOM 依赖）。经典脚本，定义全局 alert* 函数。
//
// 与旧实现的区别：
// 1. 「穿越」语义：创建时条件已经满足的预警先处于「未武装」状态，价格离开满足区、再重新进入时才触发，
//    不会刚设完就立刻弹一次（旧实现会立刻触发）。旧数据没有 armed 字段，按已武装处理，行为不变。
// 2. 重复预警：可选 repeat + 冷却分钟数。触发后需要先离开满足区（重新武装）且过了冷却期才会再次触发，
//    持续满足期间不会连环弹。
// 3. 评分类预警：scoreAbove / scoreBelow，读取最近一次多周期分析的评分（取不到就不判，不会误报）。
var ALERT_KINDS = ["above", "below", "chgUp", "chgDown", "scoreAbove", "scoreBelow"];
var ALERT_KIND_LABEL = {
  above: "价格 ≥", below: "价格 ≤", chgUp: "24h 涨幅 ≥", chgDown: "24h 跌幅 ≥",
  scoreAbove: "评分 ≥", scoreBelow: "评分 ≤"
};

function alertValueOf(a, ctx) {
  if (!ctx) return null;
  var v = (a.kind === "above" || a.kind === "below") ? ctx.price
    : (a.kind === "chgUp" || a.kind === "chgDown") ? ctx.change
    : (a.kind === "scoreAbove" || a.kind === "scoreBelow") ? ctx.score : null;
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

// 条件当前是否满足：true / false；取不到数据返回 null（此时既不触发也不改变武装状态）
function alertSatisfied(a, ctx) {
  var v = alertValueOf(a, ctx);
  if (v === null) return null;
  switch (a.kind) {
    case "above": case "chgUp": case "scoreAbove": return v >= a.value;
    case "below": case "scoreBelow": return v <= a.value;
    case "chgDown": return v <= -Math.abs(a.value);
    default: return null;
  }
}

function alertDetailText(a, ctx, fmtPrice) {
  var f = fmtPrice || function (x) { return String(x); };
  var v = alertValueOf(a, ctx);
  switch (a.kind) {
    case "above": return "现价 " + f(v) + " ≥ " + f(a.value);
    case "below": return "现价 " + f(v) + " ≤ " + f(a.value);
    case "chgUp": return "24h " + (v >= 0 ? "+" : "") + v.toFixed(2) + "% ≥ " + a.value + "%";
    case "chgDown": return "24h " + v.toFixed(2) + "% ≤ -" + Math.abs(a.value) + "%";
    case "scoreAbove": return "评分 " + Math.round(v) + " ≥ " + a.value;
    case "scoreBelow": return "评分 " + Math.round(v) + " ≤ " + a.value;
    default: return "";
  }
}

// 创建时的初始武装状态：条件已经满足 → 未武装（先要离开满足区）
function alertInitialArmed(a, ctx) {
  return alertSatisfied(a, ctx) !== true;
}

// 对一条预警做一次判定。返回 { fire, detail, next }：next 是需要合并回这条预警的字段补丁。
function alertStep(a, ctx, nowMs, fmtPrice) {
  var sat = alertSatisfied(a, ctx);
  if (sat === null) return { fire: false, detail: "", next: {} };
  var armed = a.armed !== false;      // 旧数据没有该字段：视为已武装
  if (!armed) return { fire: false, detail: "", next: sat ? {} : { armed: true } };
  if (!sat) return { fire: false, detail: "", next: {} };
  var detail = alertDetailText(a, ctx, fmtPrice);
  if (a.repeat) {
    var cool = Math.max(1, Number(a.cooldownMin) || 60) * 60000;
    if (a.lastFiredAt && nowMs - a.lastFiredAt < cool) return { fire: false, detail: "", next: {} };
    return {
      fire: true, detail: detail,
      next: { lastFiredAt: nowMs, fireCount: (a.fireCount || 0) + 1, armed: false, hitDetail: detail, triggeredAt: 0 }
    };
  }
  return { fire: true, detail: detail, next: { triggeredAt: nowMs, enabled: false, hitDetail: detail, fireCount: 1 } };
}
