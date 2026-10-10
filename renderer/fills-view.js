// 「持仓与复盘 → 真实成交」：从只读 API 或币安导出的 CSV 导入成交，还原成完整交易，并和系统信号对照。
// 计算逻辑在 lib/fills.js；API Key 的保存与签名请求都在主进程（main/binance-account.js），这里拿不到 Secret。
(function () {
  "use strict";
  var KEY = "novatrade_fills_v1";
  var SPOT_SYMS_KEY = "novatrade_fills_spot_syms";
  var SRC_LABEL = { signal: "按信号做", against: "逆信号做", manual: "自己判断" };

  function $(id) { return document.getElementById(id); }
  function load() { try { var a = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function save(a) {
    try { localStorage.setItem(KEY, JSON.stringify(a)); return true; }
    catch (e) { linkedToast("本地存储空间不足，已只保留最近的成交"); try { localStorage.setItem(KEY, JSON.stringify(a.slice(-2000))); } catch (e2) {} return false; }
  }
  function defaultSpotSyms() {
    var saved = "";
    try { saved = localStorage.getItem(SPOT_SYMS_KEY) || ""; } catch (e) {}
    if (saved) return saved;
    var set = {};
    try { (loadWatchlist() || []).forEach(function (s) { set[s] = 1; }); } catch (e) {}
    try { (loadPortfolio() || []).forEach(function (p) { set[p.symbol] = 1; }); } catch (e) {}
    ["BTCUSDT", "ETHUSDT"].forEach(function (s) { set[s] = 1; });
    return Object.keys(set).join(",");
  }
  function msg(text, ok) { var el = $("fillsMsg"); if (el) { el.className = "set-result " + (ok ? "ok" : "err"); el.textContent = text; } }
  function pc(v) { return isFinite(v) ? '<span class="' + (v >= 0 ? "up" : "down") + '">' + (v >= 0 ? "+" : "") + v.toFixed(2) + "%</span>" : "--"; }
  function money(v) { return isFinite(v) ? '<span class="' + (v >= 0 ? "up" : "down") + '">' + (v >= 0 ? "+" : "") + v.toFixed(2) + "</span>" : "--"; }

  function tagged() { return flTagTrips(flToTrips(load()), typeof fwdRecords !== "undefined" ? fwdRecords : []); }

  function html() {
    var fills = load(), trips = tagged(), st = flStats(trips);
    var acctBtn = window.electronAPI && window.electronAPI.accountImport
      ? '<label>现货交易对（逗号分隔）<input type="text" id="fillsSpotSyms" style="min-width:280px" value="' + escapeHtml(defaultSpotSyms()) + '"></label><button class="btn-primary" onclick="fillsImportApi()">从只读 API 导入</button>'
      : "";
    var head = '<div class="mine-notice">导入你在币安的<b>真实成交</b>，还原成一笔笔完整交易，再看「按信号做」「逆信号做」「自己判断」各自的结果。' +
      'API 导入只接受<b>仅读取权限</b>的 Key（在「设置 → 交易所只读 API」配置）；也可以在币安网页导出「成交历史」CSV 后导入，不需要任何 Key。</div>' +
      '<div class="set-row">' + acctBtn +
      '<label class="btn-ghost" style="cursor:pointer">导入 CSV<input type="file" accept=".csv,text/csv" style="display:none" onchange="fillsCsvPicked(this)"></label>' +
      '<button class="btn-ghost" onclick="fillsToJournal()"' + (trips.length ? "" : " disabled") + '>写入交易日志</button>' +
      '<button class="btn-danger-ghost" onclick="fillsClear()"' + (fills.length ? "" : " disabled") + '>清空成交</button></div>' +
      '<div id="fillsMsg" class="set-result"></div>';
    if (!fills.length) return head + '<div class="empty-note">还没有导入成交。</div>';
    var statRow = function (k) {
      var s = st[k];
      return '<tr><td>' + SRC_LABEL[k] + '</td><td>' + (s.n || 0) + '</td><td>' + (s.n ? s.winRate.toFixed(0) + "%" : "--") + '</td><td>' + (s.n ? pc(s.avgPct) : "--") + '</td><td>' + (s.n ? money(s.totalQuote) : "--") + '</td></tr>';
    };
    var rows = trips.slice().reverse().slice(0, 200).map(function (t) {
      var sig = t.src === "manual" ? '<span class="fa-dim">无</span>'
        : SRC_LABEL[t.src] + ' <span class="fa-dim">(' + (t.sigScore === null ? "" : Math.round(t.sigScore) + "分") + (t.sigGated === false ? " · 当时被拦截" : "") + ')</span>';
      return '<tr class="clickable" onclick="openLinkedCoin(\'' + escapeJsAttr(t.symbol) + '\')"><td>' + new Date(t.openTs).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) + '</td>' +
        '<td>' + escapeHtml(splitSymbol(t.symbol).base) + '<span class="fa-dim"> ' + (t.market === "futures" ? "合约" : "现货") + '</span></td>' +
        '<td class="' + (t.side === "long" ? "up" : "down") + '">' + (t.side === "long" ? "多" : "空") + '</td>' +
        '<td>' + formatPrice(t.entry) + '</td><td>' + formatPrice(t.exit) + '</td><td>' + pc(t.pnlPct) + '</td><td>' + money(t.pnlQuote) + '</td><td>' + sig + '</td></tr>';
    }).join("");
    return head +
      '<div class="size-note">共 ' + fills.length + ' 笔成交，还原出 ' + trips.length + ' 笔完整交易（未平仓的不计）。盈亏已扣以 USDT/USDC 计价的手续费；用 BNB 等抵扣的手续费无法换算，未扣除。' +
      '「按信号做」= 开仓前 4 小时到开仓后 15 分钟内，同一币有同方向的系统信号。</div>' +
      '<div class="mini-title">按来源对比</div><div class="nt-wrap"><table class="nt"><thead><tr><th>来源</th><th>笔数</th><th>胜率</th><th>平均收益</th><th>合计盈亏（计价币）</th></tr></thead><tbody>' +
      statRow("signal") + statRow("against") + statRow("manual") + '</tbody></table></div>' +
      '<div class="mini-title">完整交易（最近 200 笔）</div><div class="nt-wrap"><table class="nt"><thead><tr><th>开仓</th><th>币种</th><th>方向</th><th>入场</th><th>出场</th><th>收益</th><th>盈亏</th><th>对应信号</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function render() { var box = $("fillsWrap"); if (box) box.innerHTML = html(); }
  function addFills(list, warnings) {
    var before = load().length;
    var merged = flMerge(load(), list);
    save(merged);
    render();
    var added = merged.length - before;
    msg("新增 " + added + " 笔成交（重复的已跳过）" + (warnings && warnings.length ? "。提示：" + warnings.join("；") : ""), added > 0 || !(warnings && warnings.length));
  }

  window.fillsImportApi = async function () {
    var api = window.electronAPI;
    if (!api || !api.accountImport) return;
    var cfg = api.accountGetConfig ? await api.accountGetConfig() : null;
    if (!cfg || !cfg.configured) { msg("还没有配置只读 API Key：请到「设置 → 交易所只读 API」添加", false); return; }
    var symsEl = $("fillsSpotSyms");
    var syms = String(symsEl ? symsEl.value : "").toUpperCase().split(/[\s,，]+/).filter(function (s) { return /^[A-Z0-9]{2,30}$/.test(s); }).slice(0, 40);
    try { localStorage.setItem(SPOT_SYMS_KEY, syms.join(",")); } catch (e) {}
    msg("正在导入……", true);
    var r = await api.accountImport({ spotSymbols: syms });
    if (!r || !r.ok) { msg((r && (r.error || r.__error)) || "导入失败", false); return; }
    addFills(r.fills, r.warnings);
  };
  window.fillsCsvPicked = function (input) {
    var f = input && input.files && input.files[0];
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { msg("文件太大（>20MB）", false); return; }
    var rd = new FileReader();
    rd.onload = function () {
      var r = flParseCsv(String(rd.result || ""));
      if (!r.fills.length) { msg(r.errors[0] || "文件里没有可识别的成交", false); return; }
      addFills(r.fills, r.errors);
    };
    rd.onerror = function () { msg("读取文件失败", false); };
    rd.readAsText(f);
    input.value = "";
  };
  window.fillsClear = function () {
    if (!window.confirm("清空所有已导入的真实成交？（交易日志里已写入的记录不受影响）")) return;
    save([]); render();
  };
  // 把还原出来的完整交易写进「交易日志」（已写入过的按 id 跳过），来源自动标为按信号 / 逆信号 / 自己判断
  window.fillsToJournal = function () {
    var list = loadJournal(), have = {};
    list.forEach(function (j) { have[j.id] = 1; });
    var add = tagged().filter(function (t) { return !have["f:" + t.id]; }).map(function (t) {
      var notional = t.entry * t.qty;
      return {
        id: "f:" + t.id, symbol: t.symbol, side: t.side, entry: t.entry, exit: t.exit, qty: t.qty,
        fee: notional > 0 ? Math.max(0, t.fees / notional * 100) : 0, src: t.src, closedAt: t.closeTs,
        note: "导入（" + (t.market === "futures" ? "合约" : "现货") + "）"
      };
    });
    if (!add.length) { msg("没有新的完整交易需要写入", true); return; }
    saveJournal(add.concat(list));
    msg("已写入 " + add.length + " 笔到交易日志" + (list.length + add.length > 500 ? "（交易日志最多保留 500 笔）" : ""), true);
  };
  window.renderFills = render;
})();
