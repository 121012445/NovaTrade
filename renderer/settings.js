// 设置页：远程推送、新信号提醒、扫描范围、AI 解读、数据备份、诊断与更新。
// 所有凭据都只经由主进程加密保存；这里只会看到打码后的值（••••尾号）。
// 页面里的按钮写成 onclick="fn('x')" 的形式，由 lib/inline-handlers.js 的受限解析器分发。
(function () {
  "use strict";

  var TYPE_LABEL = { telegram: "Telegram", feishu: "飞书", wecom: "企业微信", bark: "Bark", webhook: "通用 Webhook" };
  var TYPE_FIELDS = {
    telegram: [["botToken", "Bot Token", "password"], ["chatId", "Chat ID", "text"]],
    feishu: [["url", "Webhook 地址", "password"], ["secret", "签名密钥（可选）", "password"]],
    wecom: [["url", "Webhook 地址", "password"]],
    bark: [["url", "Bark 地址（含设备 Key）", "password"]],
    webhook: [["url", "Webhook 地址（https）", "password"]]
  };
  var S = { channels: [], canStore: true, llm: null };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return typeof escapeHtml === "function" ? escapeHtml(v) : String(v); }
  function toast(m) { try { linkedToast(m); } catch (e) { /* 无 toast 时忽略 */ } }
  function api() { return window.electronAPI || {}; }
  function msg(id, text, ok) {
    var el = $(id);
    if (el) { el.className = "set-result " + (ok ? "ok" : "err"); el.textContent = text; }
  }
  function setBusy(id, text) { var el = $(id); if (el) { el.className = "set-result"; el.textContent = text; } }

  // ---------- 渲染 ----------
  function channelHtml(c) {
    var fields = (TYPE_FIELDS[c.type] || []).map(function (f) {
      return '<label>' + esc(f[1]) + '<input type="' + f[2] + '" data-f="' + f[0] + '" autocomplete="off" value="' + esc(c[f[0]] || "") + '"></label>';
    }).join("");
    return '<div class="set-ch" data-ch="' + esc(c.id) + '" data-type="' + esc(c.type) + '">' +
      '<div class="set-ch-title">' + esc(TYPE_LABEL[c.type] || c.type) + '</div>' +
      '<div class="set-row">' + fields +
      '<label class="nf-check"><input type="checkbox" data-f="enabled"' + (c.enabled !== false ? " checked" : "") + '><span>启用</span></label>' +
      '<label class="nf-check"><input type="checkbox" data-f="useProxy"' + (c.useProxy ? " checked" : "") + '><span>走代理</span></label>' +
      '<button class="btn-ghost" onclick="pushTestChannel(\'' + esc(c.id) + '\')">测试</button>' +
      '<button class="btn-danger-ghost" onclick="pushDeleteChannel(\'' + esc(c.id) + '\')">删除</button>' +
      '</div></div>';
  }

  function pushCardHtml() {
    var opts = Object.keys(TYPE_LABEL).map(function (t) { return '<option value="' + t + '">' + esc(TYPE_LABEL[t]) + '</option>'; }).join("");
    return '<div class="set-card"><h3>远程推送</h3>' +
      '<div class="set-note">预警触发、新信号出现时，除系统通知外还可以推送到手机或群机器人。只发送文字，不接收任何指令。' +
      '令牌 / Webhook 地址属于凭据：用系统安全存储加密保存，界面上只显示尾号。Telegram 在国内通常需要勾选「走代理」。</div>' +
      (S.canStore ? "" : '<div class="set-result err">当前系统的安全存储不可用，无法安全保存推送凭据，已禁用保存。</div>') +
      '<div id="pushChannels">' + (S.channels.length ? S.channels.map(channelHtml).join("") : '<div class="set-note">还没有配置推送渠道。</div>') + '</div>' +
      '<div class="set-row"><label>添加渠道<select id="pushNewType">' + opts + '</select></label>' +
      '<button class="btn-ghost" onclick="pushAddChannel()">添加</button>' +
      '<button class="btn-primary" onclick="pushSaveAll()"' + (S.canStore ? "" : " disabled") + '>保存推送设置</button></div>' +
      '<div id="pushMsg" class="set-result"></div></div>';
  }

  function generalCardHtml() {
    var sizes = (window.SCAN_CHOICES || [10, 20, 40, 80]).map(function (n) {
      return '<option value="' + n + '"' + (n === window.scanSize() ? " selected" : "") + '>成交额前 ' + n + ' 个币</option>';
    }).join("");
    return '<div class="set-card"><h3>信号与扫描</h3>' +
      '<div class="set-row"><label>AI 推荐扫描范围<select onchange="settingsSetScan(this.value)">' + sizes + '</select></label>' +
      '<label class="nf-check"><input type="checkbox" onchange="settingsToggleSignal(this.checked)"' + (window.signalNotifyEnabled() ? " checked" : "") + '><span>新信号出现时提醒（系统通知 + 已配置的远程推送）</span></label></div>' +
      '<div class="set-note">扫描范围越大，每轮请求越多（每个币 4 个周期各一次，3 分钟一轮）。新信号提醒默认关闭；同一币同一方向 4 小时内只提醒一次，带「仅观察」标记表示前向验证尚未达标。</div></div>';
  }

  var GATE_INFO = [
    ["overheat", "过热区：70–74 分不做多", "依据作者早期约 7–14 条样本的 4h 命中率定下"],
    ["daily", "日线趋势门控", "做多需日线 EMA20>EMA50 或收盘在 EMA20 上方；做空反之"],
    ["stopCap", "止损距离上限", "止损距离超过价格的 " + (window.MAX_STOP_PCT || 15) + "% 不给信号"],
    ["score39", "空头评分门槛", "开启：评分 <39 才做空；关闭：放宽到 <45"],
    ["btcVeto", "BTC 偏多时否决做空", "BTC 处于明确上升趋势时不做空山寨"],
    ["nearSup", "距支撑 <1ATR 不做空", "避免在支撑位附近追空"]
  ];
  function gateCardHtml() {
    var g = window.gateCfg ? window.gateCfg() : {};
    return '<div class="set-card"><h3>门控开关</h3>' +
      '<div class="set-note">门控会拦下一部分信号（台账里显示「已拦截」）。关闭某道门控后，它不再拦截信号，但台账仍会记录「这道门控本来会不会拦」，' +
      '所以「门控归因」表可以继续比较两组的表现。建议只在归因表显示「拦下的反而更好」且样本足够时再关闭。改动从下一轮推荐开始生效。</div>' +
      GATE_INFO.map(function (x) {
        return '<div class="set-row"><label class="nf-check"><input type="checkbox" data-gate="' + x[0] + '"' + (g[x[0]] !== false ? " checked" : "") +
          ' onchange="settingsSaveGates()"><span><b>' + esc(x[1]) + '</b> <span class="set-note">' + esc(x[2]) + '</span></span></label></div>';
      }).join("") +
      '<div class="set-row"><button class="btn-ghost" onclick="settingsResetGates()">全部恢复默认（开启）</button></div>' +
      '<div id="gateMsg" class="set-result"></div></div>';
  }
  window.settingsSaveGates = function () {
    var cfg = {};
    document.querySelectorAll("[data-gate]").forEach(function (el) { cfg[el.getAttribute("data-gate")] = el.checked; });
    var out = window.saveGateCfg(cfg);
    var off = Object.keys(out).filter(function (k) { return !out[k]; });
    msg("gateMsg", off.length ? "已关闭 " + off.length + " 道门控，下一轮推荐生效" : "全部门控已开启", true);
  };
  window.settingsResetGates = function () { window.saveGateCfg({}); renderSettings(); toast("门控已全部恢复为开启"); };

  function llmCardHtml() {
    var c = S.llm || {};
    return '<div class="set-card"><h3>AI 解读</h3>' +
      '<div class="set-note">在「技术分析 → AI 结论」里点「AI 解读」，应用会把已计算好的评分、信号、风险回报与衍生品摘要发给你配置的大模型，生成一段中文解读。' +
      '兼容 OpenAI 风格的 /chat/completions 接口（含本地 Ollama 的 /v1）。只发送分析摘要，不含密钥、账户或持仓；模型不下单、不预测价格。</div>' +
      '<div class="set-row">' +
      '<label>接口地址（到 /v1 为止）<input type="text" id="llm_baseUrl" placeholder="https://api.openai.com/v1" value="' + esc(c.baseUrl || "") + '"></label>' +
      '<label>模型<input type="text" id="llm_model" placeholder="gpt-4o-mini" value="' + esc(c.model || "") + '"></label>' +
      '<label>API Key<input type="password" id="llm_key" autocomplete="off" value="' + esc(c.apiKey || "") + '"></label>' +
      '<label class="nf-check"><input type="checkbox" id="llm_proxy"' + (c.useProxy ? " checked" : "") + '><span>走代理</span></label>' +
      '<button class="btn-primary" onclick="llmSave()"' + (c.canStore === false ? " disabled" : "") + '>保存</button>' +
      '<button class="btn-ghost" onclick="llmClear()">清除</button></div>' +
      '<div id="llmMsg" class="set-result"></div></div>';
  }

  function dataCardHtml() {
    return '<div class="set-card"><h3>数据与备份</h3>' +
      '<div class="set-note">备份包含：自选、价格预警、持仓、交易日志、各类设置，以及信号前向验证记录。<b>不包含</b>推送令牌与 API Key（它们由系统安全存储保护，不会写进备份文件）。导入会覆盖同名的本地数据，并重新加载页面。</div>' +
      '<div class="set-row"><button class="btn-ghost" onclick="backupExport()">导出备份</button><button class="btn-ghost" onclick="backupImport()">导入备份</button></div>' +
      '<div id="backupMsg" class="set-result"></div></div>';
  }

  function aboutCardHtml() {
    return '<div class="set-card"><h3>诊断与更新</h3>' +
      '<div id="aboutInfo" class="set-note">加载中…</div>' +
      '<div class="set-row"><button class="btn-ghost" onclick="checkUpdateNow()">检查更新</button>' +
      '<button class="btn-ghost" onclick="exportDiag()">导出诊断包</button>' +
      '<button class="btn-ghost" onclick="openReleasePage()">打开发布页</button></div>' +
      '<div id="aboutMsg" class="set-result"></div>' +
      '<div class="set-note">诊断包包含版本、代理状态与最近的错误日志，令牌 / 密钥 / 带参数的 URL 已脱敏，可以直接发给开发者排查问题。</div></div>';
  }

  function disclaimerHtml() {
    return '<div class="set-card"><h3>免责声明</h3><div class="set-note">NovaTrade 是行情分析辅助工具：所有评分、信号、回测、AI 解读均基于历史与实时公开数据的统计推断，' +
      '<b>不构成任何投资建议</b>，也不保证未来表现。应用只读取公开行情，不连接交易账户、不具备任何下单能力。加密资产价格波动剧烈，请自行评估并承担风险。</div></div>';
  }

  async function renderSettings() {
    var root = $("settingsWrap");
    if (!root) return;
    var a = api();
    try {
      if (a.pushGetConfig) { var pc = await a.pushGetConfig(); if (pc && pc.channels) { S.channels = pc.channels; S.canStore = pc.canStore !== false; } }
      if (a.llmGetConfig) S.llm = await a.llmGetConfig();
    } catch (e) { console.warn("[settings] load failed:", e && e.message); }
    root.innerHTML = pushCardHtml() + generalCardHtml() + gateCardHtml() + llmCardHtml() + dataCardHtml() + aboutCardHtml() + disclaimerHtml();
    try {
      var info = a.appInfo ? await a.appInfo() : null;
      var ds = window.__dataSource;
      var el = $("aboutInfo");
      if (el) el.textContent = info
        ? "版本 " + info.version + (info.packaged ? "" : "（开发模式）") + " · " + info.platform + " · 渲染：" + (info.softwareRendering ? "软件渲染" : "硬件加速") +
          " · 数据源：" + (ds && ds.name === "okx" ? "OKX 备用" : "币安") + " · 行情推送：" + (window.rtHealthy && window.rtHealthy() ? "已连接" : "未连接（轮询）")
        : "当前环境无应用信息";
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 远程推送 ----------
  // 从 DOM 读出当前（含未保存的）渠道配置
  function pushCollect() {
    return Array.prototype.map.call(document.querySelectorAll("#pushChannels .set-ch"), function (el) {
      var c = { id: el.getAttribute("data-ch"), type: el.getAttribute("data-type") };
      el.querySelectorAll("[data-f]").forEach(function (inp) {
        var f = inp.getAttribute("data-f");
        c[f] = inp.type === "checkbox" ? inp.checked : inp.value;
      });
      return c;
    });
  }
  function pushRedraw() {
    var box = $("pushChannels");
    if (box) box.innerHTML = S.channels.length ? S.channels.map(channelHtml).join("") : '<div class="set-note">还没有配置推送渠道。</div>';
  }
  window.pushAddChannel = function () {
    var sel = $("pushNewType");
    if (!sel || !TYPE_FIELDS[sel.value]) return;
    S.channels = pushCollect();
    S.channels.push({ id: "n" + Math.random().toString(36).slice(2, 8), type: sel.value, enabled: true, useProxy: sel.value === "telegram" });
    pushRedraw();
  };
  window.pushSaveAll = async function () {
    var a = api();
    if (!a.pushSetConfig) return;
    setBusy("pushMsg", "保存中…");
    try {
      var r = await a.pushSetConfig({ channels: pushCollect() });
      if (r && r.ok) { S.channels = r.config.channels; pushRedraw(); msg("pushMsg", "已保存（" + S.channels.length + " 个渠道）", true); }
      else msg("pushMsg", (r && (r.error || r.__error)) || "保存失败", false);
    } catch (e) { msg("pushMsg", "保存失败：" + (e && e.message), false); }
  };
  window.pushDeleteChannel = async function (id) {
    S.channels = pushCollect().filter(function (c) { return c.id !== id; });
    pushRedraw();
    var a = api();
    if (a.pushSetConfig) {
      var r = await a.pushSetConfig({ channels: S.channels });
      msg("pushMsg", r && r.ok ? "已删除" : ((r && r.error) || "删除后保存失败，请点「保存推送设置」"), !!(r && r.ok));
    }
  };
  window.pushTestChannel = async function (id) {
    var a = api();
    if (!a.pushSetConfig || !a.pushTest) return;
    setBusy("pushMsg", "先保存，再发送测试消息…");
    try {
      var sv = await a.pushSetConfig({ channels: pushCollect() });
      if (!sv || !sv.ok) { msg("pushMsg", (sv && sv.error) || "保存失败，无法测试", false); return; }
      S.channels = sv.config.channels; pushRedraw();
      var r = await a.pushTest(id);
      var one = r && r.results && r.results[0];
      if (one && one.ok) msg("pushMsg", "测试消息已发送，请到对应渠道查收", true);
      else msg("pushMsg", "发送失败：" + ((one && one.error) || (r && r.skipped) || "未知原因"), false);
    } catch (e) { msg("pushMsg", "发送失败：" + (e && e.message), false); }
  };

  // ---------- 通用 ----------
  window.settingsSetScan = function (v) { if (window.setScanSize(v)) toast("扫描范围已设为成交额前 " + v + " 个币（下一轮推荐生效）"); };
  window.settingsToggleSignal = function (on) { window.setSignalNotify(!!on); toast(on ? "新信号提醒已开启" : "新信号提醒已关闭"); };

  // ---------- AI 解读 ----------
  window.llmSave = async function () {
    var a = api();
    if (!a.llmSetConfig) return;
    setBusy("llmMsg", "保存中…");
    try {
      var r = await a.llmSetConfig({
        baseUrl: ($("llm_baseUrl") || {}).value, model: ($("llm_model") || {}).value,
        apiKey: ($("llm_key") || {}).value, useProxy: !!($("llm_proxy") || {}).checked
      });
      if (r && r.ok) { S.llm = r.config; var k = $("llm_key"); if (k) k.value = r.config.apiKey || ""; msg("llmMsg", "已保存", true); }
      else msg("llmMsg", (r && (r.error || r.__error)) || "保存失败", false);
    } catch (e) { msg("llmMsg", "保存失败：" + (e && e.message), false); }
  };
  window.llmClear = async function () {
    var a = api();
    if (!a.llmSetConfig) return;
    var r = await a.llmSetConfig({});
    if (r && r.ok) { S.llm = r.config; renderSettings(); toast("已清除 AI 解读配置"); }
    else msg("llmMsg", (r && r.error) || "清除失败", false);
  };

  // ---------- 备份 ----------
  // 备份范围：novatrade 开头的本地存储键；排除可再生的缓存 / 临时状态
  var BACKUP_EXCLUDE = [/^novatrade_kline_v1::/, /^novatrade_kline_idx_v1$/, /^novatrade\.recommend-snapshot\./, /^novatrade_shadow_v1$/, /^novatrade_signal_notified$/];
  function backupKeyOk(k) { return /^novatrade[._]/.test(k) && !BACKUP_EXCLUDE.some(function (re) { return re.test(k); }); }
  window.backupExport = async function () {
    var a = api();
    if (!a.backupExport) return;
    var local = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (backupKeyOk(k)) local[k] = localStorage.getItem(k);
    }
    var info = a.appInfo ? await a.appInfo() : { version: "" };
    var pack = { kind: "novatrade-backup", version: 1, createdAt: new Date().toISOString(), app: info.version, local: local, fwd: (typeof fwdRecords !== "undefined" && Array.isArray(fwdRecords)) ? fwdRecords : [] };
    var r = await a.backupExport(JSON.stringify(pack), "novatrade-backup-" + new Date().toISOString().slice(0, 10) + ".json");
    if (r && r.ok) msg("backupMsg", "已导出：" + r.path, true);
    else if (r && r.canceled) setBusy("backupMsg", "");
    else msg("backupMsg", (r && (r.error || r.__error)) || "导出失败", false);
  };
  window.backupImport = async function () {
    var a = api();
    if (!a.backupImport) return;
    var r = await a.backupImport();
    if (!r || !r.ok) { if (r && r.canceled) return; msg("backupMsg", (r && (r.error || r.__error)) || "导入失败", false); return; }
    var d = r.data;
    if (d.kind !== "novatrade-backup" || !d.local || typeof d.local !== "object" || Array.isArray(d.local)) { msg("backupMsg", "不是 NovaTrade 的备份文件", false); return; }
    var keys = Object.keys(d.local).filter(function (k) { return backupKeyOk(k) && typeof d.local[k] === "string" && d.local[k].length <= 5 * 1024 * 1024; });
    if (!keys.length && !(Array.isArray(d.fwd) && d.fwd.length)) { msg("backupMsg", "备份里没有可导入的数据", false); return; }
    if (!window.confirm("将导入 " + keys.length + " 项本地数据" + (Array.isArray(d.fwd) ? " 和 " + d.fwd.length + " 条前向验证记录" : "") + "，覆盖同名的现有数据，并重新加载页面。继续？")) return;
    keys.forEach(function (k) { try { localStorage.setItem(k, d.local[k]); } catch (e) { /* 配额不足时跳过该项 */ } });
    if (Array.isArray(d.fwd) && d.fwd.length && window.binanceAPI && window.binanceAPI.fwdSave) {
      var okRecs = d.fwd.filter(function (x) { return x && typeof x === "object" && !Array.isArray(x); }).slice(0, 50000);
      try { await window.binanceAPI.fwdSave(okRecs); } catch (e) { /* 忽略 */ }
    }
    location.reload();
  };

  // ---------- 诊断与更新 ----------
  window.checkUpdateNow = async function () {
    var a = api();
    if (!a.checkUpdate) return;
    setBusy("aboutMsg", "检查中…");
    var r = await a.checkUpdate();
    if (!r || !r.ok) { msg("aboutMsg", "检查失败：" + ((r && (r.error || r.__error)) || "未知原因"), false); return; }
    if (r.none) msg("aboutMsg", "还没有发布任何版本（当前 " + r.current + "）", true);
    else if (r.newer) msg("aboutMsg", "发现新版本 " + r.latest + "（当前 " + r.current + "）。点「打开发布页」下载。", true);
    else msg("aboutMsg", "已是最新版本（" + r.current + "）", true);
  };
  window.exportDiag = async function () {
    var a = api();
    if (!a.exportDiagnostics) return;
    var r = await a.exportDiagnostics();
    if (r && r.ok) msg("aboutMsg", "已导出：" + r.path, true);
    else if (!(r && r.canceled)) msg("aboutMsg", (r && (r.error || r.__error)) || "导出失败", false);
  };
  window.openReleasePage = function () { var a = api(); if (a.openReleases) a.openReleases(); };

  // 启动后静默检查一次更新（每天最多一次；只提示，不自动下载 / 安装）
  function autoCheckUpdate() {
    var a = api();
    if (!a.checkUpdate) return;
    try {
      var last = parseInt(localStorage.getItem("novatrade_update_checked") || "0", 10);
      if (Date.now() - last < 24 * 3600e3) return;
      localStorage.setItem("novatrade_update_checked", String(Date.now()));
    } catch (e) { /* 存储不可用时照常检查 */ }
    a.checkUpdate().then(function (r) {
      if (r && r.ok && r.newer) toast("发现新版本 " + r.latest + "，可在「设置 → 诊断与更新」查看");
    }).catch(function () {});
  }
  setTimeout(autoCheckUpdate, 20000);

  window.renderSettings = renderSettings;
})();
