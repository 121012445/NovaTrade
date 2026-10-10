'use strict';
// 自动更新（electron-updater + GitHub Releases）。
//
// - 只在打包后的正式版里启用；开发模式（npm start）下不检查。
// - 启动 30 秒后检查一次，之后每 6 小时检查一次；发现新版本自动在后台下载，下载完成后提示「重启安装」，
//   用户不点也会在下次退出应用时自动安装。可在设置里关闭「自动下载」，改为只提示。
// - macOS：系统要求应用经过代码签名才能自动更新。未签名的 macOS 版本只会提示有新版本，需要手动下载。
// - 依赖 electron-updater 包；找不到时（例如没执行 npm install）退回到「只检查 GitHub 发布页」的手动方式，不影响启动。
const CHECK_DELAY_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 3600 * 1000;

function loadUpdater() {
  try { return require('electron-updater').autoUpdater; } catch (e) { return null; }
}

// deps: { app, send(channel, payload), log, fileLog, autoUpdater?（测试注入）, platform? }
function createUpdater(deps) {
  const au = deps.autoUpdater !== undefined ? deps.autoUpdater : loadUpdater();
  const platform = deps.platform || process.platform;
  const log = deps.log || function () {};
  let state = { status: 'idle', version: null, percent: 0, error: '', available: !!au };
  let autoDownload = true;
  let timer = null;

  // macOS 未签名应用无法自动安装（Squirrel.Mac 校验签名），只提示
  const canInstall = !!au && platform !== 'darwin';

  function set(patch) {
    state = Object.assign({}, state, patch);
    try { deps.send('update:status', state); } catch (e) {}
  }

  function wire() {
    if (!au) return;
    au.autoDownload = false;            // 由我们决定何时下载（尊重「自动下载」开关）
    au.autoInstallOnAppQuit = true;
    au.logger = { info: (m) => log('[updater] ' + m), warn: (m) => log('[updater] ' + m), error: (m) => log('[updater] ' + m), debug() {} };
    au.on('checking-for-update', () => set({ status: 'checking', error: '' }));
    au.on('update-not-available', () => set({ status: 'latest', error: '' }));
    au.on('update-available', (info) => {
      set({ status: 'available', version: info && info.version, error: '' });
      if (autoDownload && canInstall) download();
    });
    au.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round((p && p.percent) || 0) }));
    au.on('update-downloaded', (info) => set({ status: 'downloaded', version: info && info.version, percent: 100 }));
    au.on('error', (err) => {
      const msg = String((err && err.message) || err).slice(0, 200);
      if (deps.fileLog) deps.fileLog('updater', msg);
      set({ status: 'error', error: msg });
    });
  }

  function check() {
    if (!au || !deps.app.isPackaged) return Promise.resolve(state);
    return Promise.resolve(au.checkForUpdates()).then(() => state, (e) => { set({ status: 'error', error: String(e.message || e).slice(0, 200) }); return state; });
  }
  function download() {
    if (!au || !canInstall) return Promise.resolve(false);
    return Promise.resolve(au.downloadUpdate()).then(() => true, (e) => { set({ status: 'error', error: String(e.message || e).slice(0, 200) }); return false; });
  }
  function install() {
    if (!au || state.status !== 'downloaded') return false;
    setImmediate(() => { try { deps.app.isQuitting = true; au.quitAndInstall(false, true); } catch (e) { set({ status: 'error', error: e.message }); } });
    return true;
  }

  function start(opts) {
    autoDownload = !(opts && opts.autoDownload === false);
    wire();
    if (!au || !deps.app.isPackaged) return;
    setTimeout(check, CHECK_DELAY_MS);
    timer = setInterval(check, CHECK_EVERY_MS);
    if (timer.unref) timer.unref();
  }

  return {
    start, check, download, install,
    setAutoDownload: (on) => { autoDownload = !!on; },
    status: () => Object.assign({ canInstall, packaged: !!deps.app.isPackaged, autoDownload }, state)
  };
}

module.exports = { createUpdater };
