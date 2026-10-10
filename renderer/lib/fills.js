// 真实成交：解析 / 合并 / 还原成一笔笔完整交易 / 与系统信号对照（纯函数，无 DOM / 网络依赖）。经典脚本，定义全局 fl* 函数。
//
// 成交（fill）统一格式：{ id, ts, symbol, market: "spot"|"futures", side: "BUY"|"SELL", price, qty, quote, fee, feeAsset, realizedPnl, positionSide }
// 完整交易（trip）：按交易对把成交按时间做 FIFO 撮合（合约按单向持仓 / 双向持仓的 positionSide 分开），开仓到平仓为一笔：
//   { id, symbol, market, side: "long"|"short", openTs, closeTs, entry（加权均价）, exit（加权均价）, qty, pnlPct, pnlQuote, fees }
// 与信号对照：开仓前 4 小时到开仓后 15 分钟内，同币有同方向信号 = 「按信号做」，反方向 = 「逆信号做」，否则 = 「自己判断」。

var FL_MAX_FILLS = 5000;   // localStorage 容量有限（约 5MB），只保留最近 5000 笔

// ---------- CSV（币安导出的成交历史，中英文表头都支持）----------
function flSplitCsvLine(line) {
  var out = [], cur = "", q = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(function (x) { return x.trim(); });
}
// "0.0010BTC" / "1,234.5 USDT" → 数字
function flNum(v) {
  var m = /-?\d[\d,]*\.?\d*(?:[eE][+-]?\d+)?/.exec(String(v == null ? "" : v));
  return m ? parseFloat(m[0].replace(/,/g, "")) : NaN;
}
function flUnit(v) { var m = /[A-Za-z]{2,10}\s*$/.exec(String(v || "").trim()); return m ? m[0].trim().toUpperCase() : ""; }
// 币安导出时间是 UTC："2026-10-01 12:34:56"
function flParseTime(v) {
  var s = String(v || "").trim();
  var m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  var n = Number(s);
  if (isFinite(n) && n > 1e11) return n;               // 毫秒时间戳
  return NaN;
}
var FL_HEADERS = {
  time: /^(date|time|日期|时间)/i,
  symbol: /^(symbol|pair|market|交易对|币对|合约)/i,
  side: /^(side|type|方向|买卖)/i,
  price: /^(price|成交价|价格|均价)/i,
  qty: /^(executed|quantity|qty|filled|数量|成交量)/i,
  quote: /^(amount|total|成交额|金额)/i,
  fee: /^(fee|手续费)/i,
  pnl: /^(realized ?(profit|pnl)|已实现盈亏|实现盈亏)/i
};
function flParseCsv(text) {
  var lines = String(text || "").replace(/^\ufeff/, "").split(/\r?\n/).filter(function (l) { return l.trim(); });
  if (lines.length < 2) return { fills: [], errors: ["文件里没有数据行"] };
  var head = flSplitCsvLine(lines[0]), col = {};
  head.forEach(function (h, i) {
    Object.keys(FL_HEADERS).forEach(function (k) { if (col[k] === undefined && FL_HEADERS[k].test(h)) col[k] = i; });
  });
  var missing = ["time", "symbol", "side", "price", "qty"].filter(function (k) { return col[k] === undefined; });
  if (missing.length) return { fills: [], errors: ["无法识别表头，缺少：" + missing.join(", ") + "（请导出币安「成交历史 / Trade History」）"] };
  var futures = col.pnl !== undefined, fills = [], errors = [];
  for (var i = 1; i < lines.length; i++) {
    var c = flSplitCsvLine(lines[i]);
    var ts = flParseTime(c[col.time]), price = flNum(c[col.price]), qty = flNum(c[col.qty]);
    var sym = String(c[col.symbol] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    var sideRaw = String(c[col.side] || "").toUpperCase();
    var side = /BUY|买/.test(sideRaw) ? "BUY" : /SELL|卖/.test(sideRaw) ? "SELL" : "";
    if (!isFinite(ts) || !(price > 0) || !(qty > 0) || !sym || !side) { if (errors.length < 5) errors.push("第 " + (i + 1) + " 行格式不对，已跳过"); continue; }
    var quote = col.quote !== undefined ? flNum(c[col.quote]) : NaN;
    fills.push({
      id: "csv:" + sym + ":" + ts + ":" + side + ":" + price + ":" + qty,
      ts: ts, symbol: sym, market: futures ? "futures" : "spot", side: side, price: price, qty: qty,
      quote: isFinite(quote) && quote > 0 ? quote : price * qty,
      fee: col.fee !== undefined ? Math.abs(flNum(c[col.fee])) || 0 : 0,
      feeAsset: col.fee !== undefined ? flUnit(c[col.fee]) : "",
      realizedPnl: futures ? (flNum(c[col.pnl]) || 0) : null, positionSide: "BOTH"
    });
  }
  return { fills: fills, errors: errors };
}

// 合并去重（按 id），按时间升序，保留最近 FL_MAX_FILLS 条
function flMerge(existing, incoming) {
  var map = {};
  (existing || []).concat(incoming || []).forEach(function (f) { if (f && f.id) map[f.id] = f; });
  var out = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return a.ts - b.ts; });
  return out.length > FL_MAX_FILLS ? out.slice(out.length - FL_MAX_FILLS) : out;
}

// ---------- FIFO 撮合成完整交易 ----------
function flToTrips(fills) {
  var books = {}, trips = [];
  (fills || []).slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (f) {
    if (!f || !(f.qty > 0) || !(f.price > 0)) return;
    var key = f.market + "|" + f.symbol + "|" + (f.market === "futures" ? (f.positionSide || "BOTH") : "SPOT");
    var b = books[key] || (books[key] = { side: null, lots: [], openTs: 0, fees: 0, entryQ: 0, entryQty: 0, exitQ: 0, exitQty: 0 });
    var dir = f.side === "BUY" ? "long" : "short";
    // 双向持仓：LONG 仓只做多、SHORT 仓只做空，SELL 在 LONG 仓里就是平多
    if (f.positionSide === "LONG") dir = f.side === "BUY" ? "long" : "close";
    if (f.positionSide === "SHORT") dir = f.side === "SELL" ? "short" : "close";
    var feeQ = f.feeAsset && f.feeAsset !== "USDT" && f.feeAsset !== "USDC" ? 0 : (f.fee || 0);   // 非稳定币计价的手续费无法换算，忽略
    var left = f.qty;
    var opening = f.market === "spot" ? f.side === "BUY" : (b.side === null || dir === b.side) && dir !== "close";
    if (opening) {
      if (f.market === "spot") dir = "long";
      if (b.side === null) { b.side = dir; b.openTs = f.ts; }
      b.lots.push({ qty: left, price: f.price });
      b.entryQ += left * f.price; b.entryQty += left; b.fees += feeQ;
      return;
    }
    // 减仓 / 平仓（现货的 SELL、合约的反向成交）
    if (b.side === null) return;                       // 没有对应持仓的平仓（导入数据不完整）：跳过
    b.fees += feeQ;
    while (left > 1e-12 && b.lots.length) {
      var lot = b.lots[0], take = Math.min(lot.qty, left);
      b.exitQ += take * f.price; b.exitQty += take;
      lot.qty -= take; left -= take;
      if (lot.qty <= 1e-12) b.lots.shift();
    }
    if (!b.lots.length) {
      var entry = b.entryQ / b.entryQty, exit = b.exitQ / b.exitQty, s = b.side === "long" ? 1 : -1;
      trips.push({
        id: key + "|" + b.openTs, symbol: f.symbol, market: f.market, side: b.side, openTs: b.openTs, closeTs: f.ts,
        entry: entry, exit: exit, qty: b.exitQty, pnlPct: (exit / entry - 1) * 100 * s,
        pnlQuote: (exit - entry) * b.exitQty * s - b.fees, fees: b.fees
      });
      // 反手：剩余数量按新方向开仓
      var flip = left > 1e-12 && f.market === "futures" && dir !== "close";
      books[key] = { side: flip ? dir : null, lots: flip ? [{ qty: left, price: f.price }] : [], openTs: flip ? f.ts : 0, fees: 0,
        entryQ: flip ? left * f.price : 0, entryQty: flip ? left : 0, exitQ: 0, exitQty: 0 };
    }
  });
  return trips.sort(function (a, b) { return a.openTs - b.openTs; });
}

// ---------- 与系统信号对照 ----------
var FL_SIGNAL_BEFORE = 4 * 3600e3, FL_SIGNAL_AFTER = 15 * 60e3;
function flTagTrips(trips, records) {
  var bySym = {};
  (records || []).forEach(function (r) { if (r && r.symbol) (bySym[r.symbol] = bySym[r.symbol] || []).push(r); });
  return (trips || []).map(function (t) {
    var cand = (bySym[t.symbol] || []).filter(function (r) { return r.ts >= t.openTs - FL_SIGNAL_BEFORE && r.ts <= t.openTs + FL_SIGNAL_AFTER; });
    var same = cand.filter(function (r) { return r.dir === t.side; });
    var opp = cand.filter(function (r) { return r.dir !== t.side; });
    var pick = function (a) { return a.sort(function (x, y) { return Math.abs(x.ts - t.openTs) - Math.abs(y.ts - t.openTs); })[0]; };
    var src = same.length ? "signal" : opp.length ? "against" : "manual";
    var sig = same.length ? pick(same) : opp.length ? pick(opp) : null;
    return Object.assign({}, t, { src: src, sigTs: sig ? sig.ts : null, sigScore: sig ? sig.score : null, sigGated: sig ? sig.gated !== false : null });
  });
}

// 按来源汇总：笔数、胜率、平均收益率、合计盈亏（计价币）
function flStats(tagged) {
  var groups = { signal: [], against: [], manual: [] };
  (tagged || []).forEach(function (t) { if (groups[t.src]) groups[t.src].push(t); });
  var out = {};
  Object.keys(groups).forEach(function (k) {
    var g = groups[k], n = g.length;
    out[k] = n ? {
      n: n, winRate: g.filter(function (t) { return t.pnlQuote > 0; }).length / n * 100,
      avgPct: g.reduce(function (s, t) { return s + t.pnlPct; }, 0) / n,
      totalQuote: g.reduce(function (s, t) { return s + t.pnlQuote; }, 0)
    } : { n: 0 };
  });
  return out;
}
