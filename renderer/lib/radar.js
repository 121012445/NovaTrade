// 市场雷达（纯函数，无 DOM / 网络依赖）。经典脚本，定义全局 rd* 函数。
//
// ① 异动雷达：利用已有的合约 !miniTicker@arr 推送（每秒一次全市场摘要），每个交易对每 10 秒采一个样，
//    保留最近 20 分钟，算出 5 分钟 / 15 分钟涨跌幅与 5 分钟成交额放大倍数。
//    成交额放大倍数是估算：推送里只有「滚动 24h 成交额」q，用 q(现在) − q(5 分钟前) 近似最近 5 分钟成交额
//    （忽略了 24h 窗口另一端滑出的那部分，所以可能偏小甚至为负；负值按 0 处理），再除以 24h 平均每 5 分钟成交额。
// ② 资金面排行：把全市场资金费率（/fapi/v1/premiumIndex 一次取齐）与成交额靠前币种的持仓量 / 多空比排成榜单。
var RD_SAMPLE_MS = 10000;
var RD_KEEP_MS = 20 * 60e3;

function rdCreate() { return { s: {} }; }

// msgs：miniTicker 数组（s 交易对、c 最新价、q 24h 成交额）
function rdIngest(st, msgs, now) {
  if (!st || !Array.isArray(msgs)) return 0;
  var n = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m || typeof m.s !== "string") continue;
    var c = parseFloat(m.c), q = parseFloat(m.q);
    if (!(c > 0)) continue;
    var arr = st.s[m.s] || (st.s[m.s] = []);
    var last = arr[arr.length - 1];
    if (last && now - last[0] < RD_SAMPLE_MS) { last[1] = c; last[2] = q; continue; }   // 10 秒内只更新最新样本
    arr.push([now, c, q]);
    n++;
    while (arr.length && now - arr[0][0] > RD_KEEP_MS) arr.shift();
  }
  return n;
}

// 取「不晚于 now − ago」的最近一个样本；数据不够久（最早样本都晚于目标时刻 30 秒以上）返回 null
function rdAt(arr, now, ago) {
  var target = now - ago, best = null;
  for (var i = 0; i < arr.length; i++) { if (arr[i][0] <= target) best = arr[i]; else break; }
  if (!best && arr.length && arr[0][0] - target <= 30000) best = arr[0];
  return best;
}

// 返回 [{ symbol, price, chg5, chg15, volX }]，按 |5 分钟涨跌| 降序。数据不够久的字段为 null
function rdCompute(st, now) {
  var out = [];
  Object.keys((st && st.s) || {}).forEach(function (sym) {
    var arr = st.s[sym];
    if (!arr.length) return;
    var cur = arr[arr.length - 1];
    var a5 = rdAt(arr, now, 5 * 60e3), a15 = rdAt(arr, now, 15 * 60e3);
    var chg = function (p) { return p && p[1] > 0 && p !== cur ? (cur[1] / p[1] - 1) * 100 : null; };
    var volX = null;
    if (a5 && a5 !== cur && cur[2] > 0 && isFinite(a5[2])) {
      var turnover = Math.max(0, cur[2] - a5[2]);
      var avg5 = cur[2] / 288;                       // 24h 平均每 5 分钟成交额
      volX = avg5 > 0 ? turnover / avg5 : null;
    }
    out.push({ symbol: sym, price: cur[1], chg5: chg(a5), chg15: chg(a15), volX: volX });
  });
  out.sort(function (a, b) { return Math.abs(b.chg5 || 0) - Math.abs(a.chg5 || 0); });
  return out;
}

// 异动提醒：|5 分钟涨跌| ≥ pct 的币，同一币冷却 coolMin 分钟。会修改 lastMap（symbol → 上次提醒时间）
function rdAlerts(rows, cfg, lastMap, now) {
  var pct = Math.max(0.5, Number(cfg && cfg.pct) || 3), cool = Math.max(1, Number(cfg && cfg.cool) || 30) * 60e3;
  var out = [];
  (rows || []).forEach(function (r) {
    if (r.chg5 === null || Math.abs(r.chg5) < pct) return;
    if (r.symbol in lastMap && now - lastMap[r.symbol] < cool) return;
    lastMap[r.symbol] = now;
    out.push(r);
  });
  return out;
}

// premium：/fapi/v1/premiumIndex 的数组；allow：只保留这些交易对（如 USDT 永续且有成交额的）。
// 返回 { high: 费率最高（多头付费最多）, low: 费率最低（空头付费最多） }，每项 { symbol, rate(%/8h), annual(%) }
function rdFundingRank(premium, allow, n) {
  var k = n || 10;
  var rows = (premium || []).filter(function (p) { return p && typeof p.symbol === "string" && /USDT$/.test(p.symbol) && (!allow || allow[p.symbol]); })
    .map(function (p) { var r = parseFloat(p.lastFundingRate); return { symbol: p.symbol, rate: r * 100, annual: r * 3 * 365 * 100 }; })
    .filter(function (x) { return isFinite(x.rate); });
  var byRate = rows.slice().sort(function (a, b) { return b.rate - a.rate; });
  return { high: byRate.slice(0, k), low: byRate.slice(-k).reverse(), n: rows.length };
}

// lite：{ symbol: { oi: [openInterestHist 行…], ls: [globalLongShortAccountRatio 行…] } }
// 返回 { oiUp, oiDown, lsHigh, lsLow }，每项 { symbol, value }
function rdDerivRank(lite, n) {
  var k = n || 10, oi = [], ls = [];
  Object.keys(lite || {}).forEach(function (sym) {
    var d = lite[sym];
    if (!d) return;
    var o = (Array.isArray(d.oi) ? d.oi : []).map(function (x) { return parseFloat(x && x.sumOpenInterestValue); }).filter(isFinite);
    if (o.length >= 2 && o[0] > 0) oi.push({ symbol: sym, value: (o[o.length - 1] / o[0] - 1) * 100 });
    var l = (Array.isArray(d.ls) ? d.ls : []).map(function (x) { return parseFloat(x && x.longShortRatio); }).filter(isFinite);
    if (l.length) ls.push({ symbol: sym, value: l[l.length - 1] });
  });
  oi.sort(function (a, b) { return b.value - a.value; });
  ls.sort(function (a, b) { return b.value - a.value; });
  return { oiUp: oi.slice(0, k), oiDown: oi.slice(-k).reverse(), lsHigh: ls.slice(0, k), lsLow: ls.slice(-k).reverse() };
}
