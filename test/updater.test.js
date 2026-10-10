'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { createUpdater } = require('../main/updater');

function fakeAU() {
  const au = new EventEmitter();
  au.calls = [];
  au.checkForUpdates = async () => { au.calls.push('check'); au.emit('checking-for-update'); };
  au.downloadUpdate = async () => { au.calls.push('download'); };
  au.quitAndInstall = (...a) => { au.calls.push('install:' + a.join(',')); };
  return au;
}
const app = (packaged) => ({ isPackaged: packaged });

test('发现新版本后自动下载；下载完成才允许安装；状态推送给界面', async () => {
  const au = fakeAU(), sent = [];
  const u = createUpdater({ app: app(true), autoUpdater: au, platform: 'win32', send: (c, p) => sent.push(p.status) });
  u.start({ autoDownload: true });
  assert.equal(au.autoDownload, false, '下载时机由包装层控制');
  assert.equal(au.autoInstallOnAppQuit, true);
  await u.check();
  au.emit('update-available', { version: '1.3.0' });
  await new Promise((r) => setImmediate(r));
  assert.ok(au.calls.includes('download'));
  assert.equal(u.install(), false, '未下载完不能安装');
  au.emit('download-progress', { percent: 42.4 });
  assert.equal(u.status().percent, 42);
  au.emit('update-downloaded', { version: '1.3.0' });
  assert.equal(u.status().status, 'downloaded');
  assert.equal(u.install(), true);
  await new Promise((r) => setImmediate(r));
  assert.ok(au.calls.some((c) => c.startsWith('install')));
  assert.deepEqual(sent.slice(0, 3), ['checking', 'available', 'downloading']);
});

test('关闭自动下载：只提示，不下载；macOS 不自动安装；开发模式不检查', async () => {
  const au = fakeAU();
  const u = createUpdater({ app: app(true), autoUpdater: au, platform: 'win32', send() {} });
  u.start({ autoDownload: false });
  au.emit('update-available', { version: '2.0.0' });
  await new Promise((r) => setImmediate(r));
  assert.ok(!au.calls.includes('download'));
  assert.equal(u.status().status, 'available');

  const mac = fakeAU();
  const m = createUpdater({ app: app(true), autoUpdater: mac, platform: 'darwin', send() {} });
  m.start({});
  mac.emit('update-available', { version: '2.0.0' });
  await new Promise((r) => setImmediate(r));
  assert.ok(!mac.calls.includes('download'));
  assert.equal(m.status().canInstall, false);

  const dev = fakeAU();
  const d = createUpdater({ app: app(false), autoUpdater: dev, platform: 'win32', send() {} });
  d.start({});
  await d.check();
  assert.deepEqual(dev.calls, []);
});

test('没有 electron-updater 时降级：available=false，所有操作都是空操作；错误会记录', async () => {
  const u = createUpdater({ app: app(true), autoUpdater: null, send() {} });
  u.start({});
  assert.equal(u.status().available, false);
  assert.equal(await u.download(), false);
  assert.equal(u.install(), false);
  const au = fakeAU(), logged = [];
  const v = createUpdater({ app: app(true), autoUpdater: au, platform: 'linux', send() {}, fileLog: (t, m) => logged.push(m) });
  v.start({});
  au.emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.equal(v.status().status, 'error');
  assert.match(logged[0], /CONNECTION_RESET/);
});
