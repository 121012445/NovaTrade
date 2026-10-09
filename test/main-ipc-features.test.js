'use strict';
// 主进程新增功能的 IPC 集成测试：OKX 备用数据源、历史 K 线库、推送配置、备份、更新检查、诊断包。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot } = require('../testlib/mock-electron');

const H = 3600e3;
const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s).toString('hex').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString()
};
let saved = null;       // 记录 showSaveDialog 写入目标
const dialog = {
  showSaveDialog: async () => ({ canceled: false, filePath: saved }),
  showOpenDialog: async () => ({ canceled: false, filePaths: [saved] })
};
const state = { binanceDown: false, spotInvalid: false };

const routes = (o) => {
  const host = o.hostname, p = o.path;
  if (host === 'www.okx.com') {
    if (p.startsWith('/api/v5/market/tickers')) return { status: 200, body: { code: '0', data: [{ instId: 'BTC-USDT', last: '110', open24h: '100', high24h: '120', low24h: '90', volCcy24h: '9000' }] } };
    if (p.startsWith('/api/v5/market/candles')) return { status: 200, body: { code: '0', data: [['1700003600000', '2', '3', '1', '2.5', '5', '6', '7', '1'], ['1700000000000', '1', '2', '0.5', '2', '4', '5', '6', '1']] } };
  }
  if (host === 'api.github.com') return { status: 200, body: { tag_name: 'v1.3.0', html_url: 'https://github.com/121012445/NovaTrade/releases/tag/v1.3.0', name: 'v1.3.0', body: 'notes' } };
  if (/binance/.test(host)) {
    if (state.binanceDown) return { status: 502, body: 'Bad Gateway' };
    if (state.spotInvalid) return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
    if (p.includes('/klines')) {
      const q = new URL('https://x' + p).searchParams;
      const start = Number(q.get('startTime')) || 0, limit = Number(q.get('limit'));
      const now = Date.now(), rows = [];
      for (let t = Math.max(Math.ceil(start / H) * H, Math.floor(now / H) * H - 6000 * H); t <= Math.floor(now / H) * H && rows.length < limit; t += H) {
        rows.push([t, '1', '2', '0.5', '1.5', '10', t + H - 1]);
      }
      return { status: 200, body: rows };
    }
    if (p.includes('ticker/24hr')) return { status: 200, body: [{ symbol: 'ETHUSDT', lastPrice: '5', priceChangePercent: '1', quoteVolume: '1', highPrice: '6', lowPrice: '4' }] };
  }
  return undefined;
};
const m = boot(routes, { safeStorage: fakeSafe, dialog });
test.after(() => m.cleanup());

test('币安正常：行情来自币安', async () => {
  const t = await m.call('binance:getTickers');
  assert.equal(t[0].symbol, 'ETHUSDT');
  assert.equal((await m.call('data:source')).name, 'binance');
});

test('币安整体不可用（5xx）：行情与 K 线回退到 OKX，并标明数据源', async () => {
  state.binanceDown = true;
  const t = await m.call('binance:getTickers');
  assert.deepEqual(t.map((x) => [x.symbol, x.lastPrice, x.priceChangePercent]), [['BTCUSDT', '110', '10']]);
  assert.equal((await m.call('data:source')).name, 'okx');
  const k = await m.call('binance:getKlines', 'BTCUSDT', '1h', 50);
  assert.equal(k.length, 2);
  assert.equal(k[0][0], 1700000000000, 'OKX 数据已转成升序的币安格式');
  assert.equal(k[0][6], 1700000000000 + H - 1);
  assert.ok(m.seen.some((u) => u.startsWith('www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H')));
  // OKX 备用只支持 USDT 现货对
  assert.ok((await m.call('binance:getKlines', 'BTCUSDC', '1h', 5)).__error);
  state.binanceDown = false;
});

test('币安明确拒绝（4xx 业务错误）：不会切到备用源', async () => {
  state.spotInvalid = true;
  const before = m.seen.filter((u) => u.startsWith('www.okx.com')).length;
  const r = await m.call('binance:getKlines', 'FOOUSDT', '1h', 5);
  assert.match(r.__error, /Invalid symbol/);
  assert.equal(m.seen.filter((u) => u.startsWith('www.okx.com')).length, before);
  state.spotInvalid = false;
});

test('历史 K 线库：分页拉满 2500 根、落盘；第二次只增量；非法参数被拒绝', async () => {
  const r = await m.call('history:get', 'AAAUSDT', '1h', 2500);
  assert.equal(r.length, 2500);
  assert.ok(r.every((x, i) => i === 0 || x[0] === r[i - 1][0] + H));
  assert.ok(fs.existsSync(path.join(m.userData, 'klines', 'AAAUSDT_1h.json')));
  const n = m.seen.length;
  const r2 = await m.call('history:get', 'AAAUSDT', '1h', 2500);
  assert.equal(r2.length, 2500);
  assert.ok(m.seen.length - n <= 1, '第二次最多一次增量请求');
  assert.match((await m.call('history:get', 'A/B', '1h', 100)).__error, /invalid symbol/);
  assert.match((await m.call('history:get', 'AAAUSDT', '7m', 100)).__error, /invalid interval/);
});

test('推送配置：经 IPC 加密保存、读取只见打码值；非法地址被拒绝', async () => {
  const bad = await m.call('push:setConfig', { channels: [{ type: 'wecom', url: 'http://insecure.example.com/x' }] });
  assert.equal(bad.ok, false);
  const tg = { type: 'telegram', botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123', chatId: '12345', enabled: true };
  const ok = await m.call('push:setConfig', { channels: [tg] });
  assert.equal(ok.ok, true);
  const pub = await m.call('push:getConfig');
  assert.equal(pub.channels.length, 1);
  assert.ok(!JSON.stringify(pub).includes('ABCDEFGHIJ'));
  assert.ok(!fs.readFileSync(path.join(m.userData, 'push_config.json'), 'utf8').includes('ABCDEFGHIJ'));
  assert.equal((await m.call('push:setConfig', { channels: [] })).ok, true);
});

test('AI 解读：未配置时返回明确提示；配置校验走 IPC', async () => {
  assert.match((await m.call('llm:analyze', { symbol: 'BTCUSDT' })).error, /尚未配置/);
  assert.equal((await m.call('llm:setConfig', { baseUrl: 'http://evil.example.com/v1', model: 'x', apiKey: 'k' })).ok, false);
  const r = await m.call('llm:setConfig', { baseUrl: 'https://api.example.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-abcdefghijklmnop' });
  assert.equal(r.ok, true);
  assert.ok(!JSON.stringify(await m.call('llm:getConfig')).includes('abcdefghijklmnop'));
});

test('备份：拒绝非字符串 / 超大载荷；正常内容写入用户选择的路径；导入校验结构', async () => {
  assert.equal((await m.call('backup:export', { a: 1 }, 'x.json')).ok, false);
  saved = path.join(m.userData, 'backup.json');
  const ex = await m.call('backup:export', JSON.stringify({ kind: 'novatrade-backup', local: { k: 'v' } }), '../../evil/name.json');
  assert.equal(ex.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).local.k, 'v');
  const im = await m.call('backup:import');
  assert.equal(im.ok, true);
  assert.equal(im.data.local.k, 'v');
  fs.writeFileSync(saved, '[1,2,3]');
  assert.equal((await m.call('backup:import')).ok, false, '数组不是有效备份');
  fs.writeFileSync(saved, 'not json');
  assert.equal((await m.call('backup:import')).ok, false);
});

test('更新检查：返回新版本信息', async () => {
  const r = await m.call('update:check');
  assert.deepEqual([r.ok, r.newer, r.latest, r.current], [true, true, '1.3.0', '1.2.0']);
});

test('诊断包：导出文本中不含令牌 / 密钥', async () => {
  fs.writeFileSync(path.join(m.userData, 'error.log'), '[t] [x] POST https://api.telegram.org/bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc-123/sendMessage\n[t] [y] Bearer abcdefghijklmnop1234\n[t] [z] ok line\n');
  saved = path.join(m.userData, 'diag.txt');
  const r = await m.call('diagnostics:export');
  assert.equal(r.ok, true);
  const txt = fs.readFileSync(saved, 'utf8');
  assert.match(txt, /NovaTrade 诊断包/);
  assert.match(txt, /app: 1\.2\.0/);
  assert.match(txt, /ok line/);
  assert.ok(!txt.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ') && !txt.includes('abcdefghijklmnop1234'));
});
