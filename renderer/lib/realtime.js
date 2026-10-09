// 实时行情推送：可自动重连的 WebSocket 封装 + miniTicker 合并逻辑（纯函数，便于测试）。
// 经典脚本，定义全局 createReconnectingWS / applyMiniTickers。
//
// 为什么要有：原来每 30 秒轮询一次全量现货 24h 行情 + 一次全量合约 24h 行情，价格预警最慢要等 30 秒才能发现。
// 币安合约 !miniTicker@arr 每秒推送一次全市场摘要，用它实时更新价格 / 24h 涨跌 / 成交额；
// 轮询降级为兜底（推送健康时放慢，断线时恢复）。

// opts: {
//   url, onMessage(data), onStatus(status, info),
//   baseDelay=1000, maxDelay=60000,       指数退避：base * 2^n，封顶 max，另加 0~500ms 抖动
//   staleMs=0,                            >0 时：已连接但超过这么久没收到任何消息 → 主动断开重连（半死连接）
//   WebSocketImpl, setTimeoutImpl, clearTimeoutImpl, setIntervalImpl, clearIntervalImpl, random, now   均可注入，便于测试
// }
function createReconnectingWS(opts) {
  var o = opts || {};
  var WS = o.WebSocketImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
  var st = o.setTimeoutImpl || setTimeout, ct = o.clearTimeoutImpl || clearTimeout;
  var si = o.setIntervalImpl || setInterval, ci = o.clearIntervalImpl || clearInterval;
  var rnd = o.random || Math.random, now = o.now || Date.now;
  var baseDelay = o.baseDelay || 1000, maxDelay = o.maxDelay || 60000;
  var s = { ws: null, status: "idle", retry: 0, timer: null, watchdog: null, manual: true, lastMsgAt: 0, nextRetryAt: 0, err: "" };

  function setStatus(status, info) {
    s.status = status;
    if (o.onStatus) { try { o.onStatus(status, info || {}); } catch (e) {} }
  }
  function clearTimer() { if (s.timer) { ct(s.timer); s.timer = null; } s.nextRetryAt = 0; }
  function stopWatchdog() { if (s.watchdog) { ci(s.watchdog); s.watchdog = null; } }
  function scheduleReconnect() {
    if (s.manual || s.timer) return;
    s.retry += 1;
    var delay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.min(s.retry, 6))) + Math.floor(rnd() * 500);
    s.nextRetryAt = now() + delay;
    s.timer = st(function () { s.timer = null; s.nextRetryAt = 0; connect(); }, delay);
  }
  function connect() {
    if (s.ws || !WS) { if (!WS) { s.err = "当前环境无 WebSocket"; setStatus("error", { err: s.err }); } return; }
    setStatus("connecting");
    var ws;
    try { ws = new WS(o.url); } catch (e) { s.err = (e && e.message) || String(e); setStatus("error", { err: s.err }); scheduleReconnect(); return; }
    s.ws = ws;
    ws.onopen = function () {
      s.retry = 0; s.err = ""; s.lastMsgAt = now();
      setStatus("open");
      stopWatchdog();
      if (o.staleMs > 0) {
        s.watchdog = si(function () {
          if (s.ws === ws && now() - s.lastMsgAt > o.staleMs) { try { ws.close(); } catch (e) {} }
        }, Math.max(1000, Math.floor(o.staleMs / 2)));
      }
    };
    ws.onmessage = function (ev) { s.lastMsgAt = now(); if (o.onMessage) { try { o.onMessage(ev && ev.data); } catch (e) {} } };
    ws.onerror = function () { s.err = s.err || "WebSocket 错误"; setStatus("error", { err: s.err }); };
    ws.onclose = function () {
      if (s.ws === ws) s.ws = null;
      stopWatchdog();
      if (s.manual) { setStatus("idle"); return; }
      if (s.status !== "error") setStatus("closed");
      scheduleReconnect();
    };
  }
  return {
    start: function () { s.manual = false; s.retry = 0; clearTimer(); connect(); },
    stop: function () { s.manual = true; clearTimer(); stopWatchdog(); var w = s.ws; s.ws = null; if (w) { try { w.close(); } catch (e) {} } setStatus("idle"); },
    state: function () { return { status: s.status, retry: s.retry, nextRetryAt: s.nextRetryAt, lastMsgAt: s.lastMsgAt, err: s.err, manual: s.manual }; },
    // 已连接且最近 maxAgeMs 内收到过消息
    healthy: function (maxAgeMs) { return s.status === "open" && now() - s.lastMsgAt <= (maxAgeMs || 10000); }
  };
}

// 把 !miniTicker@arr 的一批消息合并进币种列表。
// 消息字段：s 交易对  c 最新价  o 24h 前开盘价  h/l 24h 最高/最低  q 24h 成交额（计价币）
// 只更新「有合约」的币（价格口径与 loadAllCoins 一致：有合约的币以合约价为准）。
// index 是调用方持有的 { arr, map } 缓存，coins 数组被整体替换（重新拉取）时自动重建。
function applyMiniTickers(coins, prices, msgs, index, nowMs) {
  if (!Array.isArray(coins) || !Array.isArray(msgs) || !index) return 0;
  if (index.arr !== coins || index.len !== coins.length) {
    index.arr = coins; index.len = coins.length; index.map = {};
    for (var i = 0; i < coins.length; i++) index.map[coins[i].symbol] = coins[i];
  }
  var updated = 0;
  for (var k = 0; k < msgs.length; k++) {
    var t = msgs[k];
    if (!t || typeof t.s !== "string") continue;
    var coin = index.map[t.s];
    if (!coin || !coin.hasFutures) continue;
    var c = parseFloat(t.c), op = parseFloat(t.o);
    if (!(c > 0)) continue;
    coin.price = c;
    if (prices) prices[t.s] = c;
    if (op > 0) coin.change = (c - op) / op * 100;
    var q = parseFloat(t.q); if (q > 0) coin.volume = q;
    var h = parseFloat(t.h), l = parseFloat(t.l);
    if (h > 0) coin.high = h;
    if (l > 0) coin.low = l;
    coin.rtAt = nowMs || Date.now();
    updated++;
  }
  return updated;
}
