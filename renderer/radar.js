// 「市场雷达」视图：异动雷达 + 全市场资金面排行（计算逻辑在 lib/radar.js）。
(function () {
  "use strict";
  var CFG_KEY = "novatrade_radar_cfg";
  var DERIV_TTL = 10 * 60e3, PREM_TTL = 2 * 60e3;
  window.__radar = window.__radar || rdCreate();
  var lastAlert = {};
  var deriv = { at: 0, prem: null, lite: {}, loading: false, err: "" };

  function $(id) { return document.getElementById(id); }
  function cfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "{}") || {}; } catch (e) { c = {}; }
    return { on: c.on === true, pct: isFinite(c.pct) && c.pct >= 0.5 ? c.pct : 3, cool: isFinite(c.cool) && c.cool >= 1 ? c.cool : 30 };
  }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} }
  function pc(v, d) { return v === null || !isFinite(v) ? '<span class="fa-dim">--</span>' : '<span class="' + (v >= 0 ? "up" : "down") + '">' + (v >= 0 ? "+" : "") + v.toFixed(d === undefined ? 2 : d) + '%</span>'; }
  function base(sym) { return escapeHtml(splitSymbol(sym).base); }
  function active() { var v = $("view-radar"); return !!(v && v.classList.contains("active")); }

  // 由 app.js 的实时推送回调调用（每秒一次）
  window.radarIngest = function (msgs) {
    rdIngest(window.__radar, msgs, Date.now());
  };

  // 每 5 秒：算一次异动榜；开启提醒时推送；视图可见时重绘
  function tick() {
    var rows = rdCompute(window.__radar, Date.now());
    var c = cfg();
    if (c.on) {
      rdAlerts(rows, c, lastAlert, Date.now()).slice(0, 3).forEach(function (r) {
        var t = base(r.symbol) + (r.chg5 >= 0 ? " 5 分钟急涨 " : " 5 分钟急跌 ") + (r.chg5 >= 0 ? "+" : "") + r.chg5.toFixed(2) + "%";
        try { linkedToast(t); } catch (e) {}
        try { pushNotify(t, "现价 " + formatPrice(r.price) + (r.volX !== null ? " · 成交额约为平时的 " + r.volX.toFixed(1) + " 倍" : "")); } catch (e) {}
      });
    }
    if (active()) paintMovers(rows);
  }

  function paintMovers(rows) {
    var box = $("radarMovers");
    if (!box) return;
    var oldest = Infinity;
    Object.keys(window.__radar.s).forEach(function (k) { var a = window.__radar.s[k]; if (a.length) oldest = Math.min(oldest, a[0][0]); });
    var mins = isFinite(oldest) ? (Date.now() - oldest) / 60e3 : 0;
    if (!rows.length) { box.innerHTML = '<div class="empty-note">等待实时行情推送……（需要合约 WebSocket 已连接）</div>'; return; }
    var warm = mins < 5 ? '<div class="size-note">已采集 ' + mins.toFixed(1) + ' 分钟数据，5 分钟涨跌需要至少 5 分钟、15 分钟涨跌需要 15 分钟。</div>' : "";
    var top = rows.filter(function (r) { return r.chg5 !== null; }).slice(0, 30);
    if (!top.length) top = rows.slice(0, 30);
    box.innerHTML = warm + '<div class="nt-wrap"><table class="nt"><thead><tr><th>币种</th><th>现价</th><th>5 分钟</th><th>15 分钟</th><th title="最近 5 分钟成交额 ÷ 24h 平均每 5 分钟成交额（估算）">成交额放大</th></tr></thead><tbody>' +
      top.map(function (r) {
        return '<tr class="clickable" onclick="openLinkedCoin(\'' + escapeJsAttr(r.symbol) + '\')"><td>' + base(r.symbol) + '</td><td>' + formatPrice(r.price) + '</td><td>' + pc(r.chg5) + '</td><td>' + pc(r.chg15) + '</td><td>' +
          (r.volX === null ? '<span class="fa-dim">--</span>' : (r.volX >= 3 ? "<b>" : "") + r.volX.toFixed(1) + "x" + (r.volX >= 3 ? "</b>" : "")) + '</td></tr>';
      }).join("") + '</tbody></table></div>';
  }

  function rankList(title, rows, fmt, note) {
    return '<div class="split-box"><h4>' + title + '</h4>' + (rows.length ? rows.map(function (r) {
      return '<div class="sr-row clickable" onclick="openLinkedCoin(\'' + escapeJsAttr(r.symbol) + '\')"><span>' + base(r.symbol) + '</span><span>' + fmt(r) + '</span></div>';
    }).join("") : '<div class="fa-dim">暂无数据</div>') + (note ? '<div class="fa-dim" style="margin-top:6px">' + note + '</div>' : "") + '</div>';
  }

  function paintDeriv() {
    var box = $("radarDeriv");
    if (!box) return;
    if (deriv.err && !deriv.prem) { box.innerHTML = '<div class="size-warn">资金面数据获取失败：' + escapeHtml(deriv.err) + '</div>'; return; }
    if (!deriv.prem) { box.innerHTML = '<div class="ai-rr-placeholder">正在获取全市场资金费率……</div>'; return; }
    var allow = {};
    (allCoins || []).forEach(function (c) { if (c.hasFutures) allow[c.symbol] = 1; });
    var f = rdFundingRank(deriv.prem, Object.keys(allow).length ? allow : null, 10);
    var d = rdDerivRank(deriv.lite, 10);
    var fr = function (r) { return pc(r.rate, 4) + ' <span class="fa-dim">年化 ' + r.annual.toFixed(0) + '%</span>'; };
    var nLite = Object.keys(deriv.lite).length;
    box.innerHTML =
      '<div class="size-note">资金费率覆盖 ' + f.n + ' 个 USDT 永续合约；持仓量与多空比只取成交额前 ' + nLite + ' 个（每个币 2 次请求，10 分钟缓存）。更新于 ' + new Date(deriv.at).toLocaleTimeString("zh-CN") + (deriv.loading ? "（更新中…）" : "") + '。</div>' +
      '<div class="split-grid">' +
      rankList("资金费率最高（多头付费）", f.high, fr, "费率越高，多头越拥挤，追多成本越高") +
      rankList("资金费率最低（空头付费）", f.low, fr, "大幅为负时存在挤空风险") +
      rankList("持仓量 24h 增长最多", d.oiUp, function (r) { return pc(r.value, 1); }, "配合价格方向看：价涨仓增 = 新资金做多") +
      rankList("持仓量 24h 减少最多", d.oiDown, function (r) { return pc(r.value, 1); }, "减仓离场") +
      rankList("账户多空比最高", d.lsHigh, function (r) { return r.value.toFixed(2); }, "散户普遍偏多") +
      rankList("账户多空比最低", d.lsLow, function (r) { return r.value.toFixed(2); }, "散户普遍偏空") +
      '</div>';
  }

  async function loadDeriv(force) {
    var api = window.binanceAPI;
    if (!api || !api.premiumAll || deriv.loading) return;
    var now = Date.now();
    if (!force && deriv.prem && now - deriv.at < PREM_TTL) { paintDeriv(); return; }
    deriv.loading = true;
    paintDeriv();
    try {
      var p = await api.premiumAll();
      if (Array.isArray(p)) { deriv.prem = p; deriv.err = ""; } else deriv.err = (p && p.__error) || "返回格式不对";
      deriv.at = Date.now();
      paintDeriv();
      if (api.derivLite && (force || now - (deriv.liteAt || 0) > DERIV_TTL)) {
        var syms = (allCoins || []).filter(function (c) { return c.hasFutures; }).slice(0, 30).map(function (c) { return c.symbol; });
        var lite = {}, i = 0;
        await Promise.all([0, 1, 2, 3].map(async function () {
          while (i < syms.length) {
            var s = syms[i++];
            try { var r = await api.derivLite(s); if (r && !r.__error) lite[s] = { oi: r.oi, ls: r.ls }; } catch (e) {}
          }
        }));
        deriv.lite = lite; deriv.liteAt = Date.now();
      }
    } catch (e) { deriv.err = (e && e.message) || String(e); }
    deriv.loading = false;
    paintDeriv();
  }

  function render() {
    var root = $("radarWrap");
    if (!root) return;
    var c = cfg();
    root.innerHTML =
      '<div class="section-header"><h2 class="section-title">异动雷达</h2></div>' +
      '<div class="set-row" style="margin-bottom:var(--sp-3)">' +
      '<label class="nf-check"><input type="checkbox" id="radarOn"' + (c.on ? " checked" : "") + ' onchange="radarSaveCfg()"><span>异动提醒（系统通知 + 远程推送）</span></label>' +
      '<label>5 分钟涨跌 ≥ %<input type="number" id="radarPct" min="0.5" step="0.5" value="' + c.pct + '" onchange="radarSaveCfg()" style="min-width:80px"></label>' +
      '<label>同一币冷却（分钟）<input type="number" id="radarCool" min="1" step="1" value="' + c.cool + '" onchange="radarSaveCfg()" style="min-width:80px"></label></div>' +
      '<div id="radarMovers"></div>' +
      '<div class="section-header" style="margin-top:var(--sp-5)"><h2 class="section-title">资金面排行</h2><button class="btn-ghost" onclick="radarRefreshDeriv()">刷新</button></div>' +
      '<div id="radarDeriv"></div>';
    paintMovers(rdCompute(window.__radar, Date.now()));
    loadDeriv(false);
  }

  window.radarSaveCfg = function () {
    var c = cfg();
    var on = $("radarOn"), pct = $("radarPct"), cool = $("radarCool");
    if (on) c.on = !!on.checked;
    if (pct && isFinite(parseFloat(pct.value))) c.pct = Math.max(0.5, Math.min(50, parseFloat(pct.value)));
    if (cool && isFinite(parseFloat(cool.value))) c.cool = Math.max(1, Math.min(1440, Math.round(parseFloat(cool.value))));
    saveCfg(c);
  };
  window.radarRefreshDeriv = function () { loadDeriv(true); };
  window.renderRadar = render;
  setInterval(tick, 5000);
})();
