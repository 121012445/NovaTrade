'use strict';
// 用假 electron + 假网络驱动真实的 main/index.js，检查 IPC 接线、入参校验与持久化。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('../testlib/mock-electron');

const ROW = (t) => [[t, '1', '1', '1', '1', '1', t + 1]];
const routes = (o) => {
  if (o.hostname.startsWith('fapi')) {
    if (o.path.includes('FOOUSDT')) return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
    if (o.path.includes('RATEUSDT')) return { status: 429, body: {}, headers: { 'retry-after': '3' } };
    return { status: 200, body: ROW(1) };
  }
  return { status: 200, body: ROW(9) };
};
const m = boot(routes);
test.after(() => m.cleanup());

test('合约成功：直接返回合约数据', async () => {
  const r = await m.call('binance:getKlines', 'btcusdt', '1h', 5);
  assert.equal(r[0][0], 1);
  assert.match(m.seen.at(-1), /^fapi\.binance\.com\/fapi\/v1\/klines\?symbol=BTCUSDT&interval=1h&limit=5$/);
});

test('没有永续合约（-1121）：回退到现货，且现货 limit 收敛到 1000', async () => {
  const r = await m.call('binance:getKlines', 'FOOUSDT', '1h', 2000);
  assert.equal(r[0][0], 9);
  assert.ok(m.seen.some((u) => /FOOUSDT&interval=1h&limit=1000$/.test(u) && !u.startsWith('fapi')));
});

test('入参校验：非法交易对 / 周期被拒绝，且不会发出请求', async () => {
  const before = m.seen.length;
  assert.match((await m.call('binance:getKlines', 'BTC/USDT; DROP', '1h', 5)).__error, /invalid symbol/);
  assert.match((await m.call('binance:getKlines', 'BTCUSDT', '1h&limit=9999#', 5)).__error, /invalid interval/);
  assert.match((await m.call('binance:getFuturesKlines', '../etc', '1h', 5)).__error, /invalid symbol/);
  assert.match((await m.call('deriv:snapshot', 'a b', '1h', 5)).__error, /invalid symbol/);
  assert.match((await m.call('binance:futuresDepth', '', 5)).__error, /invalid symbol/);
  assert.equal(m.seen.length, before);
});

test('limit 被夹到合理范围；depth 只用币安允许的档位', async () => {
  await m.call('binance:getKlines', 'ETHUSDT', '4h', 999999);
  assert.match(m.seen.at(-1), /limit=1500$/);
  await m.call('binance:futuresDepth', 'ETHUSDT', 300);
  assert.match(m.seen.at(-1), /depth\?symbol=ETHUSDT&limit=500$/);
  await m.call('binance:aggTrades', 'ETHUSDT', -5);
  assert.match(m.seen.at(-1), /aggTrades\?symbol=ETHUSDT&limit=10$/);
});

test('来自非本地页面的 IPC 调用被拒绝', async () => {
  const before = m.seen.length;
  const r = await m.callUntrusted('binance:getTickers');
  assert.equal(r.__error, 'untrusted sender');
  assert.equal(m.seen.length, before);
});

test('前向验证：校验入参、原子写入、损坏后从备份恢复', async () => {
  assert.equal(await m.call('fwd:save', { evil: true }), false);
  assert.equal(await m.call('fwd:save', [1, 2, 3]), false);
  assert.equal(await m.call('fwd:save', [{ ts: 1, symbol: 'AAAUSDT' }]), true);
  await m.call('fwd:save', [{ ts: 2, symbol: 'BBBUSDT' }]);   // 第二次保存会生成 .bak
  const f = path.join(m.userData, 'forward_validation.json');
  assert.ok(fs.existsSync(f + '.bak'));
  assert.ok(!fs.existsSync(f + '.tmp'), '不应残留临时文件');
  fs.writeFileSync(f, '{"truncated": [1,2');                  // 模拟写坏
  const loaded = await m.call('fwd:load');
  assert.equal(loaded[0].symbol, 'AAAUSDT', '应从 .bak 恢复');
  assert.ok(fs.readdirSync(m.userData).some((x) => x.startsWith('forward_validation.json.corrupt-')), '坏文件应改名留证');
});

test('代理设置：只接受空串或 http/https/socks 地址，并同步到 Chromium 会话', async () => {
  assert.equal(await m.call('futures:setProxy', 'ftp://evil'), false);
  assert.equal(await m.call('futures:setProxy', 'javascript:alert(1)'), false);
  assert.equal(await m.call('futures:setProxy', 'http://127.0.0.1:7890'), true);
  assert.equal(await m.call('futures:getProxy'), 'http://127.0.0.1:7890');
  assert.deepEqual(JSON.parse(JSON.stringify(m.sessionCalls.at(-1))), { proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '<local>' });
  assert.equal(await m.call('futures:setProxy', ''), true);
  assert.deepEqual(JSON.parse(JSON.stringify(m.sessionCalls.at(-1))), { mode: 'system' });
});

test('导出：拒绝非 PNG 数据与超大载荷', async () => {
  assert.equal((await m.call('file:exportPng', 'x.png', 'data:text/html;base64,AAAA')).ok, false);
  assert.equal((await m.call('file:exportPng', 'x.png', 'not a data url')).ok, false);
  assert.equal((await m.call('file:exportCsv', 'x.csv', { not: 'a string' })).ok, false);
});

// 放在最后：触发限流后合约类接口会进入退避期，会影响其后的合约请求
test('限流（429）：首个请求报错，之后同类请求直接失败而不再发出网络请求', async () => {
  const a = await m.call('binance:getFuturesPrice', 'RATEUSDT');
  assert.match(a.__error, /rate limited/i);
  const before = m.seen.length;
  const b = await m.call('binance:getFuturesTickers');
  assert.match(b.__error, /rate limited/i);
  assert.equal(m.seen.length, before, '退避期内不应发起网络请求');
  const spot = await m.call('binance:getTickers');
  assert.ok(Array.isArray(spot), '现货接口不受合约限流影响');
});
