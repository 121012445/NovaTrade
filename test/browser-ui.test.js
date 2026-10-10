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
  const { page } = await open(`window.__fwdStore = ${JSON.stringify(recs)};`);
  await page.click(`[onclick="showView('recommend')"], [data-onclick="showView('recommend')"]`);
  await page.waitForFunction(() => /门控归因/.test(document.getElementById('fwdLedger').innerText), null, { timeout: 15000 });
  const t = await page.locator('#fwdLedger .fa-wrap').innerText();
  assert.match(t, /多头信号/);
  assert.match(t, /仅被「过热区（70–74 分不做多）」拦截/);
  assert.match(t, /拦下的反而更好/);
});
