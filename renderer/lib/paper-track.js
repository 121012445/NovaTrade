// 模拟跟踪的计算逻辑（纯函数，无 DOM 依赖）。经典脚本，定义全局 pt* 函数。
//
// 相比旧版的改动：
// 1. 入场价取「点击那一刻的最新价」，而不是卡片生成时写死的价格（启动时显示的可能是 10 分钟前的缓存卡片）；
//    若此刻价格已经越过止损或目标，信号已失效，拒绝加入。
// 2. 记录持仓期间的最大浮盈 / 最大浮亏（MFE / MAE）：能看出是「方向对了但止损太近」还是「一开始就错」。
// 3. 扣除成本（默认 0.12%：往返手续费 0.08% + 进出各 0.02% 滑点），显示净收益。
// 4. 记录同期 BTC 涨跌，算「相对 BTC 的方向超额」：分清是选币 / 方向判断的问题，还是被大盘一起带下去。
var PT_COST_PCT = 0.12;

function ptDirSign(d) { return d === "long" ? 1 : -1; }

// o: { symbol, direction, stopLoss, target, livePrice, btcPrice, blocked, now, costPct }
function ptOpen(o) {
  var px = Number(o.livePrice), sl = Number(o.stopLoss), tp = Number(o.target);
  if (!(px > 0)) return { ok: false, reason: "拿不到最新价，请稍后再试" };
  if (!(sl > 0) || !(tp > 0)) return { ok: false, reason: "这条信号没有可用的止损 / 目标价" };
  var long = o.direction === "long";
  if (long ? px <= sl : px >= sl) return { ok: false, reason: "现价已越过止损价，信号已失效" };
  if (long ? px >= tp : px <= tp) return { ok: false, reason: "现价已越过目标价，错过了入场点" };
  return {
    ok: true,
    track: {
      symbol: o.symbol, direction: long ? "long" : "short", entry: px, stopLoss: sl, target: tp,
      current: px, pnl: 0, net: -(o.costPct === undefined ? PT_COST_PCT : o.costPct),
      cost: o.costPct === undefined ? PT_COST_PCT : o.costPct,
      mfe: 0, mae: 0, btcEntry: Number(o.btcPrice) > 0 ? Number(o.btcPrice) : null, btcPct: null, excess: null,
      blocked: !!o.blocked, status: "active", createdAt: o.now || Date.now(), v: 2
    }
  };
}

// 用最新价更新一条进行中的跟踪。返回 "target" / "invalid" / null（状态有变化时）
function ptUpdate(t, price, btcPrice, now) {
  if (!t || t.status !== "active" || !(price > 0)) return null;
  var s = ptDirSign(t.direction);
  t.current = price;
  t.pnl = (price / t.entry - 1) * 100 * s;
  t.net = t.pnl - (t.cost === undefined ? 0 : t.cost);
  if (!isFinite(t.mfe) || t.pnl > t.mfe) t.mfe = t.pnl;
  if (!isFinite(t.mae) || t.pnl < t.mae) t.mae = t.pnl;
  if (t.btcEntry > 0 && btcPrice > 0) {
    t.btcPct = (btcPrice / t.btcEntry - 1) * 100;
    t.excess = s * ((price / t.entry - 1) * 100 - t.btcPct);
  }
  var hitTarget = s > 0 ? price >= t.target : price <= t.target;
  var hitStop = s > 0 ? price <= t.stopLoss : price >= t.stopLoss;
  if (hitTarget || hitStop) {
    t.status = hitTarget ? "target" : "invalid";
    t.exit = price;
    t.closedAt = now || Date.now();
    return t.status;
  }
  return null;
}

// 已结束（达标 / 止损）的跟踪汇总；可选只看「当时可交易」的信号
function ptSummary(tracks, opts) {
  var o = opts || {};
  var done = (tracks || []).filter(function (t) {
    return t && (t.status === "target" || t.status === "invalid") && isFinite(t.pnl) && (!o.excludeBlocked || !t.blocked);
  });
  var n = done.length;
  if (!n) return { n: 0 };
  var net = done.map(function (t) { return isFinite(t.net) ? t.net : t.pnl; });
  var ex = done.filter(function (t) { return isFinite(t.excess); }).map(function (t) { return t.excess; });
  var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
  return {
    n: n, targets: done.filter(function (t) { return t.status === "target"; }).length,
    stops: done.filter(function (t) { return t.status === "invalid"; }).length,
    winRate: net.filter(function (x) { return x > 0; }).length / n * 100,
    avgNet: sum(net) / n, totalNet: sum(net),
    excessN: ex.length, avgExcess: ex.length ? sum(ex) / ex.length : null,
    blockedN: done.filter(function (t) { return t.blocked; }).length
  };
}
