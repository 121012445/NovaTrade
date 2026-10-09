'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createPush, buildRequest, isSuccess, MASK } = require('../main/push');

// 假的 safeStorage：可逆但不是明文（用于验证落盘内容里没有明文凭据）
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(Buffer.from(s).toString('hex').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString()
});
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-push-')), 'push.json');
const TG = { type: 'telegram', botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123', chatId: '-1001234567890', enabled: true };

test('buildRequest：各渠道的地址与载荷', () => {
  const m = { title: '标题', body: '正文' };
  const tg = buildRequest(TG, m, 1700000000);
  assert.equal(tg.url.href, 'https://api.telegram.org/bot' + TG.botToken + '/sendMessage');
  assert.deepEqual(JSON.parse(tg.body), { chat_id: TG.chatId, text: '标题\n正文', disable_web_page_preview: true });

  const wecom = buildRequest({ type: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }, m, 1);
  assert.deepEqual(JSON.parse(wecom.body), { msgtype: 'text', text: { content: '标题\n正文' } });

  const bark = buildRequest({ type: 'bark', url: 'https://api.day.app/KEY' }, m, 1);
  assert.equal(JSON.parse(bark.body).group, 'NovaTrade');

  const hook = buildRequest({ type: 'webhook', url: 'https://example.com/h' }, m, 1700000000);
  assert.deepEqual(JSON.parse(hook.body), { title: '标题', body: '正文', ts: 1700000000000, source: 'NovaTrade' });

  const noSecret = JSON.parse(buildRequest({ type: 'feishu', url: 'https://open.feishu.cn/x', secret: '' }, m, 5).body);
  assert.equal(noSecret.sign, undefined);
  const fs1 = JSON.parse(buildRequest({ type: 'feishu', url: 'https://open.feishu.cn/x', secret: 'S3cret' }, m, 1700000000).body);
  const expected = crypto.createHmac('sha256', '1700000000\nS3cret').update('').digest('base64');
  assert.equal(fs1.timestamp, '1700000000');
  assert.equal(fs1.sign, expected);
});

test('isSuccess：HTTP 200 不等于成功，要看各渠道的业务返回', () => {
  assert.equal(isSuccess({ type: 'telegram' }, 200, '{"ok":true}'), true);
  assert.equal(isSuccess({ type: 'telegram' }, 200, '{"ok":false,"description":"chat not found"}'), false);
  assert.equal(isSuccess({ type: 'telegram' }, 500, '{"ok":true}'), false);
  assert.equal(isSuccess({ type: 'feishu' }, 200, '{"code":0}'), true);
  assert.equal(isSuccess({ type: 'feishu' }, 200, '{"code":19021,"msg":"sign match fail"}'), false);
  assert.equal(isSuccess({ type: 'wecom' }, 200, '{"errcode":0}'), true);
  assert.equal(isSuccess({ type: 'wecom' }, 200, '{"errcode":93000}'), false);
  assert.equal(isSuccess({ type: 'webhook' }, 204, ''), true);
});

test('配置：加密落盘（文件中无明文），读取只返回打码值，打码占位符保留原值', () => {
  const file = tmpFile();
  const p = createPush({ safeStorage: fakeSafe(), file, post: async () => ({ status: 200, body: '{"ok":true}' }) });
  const r = p.setConfig({ channels: [TG] });
  assert.equal(r.ok, true);
  const disk = fs.readFileSync(file, 'utf8');
  assert.ok(!disk.includes(TG.botToken) && !disk.includes('ABCDEFGHIJ'), '落盘内容不应含明文令牌');
  const pub = p.getPublicConfig();
  assert.equal(pub.channels[0].botToken, MASK + TG.botToken.slice(-4));
  assert.equal(pub.channels[0].chatId, TG.chatId);
  assert.ok(!JSON.stringify(pub).includes('ABCDEFGHIJ'));
  // 用打码值回写 → 保留原令牌；只改 chatId
  const masked = Object.assign({}, pub.channels[0], { chatId: '-100999' });
  assert.equal(p.setConfig({ channels: [masked] }).ok, true);
  assert.equal(p._channels()[0].botToken, TG.botToken);
  assert.equal(p._channels()[0].chatId, '-100999');
  // 重新加载（模拟重启）
  const p2 = createPush({ safeStorage: fakeSafe(), file, post: async () => ({ status: 200, body: '{"ok":true}' }) });
  assert.equal(p2._channels()[0].botToken, TG.botToken);
});

test('系统安全存储不可用时拒绝保存', () => {
  const p = createPush({ safeStorage: fakeSafe(false), file: tmpFile() });
  const r = p.setConfig({ channels: [TG] });
  assert.equal(r.ok, false);
  assert.match(r.error, /安全存储/);
  assert.equal(p._channels().length, 0, '保存失败不应留下内存里的凭据');
});

test('配置校验：类型 / 地址必须 https / 数量上限', () => {
  const p = createPush({ safeStorage: fakeSafe(), file: tmpFile() });
  assert.match(p.setConfig({ channels: [{ type: 'sms' }] }).error, /不支持/);
  assert.match(p.setConfig({ channels: [{ type: 'wecom', url: 'http://example.com/x' }] }).error, /https/);
  assert.match(p.setConfig({ channels: [{ type: 'wecom', url: 'file:///etc/passwd' }] }).error, /https/);
  assert.match(p.setConfig({ channels: [{ type: 'bark', url: '' }] }).error, /地址/);
  assert.match(p.setConfig({ channels: [{ type: 'telegram', botToken: 'x', chatId: '1' }] }).error, /botToken/);
  assert.match(p.setConfig({ channels: [Object.assign({}, TG, { chatId: 'abc' })] }).error, /chatId/);
  assert.equal(p.setConfig({ channels: [{ type: 'webhook', url: 'http://127.0.0.1:8080/h' }] }).ok, true, '本机回环地址的 Webhook 允许 http');
  assert.match(p.setConfig({ channels: [{ type: 'webhook', url: 'http://10.0.0.5/h' }] }).error, /https/);
  assert.match(p.setConfig({ channels: Array.from({ length: 7 }, () => ({ type: 'webhook', url: 'https://a.b/c' })) }).error, /最多/);
  assert.match(p.setConfig(null).error, /格式/);
});

test('send：并发发往所有启用渠道；失败信息被脱敏；去重与小时上限', async () => {
  let t = 1_000_000;
  const calls = [];
  const post = async (o) => {
    calls.push(o.url.hostname);
    if (o.url.hostname === 'bad.example.com') throw new Error('connect ECONNREFUSED https://bad.example.com/secret-path?token=abc');
    return { status: 200, body: o.url.hostname === 'api.telegram.org' ? '{"ok":true}' : '{}' };
  };
  const p = createPush({ safeStorage: fakeSafe(), file: tmpFile(), post, now: () => t });
  p.setConfig({ channels: [TG, { type: 'webhook', url: 'https://bad.example.com/secret-path' }, { type: 'wecom', url: 'https://qy.example.com/x', enabled: false }] });
  const r = await p.send({ title: 'BTC 预警', body: '现价 100' });
  assert.equal(r.ok, true, '至少一个渠道成功即 ok');
  assert.deepEqual(calls.sort(), ['api.telegram.org', 'bad.example.com'], '停用的渠道不发送');
  const bad = r.results.find((x) => !x.ok);
  assert.ok(!/secret-path|token=abc/.test(bad.error), '错误信息不应含 URL 细节: ' + bad.error);

  const n = calls.length;
  assert.equal((await p.send({ title: 'BTC 预警', body: '现价 100' })).skipped, 'duplicate');
  assert.equal(calls.length, n);
  t += 31000;
  assert.equal((await p.send({ title: 'BTC 预警', body: '现价 100' })).skipped, undefined, '30 秒后可再次发送');

  // 小时上限：同一小时内最多 60 条
  let sent = 0;
  for (let i = 0; i < 80; i++) { const x = await p.send({ title: 'T' + i, body: '' }); if (!x.skipped) sent++; }
  assert.ok(sent < 60, '应被小时上限截断，实际 ' + sent);
});

test('没有配置渠道时 send 直接跳过；test() 绕过去重', async () => {
  const calls = [];
  const p = createPush({ safeStorage: fakeSafe(), file: tmpFile(), post: async (o) => { calls.push(1); return { status: 200, body: '{"ok":true}' }; } });
  assert.equal((await p.send({ title: 'x' })).skipped, 'no-channel');
  p.setConfig({ channels: [TG] });
  const id = p._channels()[0].id;
  await p.test(id); await p.test(id);
  assert.equal(calls.length, 2);
});
