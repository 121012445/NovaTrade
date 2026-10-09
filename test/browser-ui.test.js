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
  await page.evaluate(() => window.liqConnect());
  assert.equal(await page.evaluate(() => window.__sockets.length), 1);
  assert.match(await page.evaluate(() => window.__sockets[0].url), /^wss:\/\/fstream\.binance\.com\/ws\/!forceOrder@arr$/);
  await page.evaluate(() => window.__sockets[0].onopen());
  assert.equal(await page.evaluate(() => window.__liq.status), 'open');
  // 收到一条强平消息
  await page.evaluate(() => window.__sockets[0].onmessage({ data: JSON.stringify({ o: { s: 'BTCUSDT', S: 'SELL', ap: '100', z: '5', T: Date.now() } }) }));
  assert.equal(await page.evaluate(() => window.__liq.events.length), 1);
  // 断线 → 排队重连（首次约 2s）
  await page.evaluate(() => window.__sockets[0].onclose({}));
  const st = await page.evaluate(() => ({ status: window.__liq.status, hasTimer: !!window.__liq.timer, wait: window.__liq.nextRetryAt - Date.now(), retry: window.__liq.retry }));
  assert.equal(st.status, 'closed');
  assert.equal(st.hasTimer, true);
  assert.ok(st.wait > 1500 && st.wait <= 2600, '首次退避约 2s，实际 ' + st.wait);
  assert.equal(st.retry, 1);
  await page.waitForFunction(() => window.__sockets.length === 2, null, { timeout: 6000 });
  // 再次失败：退避翻倍
  await page.evaluate(() => { window.__sockets[1].onerror(); window.__sockets[1].onclose({}); });
  const st2 = await page.evaluate(() => ({ wait: window.__liq.nextRetryAt - Date.now(), retry: window.__liq.retry, status: window.__liq.status }));
  assert.equal(st2.retry, 2);
  assert.ok(st2.wait > 3500 && st2.wait <= 4600, '第二次退避约 4s，实际 ' + st2.wait);
  assert.equal(st2.status, 'error');
  // 手动断开：清掉定时器，不再重连
  await page.evaluate(() => window.liqDisconnect());
  assert.equal(await page.evaluate(() => ({ t: window.__liq.timer, s: window.__liq.status, m: window.__liq.manual })).then((x) => JSON.stringify(x)), JSON.stringify({ t: null, s: 'idle', m: true }));
  await page.waitForTimeout(4800);
  assert.equal(await page.evaluate(() => window.__sockets.length), 2, '手动断开后不应再创建连接');
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
