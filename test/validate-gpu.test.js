'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../main/validate');
const gpu = require('../main/gpu-config');

test('symbol：只接受大写字母数字（自动转大写），拒绝注入字符', () => {
  assert.equal(V.symbol('btcusdt'), 'BTCUSDT');
  assert.equal(V.symbol('1000PEPEUSDT'), '1000PEPEUSDT');
  for (const bad of ['', null, undefined, 'A', 'BTC USDT', 'BTCUSDT&limit=1', '../x', 'BTC/USDT', 'a'.repeat(31), '中文']) assert.equal(V.symbol(bad), null, String(bad));
});

test('interval / period 白名单', () => {
  assert.equal(V.interval('1h'), '1h');
  assert.equal(V.interval('1M'), '1M');
  assert.equal(V.interval('2m'), null);
  assert.equal(V.interval('1h&x=1'), null);
  assert.equal(V.period('5m'), '5m');
  assert.equal(V.period('1m'), null);
});

test('int / timestamp / str / fileName', () => {
  assert.equal(V.int('50', 1, 100, 7), 50);
  assert.equal(V.int(1e9, 1, 100, 7), 100);
  assert.equal(V.int(-5, 1, 100, 7), 1);
  assert.equal(V.int('abc', 1, 100, 7), 7);
  assert.equal(V.timestamp(1700000000000), 1700000000000);
  assert.equal(V.timestamp(-1), null);
  assert.equal(V.timestamp(Date.now() + 10 * 86400e3), null);
  assert.equal(V.timestamp('x'), null);
  assert.equal(V.str('abcdef', 3), 'abc');
  assert.equal(V.str(null, 3), '');
  assert.equal(V.fileName('../../etc/passwd', 'd.csv'), 'passwd');
  assert.equal(V.fileName('a<b>:c|d?.csv', 'd.csv'), 'a_b__c_d_.csv');
  assert.equal(V.fileName('..', 'd.csv'), 'd.csv');
  assert.equal(V.fileName('', 'd.csv'), 'd.csv');
});

test('proxyUrl：空串合法，其余只接受 http/https/socks', () => {
  assert.equal(V.proxyUrl(''), '');
  assert.equal(V.proxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(V.proxyUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  for (const bad of ['ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 123, 'http://']) assert.equal(V.proxyUrl(bad), null, String(bad));
});

test('GPU 配置：默认开启硬件加速；显式开关或连续崩溃才降级', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-gpu-')), 'gpu_config.json');
  const cfg = gpu.read(f);
  assert.equal(gpu.shouldDisableGpu({ argv: [], env: {}, config: cfg }), false, '默认不应再强制软件渲染');
  assert.equal(gpu.shouldDisableGpu({ argv: ['--disable-gpu'], env: {}, config: cfg }), true);
  assert.equal(gpu.shouldDisableGpu({ argv: [], env: { NOVATRADE_SOFTWARE_RENDER: '1' }, config: cfg }), true);

  let r = gpu.recordGpuCrash(f);
  assert.equal(r.switched, false, '一次崩溃不足以降级');
  r = gpu.recordGpuCrash(f);
  assert.equal(r.switched, true, '连续两次后降级');
  assert.equal(gpu.shouldDisableGpu({ argv: [], env: {}, config: gpu.read(f) }), true);

  gpu.setSoftwareRendering(f, false);
  assert.deepEqual(gpu.read(f), { softwareRendering: false, gpuCrashes: 0 });
  gpu.recordGpuCrash(f);
  gpu.clearCrashes(f);
  assert.equal(gpu.read(f).gpuCrashes, 0, '正常启动后计数清零');

  fs.writeFileSync(f, 'garbage');
  assert.deepEqual(gpu.read(f), { softwareRendering: false, gpuCrashes: 0 }, '配置损坏时回到默认');
});
