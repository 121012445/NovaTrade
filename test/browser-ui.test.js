'use strict';
// 浏览器集成测试：用 headless Chromium 打开真实的 renderer/index.html（严格 CSP），
// 注入假的 binanceAPI / electronAPI（见 testlib/browser-harness.js）。找不到 Chromium 时整体跳过。
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../testlib/browser-harness');

const skip = h.available() ? false : '没有可用的 playwright-core / Chromium';
const CSP_PROBE = "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+(e.blockedURI||'')+' '+(e.sample||''));});";

let browser, ctx;
test.before(async () => { if (!skip) ({ browser, ctx } = await h.launch()); });
test.after(async () => { if (browser) await browser.close(); });

async function open(extraInit) {
  const r = await h.openApp(ctx, { init: CSP_PROBE + (extraInit || '') });
  await r.page.waitForFunction(() => document.querySelectorAll('#coinGrid .coin-card').length > 0, null, { timeout: 15000 });
  return r;
}

test('严格 CSP 下正常启动：无脚本错误、无 CSP 违规，导航按钮可用', { skip }, async () => {
  const { page, errors } = await open();
  await page.waitForTimeout(1500);
  for (const view of ['recommend', 'analysis', 'screener', 'alerts', 'mine', 'market']) {
    await page.click(`[onclick="showView('${view}')"], [data-onclick="showView('${view}')"]`);
    const active = await page.evaluate(() => document.querySelector('.view.active').id);
    assert.equal(active, 'view-' + view);
  }
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  // 页面上所有内联处理器引用的全局函数都存在
  const missing = await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll('*').forEach((e) => {
      for (const a of e.getAttributeNames()) {
        if (!/^(data-)?on(click|change|input|keydown)$/.test(a)) continue;
        const m = /^([A-Za-z_$][\w$]*)\(/.exec(e.getAttribute(a));
        if (m && m[1] !== 'event' && typeof window[m[1]] !== 'function') out.add(m[1]);
      }
    });
    return [...out];
  });
  assert.deepEqual(missing, []);
});

test('内联处理器里的 event.stopPropagation() 生效：点自选星标只切换自选，不会选中该币', { skip }, async () => {
  const { page } = await open();
  const before = await page.evaluate(() => selectedCoin);
  const card = page.locator('#coinGrid .coin-card').nth(3);
  const sym = await card.getAttribute('data-coin');
  await card.locator('.coin-star').click();
  const after = await page.evaluate(() => ({ sel: selectedCoin, watch: JSON.parse(localStorage.getItem(WATCH_KEY) || '[]') }));
  assert.equal(after.sel, before, '星标点击不应触发卡片的选中逻辑');
  assert.ok(after.watch.includes(sym), '应加入自选');
});

test('注入的内联脚本与内联事件属性不会执行', { skip }, async () => {
  const { page, errors } = await open();
  let dialogs = 0;
  page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = '<img src="x" onerror="window.__pwn1=1"><button id="evil" onclick="alert(1)">x</button><button id="evil2" onclick="window.__pwn2=1">y</button>';
    document.body.appendChild(d);
    const s = document.createElement('script'); s.textContent = 'window.__pwn3=1'; document.body.appendChild(s);
  });
  await page.click('#evil'); await page.click('#evil2');
  await page.waitForTimeout(300);
  const pwn = await page.evaluate(() => [window.__pwn1, window.__pwn2, window.__pwn3]);
  assert.deepEqual(pwn, [undefined, undefined, undefined]);
  assert.equal(dialogs, 0, 'alert 不应被调用');
  assert.ok(errors.some((e) => /inline-handlers|native function|Refused|Content Security/.test(e)), '违规写法应被记录为错误');
});

test('强平流：断线后指数退避自动重连；手动断开后不再重连', { skip }, async () => {
  const { page } = await open();
  // 应用启动时还会为实时行情创建一个 WebSocket，这里只看强平流那一个
  const L = "window.__sockets.filter(function (s) { return /forceOrder/.test(s.url); })";
  await page.evaluate(() => window.liqConnect());
  assert.equal(await page.evaluate(`${L}.length`), 1);
  assert.match(await page.evaluate(`${L}[0].url`), /^wss:\/\/fstream\.binance\.com\/ws\/!forceOrder@arr$/);
  await page.evaluate(`${L}[0].onopen()`);
  assert.equal(await page.evaluate(() => window.__liq.status), 'open');
  // 收到一条强平消息
  await page.evaluate(`${L}[0].onmessage({ data: JSON.stringify({ o: { s: 'BTCUSDT', S: 'SELL', ap: '100', z: '5', T: Date.now() } }) })`);
  assert.equal(await page.evaluate(() => window.__liq.events.length), 1);
  // 断线 → 排队重连（首次约 2s）
  await page.evaluate(`${L}[0].onclose({})`);
  const st = await page.evaluate(() => ({ status: window.__liq.status, hasTimer: !!window.__liq.timer, wait: window.__liq.nextRetryAt - Date.now(), retry: window.__liq.retry }));
  assert.equal(st.status, 'closed');
  assert.equal(st.hasTimer, true);
  assert.ok(st.wait > 1500 && st.wait <= 2600, '首次退避约 2s，实际 ' + st.wait);
  assert.equal(st.retry, 1);
  await page.waitForFunction(() => window.__sockets.filter((x) => /forceOrder/.test(x.url)).length === 2, null, { timeout: 6000 });
  // 再次失败：退避翻倍
  await page.evaluate(`(function(){ var s = ${L}[1]; s.onerror(); s.onclose({}); })()`);
  const st2 = await page.evaluate(() => ({ wait: window.__liq.nextRetryAt - Date.now(), retry: window.__liq.retry, status: window.__liq.status }));
  assert.equal(st2.retry, 2);
  assert.ok(st2.wait > 3500 && st2.wait <= 4600, '第二次退避约 4s，实际 ' + st2.wait);
  assert.equal(st2.status, 'error');
  // 手动断开：清掉定时器，不再重连
  await page.evaluate(() => window.liqDisconnect());
  assert.equal(await page.evaluate(() => ({ t: window.__liq.timer, s: window.__liq.status, m: window.__liq.manual })).then((x) => JSON.stringify(x)), JSON.stringify({ t: null, s: 'idle', m: true }));
  await page.waitForTimeout(4800);
  assert.equal(await page.evaluate(`${L}.length`), 2, '手动断开后不应再创建连接');
});

const RT = "window.__sockets.filter(function (s) { return /miniTicker/.test(s.url); })";

test('实时推送：价格每秒更新，行情卡片刷新，预警秒级触发（并走远程推送）', { skip }, async () => {
  const { page } = await open();
  assert.equal(await page.evaluate(`${RT}.length`), 1, '启动后应建立行情推送连接');
  assert.match(await page.evaluate(`${RT}[0].url`), /^wss:\/\/fstream\.binance\.com\/ws\/!miniTicker@arr$/);
  await page.evaluate(`${RT}[0].onopen()`);
  const px0 = await page.evaluate(() => allCoins.find((c) => c.symbol === 'ETHUSDT').price);
  // 建一个「价格 ≥ 现价 +1%」的预警（此刻未满足 → 直接武装）
  await page.click(`[onclick="showView('alerts')"], [data-onclick="showView('alerts')"]`);
  await page.fill('#al_sym', 'ETHUSDT');
  await page.selectOption('#al_kind', 'above');
  await page.fill('#al_val', String(px0 * 1.01));
  await page.click('button:has-text("添加预警")');
  assert.equal(await page.evaluate(() => loadAlerts()[0].armed), true);
  // 推送一个高于目标的价格
  const px1 = px0 * 1.02;
  await page.evaluate(`${RT}[0].onmessage({ data: JSON.stringify([{ s: 'ETHUSDT', c: '${px1}', o: '${px0}', h: '${px1}', l: '${px0}', q: '123456789' }]) })`);
  await page.waitForFunction(() => loadAlerts()[0].triggeredAt > 0, null, { timeout: 4000 });
  const info = await page.evaluate(() => ({
    price: allCoins.find((c) => c.symbol === 'ETHUSDT').price,
    pushed: window.__calls.some((c) => c[0] === 'electronAPI.pushSend' && /ETH/.test(JSON.stringify(c))),
    hit: loadAlerts()[0].hitDetail
  }));
  assert.ok(Math.abs(info.price - px1) < 1e-9);
  assert.equal(info.pushed, true, '预警应同时走远程推送通道');
  assert.match(info.hit, /现价/);
  // 推送健康时，30s 的全量轮询不再重复拉取
  const before = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'getTickers').length);
  assert.equal(before, 1);
});

test('创建时已满足的预警不会立刻触发，离开再进入才触发', { skip }, async () => {
  const { page } = await open();
  await page.evaluate(`${RT}[0].onopen()`);
  const px = await page.evaluate(() => allCoins.find((c) => c.symbol === 'SOLUSDT').price);
  await page.click(`[onclick="showView('alerts')"], [data-onclick="showView('alerts')"]`);
  await page.fill('#al_sym', 'SOLUSDT');
  await page.selectOption('#al_kind', 'above');
  await page.fill('#al_val', String(px * 0.9));           // 现价已经高于目标
  await page.click('button:has-text("添加预警")');
  const a0 = await page.evaluate(() => loadAlerts()[0]);
  assert.equal(a0.armed, false);
  assert.equal(a0.triggeredAt, 0);
  await page.evaluate(() => checkAlerts());
  assert.equal(await page.evaluate(() => loadAlerts()[0].triggeredAt), 0, '一直满足时不触发');
  const push = (p) => page.evaluate(`${RT}[0].onmessage({ data: JSON.stringify([{ s: 'SOLUSDT', c: '${p}', o: '${px}', q: '1' }]) })`);
  await push(px * 0.8);                                     // 跌回目标之下 → 武装
  await page.waitForFunction(() => loadAlerts()[0].armed === true, null, { timeout: 4000 });
  await push(px * 1.0);                                     // 再次突破 → 触发
  await page.waitForFunction(() => loadAlerts()[0].triggeredAt > 0, null, { timeout: 4000 });
});

test('完整回测 UI：跑回测、参数稳定性扫描、多币种组合回测', { skip }, async () => {
  const { page, errors } = await open();
  await page.click(`[data-onclick="showView('analysis')"], [onclick="showView('analysis')"]`);
  await page.waitForSelector('.ana-tab[data-pane="p_bt"]', { timeout: 15000 });
  await page.click('.ana-tab[data-pane="p_bt"]');
  await page.waitForSelector('#btFullBox button.btn-primary');
  assert.ok(await page.locator('#bf_slip').count(), '应有滑点输入');
  assert.ok(await page.locator('#bf_funding').count(), '应有资金费率输入');

  await page.click('button:has-text("跑完整回测")');
  await page.waitForFunction(() => /成本模型|没有产生任何交易|失败/.test(document.getElementById('btFullBox').innerText), null, { timeout: 60000 });
  const txt = await page.locator('#btFullBox').innerText();
  assert.ok(!/完整回测失败/.test(txt), txt.slice(0, 200));

  await page.click('button:has-text("参数稳定性扫描")');
  await page.waitForSelector('#btSweepBox table', { timeout: 90000 });
  assert.equal(await page.locator('#btSweepBox table tr').count(), 5, '4 个止盈倍数 + 表头');
  assert.match(await page.locator('#btSweepBox').innerText(), /连成一片|孤岛/);

  await page.fill('#bf_portN', '3');
  await page.click('button:has-text("多币种组合回测")');
  await page.waitForFunction(() => /多币种组合回测（/.test(document.getElementById('btPortBox').innerText), null, { timeout: 120000 });
  assert.match(await page.locator('#btPortBox').innerText(), /幸存者偏差/);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors.filter((e) => !/Failed to load resource/.test(e)), []);
});

test('设置页：添加推送渠道并保存（凭据只回显尾号）、测试按钮、扫描范围与新信号提醒开关', { skip }, async () => {
  const { page, errors } = await open();
  await page.click(`[onclick="showView('settings')"], [data-onclick="showView('settings')"]`);
  await page.waitForSelector('#pushNewType');
  await page.selectOption('#pushNewType', 'telegram');
  await page.click('button:has-text("添加")');
  await page.fill('.set-ch [data-f="botToken"]', '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123');
  await page.fill('.set-ch [data-f="chatId"]', '-100123');
  await page.click('button:has-text("保存推送设置")');
  await page.waitForFunction(() => /已保存/.test(document.getElementById('pushMsg').textContent));
  const shown = await page.inputValue('.set-ch [data-f="botToken"]');
  assert.equal(shown, '••••-123', '保存后只回显尾号');
  assert.ok(!(await page.content()).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  await page.click('.set-ch button:has-text("测试")');
  await page.waitForFunction(() => /测试消息已发送/.test(document.getElementById('pushMsg').textContent));
  // 用打码值再次保存：不会把占位符当成新令牌（主进程保留原值）
  const sent = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'pushSetConfig').pop()[1].channels[0].botToken);
  assert.equal(sent, '••••-123');
  // 扫描范围与新信号提醒
  await page.selectOption('.set-card select[onchange], .set-card select[data-onchange]', '40');
  assert.equal(await page.evaluate(() => scanSize()), 40);
  await page.check('.set-card input[type=checkbox][onchange], .set-card input[type=checkbox][data-onchange]');
  assert.equal(await page.evaluate(() => signalNotifyEnabled()), true);
  // 删除渠道
  await page.click('.set-ch button:has-text("删除")');
  await page.waitForFunction(() => document.querySelectorAll('#pushChannels .set-ch').length === 0);
  assert.deepEqual(errors, []);
});

test('AI 解读：未配置给出提示；配置后生成解读，面板每 10 秒重绘后结果仍在；发给模型的摘要不含密钥', { skip }, async () => {
  const { page } = await open();
  await page.click(`[onclick="showView('analysis')"], [data-onclick="showView('analysis')"]`);
  await page.waitForSelector('#aiExplainBox button', { timeout: 15000 });
  await page.click('#aiExplainBox button');
  await page.waitForFunction(() => /尚未配置/.test(document.getElementById('aiExplainBox').textContent));
  // 去设置页配置
  await page.click(`[onclick="showView('settings')"], [data-onclick="showView('settings')"]`);
  await page.fill('#llm_baseUrl', 'https://api.example.com/v1');
  await page.fill('#llm_model', 'gpt-4o-mini');
  await page.fill('#llm_key', 'sk-secret-1234567890');
  await page.click('[onclick="llmSave()"], [data-onclick="llmSave()"]');
  await page.waitForFunction(() => /已保存/.test(document.getElementById('llmMsg').textContent));
  assert.equal(await page.inputValue('#llm_key'), '••••7890');
  await page.click(`[onclick="showView('analysis')"], [data-onclick="showView('analysis')"]`);
  await page.waitForSelector('#aiExplainBox button');
  await page.click('#aiExplainBox button');
  await page.waitForFunction(() => /结构偏多/.test(document.getElementById('aiExplainBox').textContent), null, { timeout: 8000 });
  assert.match(await page.locator('#aiExplainBox').innerText(), /不构成投资建议/);
  const payload = await page.evaluate(() => window.__lastLlmPayload);
  assert.ok(payload.symbol && Array.isArray(payload.signals) && payload.signals.length > 0 && payload.forwardValidation);
  assert.ok(!JSON.stringify(payload).includes('sk-secret'));
  // 分析面板整体重绘（切币再切回、或定时刷新）后，解读结果仍在
  await page.evaluate(() => { const d = window.__lastAnalysisData; renderAnalysis(d.symbol, d.a, d.klines); });
  assert.match(await page.locator('#aiExplainBox').innerText(), /结构偏多/);
});

test('AI 推荐卡片显示相对强度 / 衍生品倾向；前向验证记录带上特征向量用于影子模型', { skip }, async () => {
  const { page } = await open();
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => document.querySelectorAll('.recommend-card .rc-chip').length > 0, null, { timeout: 30000 });
  const chips = await page.locator('.recommend-card .rc-chip').allInnerTexts();
  assert.ok(chips.some((t) => /相对BTC/.test(t)), JSON.stringify(chips));
  assert.ok(chips.some((t) => /衍生品/.test(t)), JSON.stringify(chips));
  const recs = await page.evaluate(() => (window.__fwdStore || []).filter((r) => r.feat));
  assert.ok(recs.length > 0, '前向验证记录应带 feat');
  assert.equal(recs[0].feat.length, 12);
  assert.ok(recs.every((r) => r.feat.every((v) => typeof v === 'number' && isFinite(v))));
  assert.ok(recs.some((r) => typeof r.dv === 'number'), '至少有一条记录带衍生品倾向');
  // 影子模型样本不足时不显示概率，只在前向验证栏提示未就绪
  assert.ok(!chips.some((t) => /影子模型/.test(t)));
  assert.match(await page.locator('#fwdStats').innerText(), /影子模型/);
});

test('备份：导出只含 novatrade 数据且排除缓存；导入后写回并重新加载', { skip }, async () => {
  const { page } = await open();
  await page.evaluate(() => { localStorage.setItem('novatrade_alerts_v1', '[{"id":"x"}]'); localStorage.setItem('other_app_key', 'nope'); });
  await page.click(`[onclick="showView('settings')"], [data-onclick="showView('settings')"]`);
  await page.click('button:has-text("导出备份")');
  await page.waitForFunction(() => window.__saved.length === 1);
  const pack = JSON.parse(await page.evaluate(() => window.__saved[0].json));
  assert.equal(pack.kind, 'novatrade-backup');
  assert.equal(pack.local['novatrade_alerts_v1'], '[{"id":"x"}]');
  assert.ok(!('other_app_key' in pack.local), '其它应用的键不应被备份');
  assert.ok(!Object.keys(pack.local).some((k) => /kline_v1::|kline_idx|recommend-snapshot|shadow_v1/.test(k)), '缓存类数据不应被备份');
  // 导入：伪造的备份里夹带非白名单键与非字符串值，应被忽略
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => { window.__importData = { kind: 'novatrade-backup', version: 1, local: { 'novatrade_notify': '0', 'evil_key': 'x', 'novatrade_kline_idx_v1': 'junk', 'novatrade_density': 5 }, fwd: [] }; });
  await Promise.all([page.waitForEvent('load'), page.click('button:has-text("导入备份")')]);
  assert.equal(await page.evaluate(() => localStorage.getItem('novatrade_notify')), '0');
  assert.equal(await page.evaluate(() => localStorage.getItem('evil_key')), null);
  assert.notEqual(await page.evaluate(() => localStorage.getItem('novatrade_kline_idx_v1')), 'junk');
});

test('币安不可达时界面标明「备用数据源 · OKX」', { skip }, async () => {
  const { page } = await open();
  await page.evaluate(() => { window.__dataSourceMock = { name: 'okx', at: Date.now() }; return refreshDataSource(); });
  assert.match(await page.locator('#dataFreshBadge').innerText(), /备用数据源 · OKX/);
  await page.evaluate(() => { window.__dataSourceMock = { name: 'binance', at: Date.now() }; return refreshDataSource(); });
  assert.doesNotMatch(await page.locator('#dataFreshBadge').innerText(), /OKX/);
});

test('持仓页：组合风险概览显示集中度 / 杠杆 / 有效独立仓位并给出警告', { skip }, async () => {
  const { page, errors } = await open();
  await page.evaluate(() => {
    localStorage.setItem('novatrade_portfolio_v1', JSON.stringify([
      { id: 'p1', symbol: 'BTCUSDT', side: 'long', qty: 1, entry: 100, lev: 10 },
      { id: 'p2', symbol: 'ETHUSDT', side: 'long', qty: 1, entry: 100, lev: 10 },
      { id: 'p3', symbol: 'SOLUSDT', side: 'long', qty: 1, entry: 100, lev: 10 }
    ]));
  });
  await page.click(`[onclick="showView('mine')"], [data-onclick="showView('mine')"]`);
  await page.waitForFunction(() => /组合风险概览/.test((document.getElementById('portRiskBox') || {}).innerText || ''), null, { timeout: 15000 });
  const t = await page.locator('#portRiskBox').innerText();
  assert.match(t, /有效独立仓位/);
  assert.match(t, /加权杠杆\s*10\.0x/);
  assert.match(t, /杠杆 10\.0x|加权杠杆 10\.0x/);   // 警告里也应提示高杠杆
  assert.match(t, /方向高度单边/);
  assert.deepEqual(errors, []);
});

test('信号台账：门控归因表按方向显示放行 / 被拦截两组的命中率与结论', { skip }, async () => {
  const recs = [];
  const now = Date.now() - 6 * 3600e3;
  const g = { overheat: true, dailyOK: true, stopCapVeto: false };
  const p = { overheat: false, dailyOK: true, stopCapVeto: false };
  for (let i = 0; i < 30; i++) recs.push({ ts: now - i * 60e3, symbol: 'AUSDT', dir: 'long', score: 66, price: 1, gated: true, gates: p, resolved: true, r1h: { price: 1, pct: 0.1, hit: i < 10 }, r4h: { price: 1, pct: i < 9 ? 1 : -1, hit: i < 9 } });
  for (let i = 0; i < 30; i++) recs.push({ ts: now - i * 60e3, symbol: 'BUSDT', dir: 'long', score: 72, price: 1, gated: false, gates: g, resolved: true, r1h: { price: 1, pct: 0.1, hit: true }, r4h: { price: 1, pct: i < 25 ? 1 : -1, hit: i < 25 } });
  // 这些测试记录没有评分版本字段，切到「全部版本」口径
  const { page } = await open(`window.__fwdStore = ${JSON.stringify(recs)}; localStorage.setItem('novatrade_ledger_scope', 'all');`);
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => /门控归因/.test(document.getElementById('fwdLedger').innerText), null, { timeout: 15000 });
  const t = await page.locator('#fwdLedger .fa-wrap:has-text("门控归因")').innerText();
  assert.match(t, /多头信号/);
  assert.match(t, /仅被「过热区（70–74 分不做多）」拦截/);
  assert.match(t, /拦下的反而更好/);
});

test('K 线信号标注：标出该币的历史信号；从台账点进来会画出入场 / 止损 / 目标线；可关闭', { skip }, async () => {
  const H = 3600e3, base = Math.floor(Date.now() / H) * H;
  const recs = [
    { ts: base - 20 * H + 60e3, symbol: 'BTCUSDT', dir: 'long', score: 68, price: 100, sl: 95, tp: 110, gated: true, gates: {}, resolved: true, r1h: { hit: true, pct: 1 }, r4h: { hit: true, pct: 2 } },
    { ts: base - 10 * H + 60e3, symbol: 'BTCUSDT', dir: 'short', score: 35, price: 105, gated: false, gates: {}, resolved: true, r1h: { hit: false, pct: 1 }, r4h: { hit: false, pct: 1 } },
    { ts: base - 5 * H, symbol: 'ETHUSDT', dir: 'long', score: 70, price: 1, gated: true, gates: {} }
  ];
  const { page, errors } = await open(`window.__fwdStore = ${JSON.stringify(recs)};`);
  await page.evaluate((ts) => openLedgerSignal('BTCUSDT', ts), recs[0].ts);
  await page.waitForFunction(() => window.__sigMarkApi && window.__sigMarkApi.markers().length >= 2, null, { timeout: 15000 });
  const m = await page.evaluate(() => window.__sigMarkApi.markers().map((x) => x.text));
  assert.ok(m.includes('多68✓'), JSON.stringify(m));
  assert.ok(m.includes('拦空35✗'), JSON.stringify(m));
  assert.ok(!m.some((t) => /70/.test(t)), '其他币的信号不应出现');
  const lines = await page.evaluate(() => (window.__focusLines || []).map((l) => l.options().title));
  assert.deepEqual(lines, ['信号入场', '信号止损', '信号目标']);
  await page.click('#sigMarkToggle');
  assert.equal(await page.evaluate(() => window.__sigMarkApi.markers().length), 0);
  assert.equal(await page.evaluate(() => (window.__focusLines || []).length), 0);
  assert.deepEqual(errors, []);
});

test('门控开关 + 评分版本：设置里关闭过热区立即生效；台账默认只统计当前版本，可切换到全部；随机基线表显示', { skip }, async () => {
  const now = Date.now() - 6 * 3600e3;
  const mk = (i, ver, hit) => ({ ts: now - i * 60e3, symbol: 'AUSDT', dir: i % 2 ? 'long' : 'short', score: i % 2 ? 66 : 30, price: 1, gated: true, gates: {}, resolved: true, ver,
    r1h: { price: 1, pct: 0.1, hit }, r4h: { price: 1, pct: hit === (i % 2 === 1) ? 1 : -1, hit, btcPct: 0.2 } });
  const recs = [].concat(Array.from({ length: 40 }, (_, i) => mk(i, '2', i % 3 !== 0)), Array.from({ length: 10 }, (_, i) => mk(100 + i, undefined, false)));
  // 同一浏览器上下文里的测试共享 localStorage：显式重置本测试依赖的设置
  const { page, errors } = await open(`window.__fwdStore = ${JSON.stringify(recs)}; localStorage.setItem('novatrade_ledger_scope', 'current'); localStorage.removeItem('novatrade_gates_v1');`);
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => /信号 vs 随机基线/.test(document.getElementById('fwdLedger').innerText), null, { timeout: 15000 });
  // 启动时推荐扫描本身也会新增若干条当前版本的记录，所以期望值按页面里的实际记录数计算
  await page.waitForFunction(() => {
    const n = fwdRecords.filter((r) => r.ver === SCORING_VERSION).length;
    return document.getElementById('fwdLedger').innerText.includes('共 ' + n + ' 条信号') && !document.getElementById('recommendRefreshNote');
  }, null, { timeout: 30000 });
  const cnt = await page.evaluate(() => ({ cur: fwdRecords.filter((r) => r.ver === SCORING_VERSION).length, all: fwdRecords.length }));
  assert.ok(cnt.cur >= 40 && cnt.all === cnt.cur + 10);
  let t = await page.locator('#fwdLedger').innerText();
  assert.ok(t.includes('共 ' + cnt.cur + ' 条信号'), '默认只统计当前版本');
  assert.match(t, /全部版本（含旧版 10 条）/);
  assert.match(t, /相对 BTC 方向超额/);
  await page.click('button:has-text("全部版本")');
  t = await page.locator('#fwdLedger').innerText();
  assert.ok(t.includes('共 ' + cnt.all + ' 条信号'));
  // 设置：关闭过热区
  await page.click(`[onclick="showView('settings')"], [data-onclick="showView('settings')"]`);
  await page.waitForSelector('[data-gate="overheat"]');
  await page.uncheck('[data-gate="overheat"]');
  await page.waitForFunction(() => /已关闭 1 道门控/.test(document.getElementById('gateMsg').textContent));
  assert.equal(await page.evaluate(() => gateCfg().overheat), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('novatrade_gates_v1')).overheat), false);
  await page.uncheck('[data-gate="score39"]');
  assert.equal(await page.evaluate(() => SHORT_SCORE_MIN), 45);
  await page.click('button:has-text("全部恢复默认")');
  assert.equal(await page.evaluate(() => SHORT_SCORE_MIN), 39);
  assert.deepEqual(errors, []);
});

test('模拟跟踪：按现价入场、「暂不交易」信号需确认、实时推送触及目标立即归档并显示净收益', { skip }, async () => {
  const { page, errors } = await open("localStorage.removeItem('novatrade.linked-state.v1');");
  await page.evaluate(`${RT}[0].onopen()`);
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => document.querySelectorAll('.recommend-card').length > 0 && !document.getElementById('recommendRefreshNote'), null, { timeout: 30000 });
  const btn = page.locator('.recommend-card button:has-text("模拟跟踪")').first();
  const card = page.locator('.recommend-card').first();
  const sym = await card.getAttribute('data-coin');
  const blocked = await card.evaluate((el) => el.classList.contains('low-trust'));
  // 假行情里 24h 行情价与 K 线价不一致；真实环境两者一致。这里让现价等于卡片上的价格，否则会被（正确地）判为已越过止损
  await page.evaluate((s) => { const g = window.__recGroups; const c = g.buy.concat(g.sell).find((x) => x.symbol === s); allCoins.find((x) => x.symbol === s).price = c.price; }, sym);
  let asked = 0;
  page.on('dialog', async (d) => { asked++; await d.accept(); });
  await btn.click();
  await page.waitForFunction((s) => (JSON.parse(localStorage.getItem('novatrade.linked-state.v1') || '{"tracks":[]}').tracks || []).some((t) => t.symbol === s), sym);
  assert.equal(asked, blocked ? 1 : 0, '「暂不交易」信号应先弹确认');
  const t = await page.evaluate((s) => JSON.parse(localStorage.getItem('novatrade.linked-state.v1')).tracks.find((x) => x.symbol === s), sym);
  const live = await page.evaluate((s) => allCoins.find((c) => c.symbol === s).price, sym);
  assert.equal(t.entry, live, '入场价 = 现价');
  assert.equal(t.blocked, blocked);
  // 推送一个越过目标的价格：1 秒内归档
  const px = t.direction === 'long' ? t.target * 1.01 : t.target * 0.99;
  await page.evaluate(`${RT}[0].onmessage({ data: JSON.stringify([{ s: '${sym}', c: '${px}', o: '${t.entry}', q: '1' }]) })`);
  await page.waitForFunction((s) => JSON.parse(localStorage.getItem('novatrade.linked-state.v1')).tracks.find((x) => x.symbol === s).status === 'target', sym, { timeout: 5000 });
  const done = await page.evaluate((s) => JSON.parse(localStorage.getItem('novatrade.linked-state.v1')).tracks.find((x) => x.symbol === s), sym);
  assert.ok(Math.abs(done.net - (done.pnl - 0.12)) < 1e-9);
  assert.ok(done.mfe >= done.pnl - 1e-9);
  await page.waitForFunction(() => /已结束 1 笔/.test(document.getElementById('linkedDetail').innerText), null, { timeout: 8000 });
  assert.deepEqual(errors, []);
});

test('行情状态：台账显示分组命中率；开启暂停后，处于显著偏弱状态的推荐显示为「暂不交易」并说明原因', { skip }, async () => {
  const now = Date.now() - 6 * 3600e3;
  // 所有状态组合都给 40 条命中率 10% 的放行记录 → 任何当前状态都会被判为显著偏弱
  const recs = [];
  for (const state of ['trend', 'range', 'weak']) for (let i = 0; i < 40; i++) recs.push({ ts: now - recs.length * 1000, symbol: 'ZUSDT', dir: 'long', score: 66, price: 1, gated: true, gates: {}, resolved: true, ver: '2', regime: { state, btc: 'flat', vol: 'mid' }, r1h: { hit: false, pct: -1 }, r4h: { hit: i < 4, pct: i < 4 ? 1 : -1 } });
  const { page, errors } = await open(`window.__fwdStore = ${JSON.stringify(recs)}; localStorage.setItem('novatrade_ledger_scope', 'current'); localStorage.setItem('novatrade_regime_guard', '1'); localStorage.removeItem('novatrade.recommend-snapshot.v1');`);
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => /按行情状态分组/.test(document.getElementById('fwdLedger').innerText), null, { timeout: 30000 });
  assert.match(await page.locator('#fwdLedger .fa-wrap:has-text("按行情状态分组")').innerText(), /显著偏弱/);
  await page.waitForFunction(() => /当前行情状态历史表现显著偏弱/.test(document.getElementById('recommendGrid').innerText), null, { timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('novatrade_regime_guard', '0'));
  assert.deepEqual(errors, []);
});

test('市场雷达：推送数据进入异动榜并触发异动提醒；资金面排行显示费率 / 持仓量 / 多空比榜单', { skip }, async () => {
  const { page, errors } = await open("localStorage.setItem('novatrade_radar_cfg', JSON.stringify({ on: true, pct: 2, cool: 30 }));");
  await page.evaluate(`${RT}[0].onopen()`);
  // 伪造过去 6 分钟的采样：ETH 从 100 涨到 104
  await page.evaluate(() => {
    const now = Date.now();
    window.__radar.s = { ETHUSDT: [], SOLUSDT: [] };
    for (let t = now - 6 * 60e3; t <= now; t += 10000) {
      const k = (t - (now - 6 * 60e3)) / (6 * 60e3);
      window.__radar.s.ETHUSDT.push([t, 100 + 4 * k, 288000 + k * 3000]);
      window.__radar.s.SOLUSDT.push([t, 50, 1000]);
    }
  });
  await page.click(`[onclick="showView('radar')"], [data-onclick="showView('radar')"]`);
  await page.waitForFunction(() => /ETH/.test((document.getElementById('radarMovers') || {}).innerText || ''), null, { timeout: 8000 });
  const first = await page.locator('#radarMovers tbody tr').first().innerText();
  assert.match(first, /^ETH/);
  assert.match(first, /\+3\.\d\d%/);
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'electronAPI.pushSend' && /ETH 5 分钟急涨/.test(JSON.stringify(c))), null, { timeout: 8000 });
  await page.waitForFunction(() => /资金费率最高/.test(document.getElementById('radarDeriv').innerText) && /账户多空比最高/.test(document.getElementById('radarDeriv').innerText), null, { timeout: 15000 });
  const d = await page.locator('#radarDeriv').innerText();
  assert.match(d, /持仓量 24h 增长最多/);
  assert.equal(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'premiumAll').length), 1);
  await page.click('#radarMovers tbody tr >> nth=0');
  assert.equal(await page.evaluate(() => document.querySelector('.view.active').id), 'view-analysis');
  await page.evaluate(() => localStorage.removeItem('novatrade_radar_cfg'));
  assert.deepEqual(errors, []);
});
