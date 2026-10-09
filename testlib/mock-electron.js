'use strict';
// 主进程集成测试用：用假的 electron 模块加载真实的 main/index.js，
// 并把 https.get 换成按主机 / 路径返回预设响应的假网络。不需要 Electron，也不需要联网。
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');
const https = require('https');

const TRUSTED = { senderFrame: { url: 'file:///app/renderer/index.html' } };
const UNTRUSTED = { senderFrame: { url: 'https://evil.example/' } };

// routes: (opts) => { status, body, headers } | Error | undefined（undefined 表示 404）
function boot(routes, extra) {
  const e = extra || {};
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-main-'));
  const handlers = {}, listeners = {}, sessionCalls = [], events = {};
  const electron = {
    app: {
      commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
      on(ev, fn) { events[ev] = fn; }, quit() {}, relaunch() {}, isPackaged: false, getVersion: () => '1.2.0',
      getPath: () => userData,
      whenReady: () => new Promise(() => {})          // 不触发窗口 / 代理探测
    },
    BrowserWindow: function () {}, Tray: function () {}, Menu: { buildFromTemplate: () => ({}) },
    Notification: Object.assign(function () {}, { isSupported: () => false }),
    dialog: e.dialog || {}, screen: {},
    safeStorage: e.safeStorage || { isEncryptionAvailable: () => false },
    session: { defaultSession: { setProxy: async (c) => { sessionCalls.push(c); }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
    ipcMain: { handle: (n, f) => { handlers[n] = f; }, on: (n, f) => { listeners[n] = f; } }
  };
  const origLoad = Module._load;
  Module._load = function (req) { if (req === 'electron') return electron; return origLoad.apply(this, arguments); };

  const seen = [];
  const origGet = https.get;
  https.get = function (opts, cb) {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.destroy = () => {};
    seen.push(opts.hostname + opts.path);
    const r = routes(opts) || { status: 404, body: { code: -1, msg: 'no route' } };
    process.nextTick(() => {
      if (r instanceof Error) return req.emit('error', r);
      const res = new EventEmitter();
      res.statusCode = r.status; res.headers = r.headers || {};
      cb(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)));
        res.emit('end');
      });
    });
    return req;
  };

  require('../main/index.js');

  return {
    userData, handlers, listeners, sessionCalls, seen, events,
    call: (ch, ...args) => handlers[ch](TRUSTED, ...args),
    callUntrusted: (ch, ...args) => handlers[ch](UNTRUSTED, ...args),
    emit: (ch, ...args) => listeners[ch](TRUSTED, ...args),
    cleanup() {
      Module._load = origLoad; https.get = origGet;
      fs.rmSync(userData, { recursive: true, force: true });
    }
  };
}

module.exports = { boot };
