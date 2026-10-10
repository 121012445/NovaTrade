const { app, BrowserWindow, Tray, Menu, ipcMain, screen, Notification, dialog, session, safeStorage, shell } = require('electron');
const path = require('path');

// GPU：默认启用硬件加速；只有显式要求或 GPU 进程连续崩溃时才降级为软件渲染（见 main/gpu-config.js）。
// 这些开关必须在 app ready 之前设置。userData 路径在 ready 之前即可读取。
const gpuCfg = require('./gpu-config');
let GPU_CFG_FILE = null;
try { GPU_CFG_FILE = path.join(app.getPath('userData'), 'gpu_config.json'); } catch (e) {}
const GPU_CONFIG = GPU_CFG_FILE ? gpuCfg.read(GPU_CFG_FILE) : { softwareRendering: false, gpuCrashes: 0 };
const SOFTWARE_RENDER = gpuCfg.shouldDisableGpu({ argv: process.argv, env: process.env, config: GPU_CONFIG });
if (SOFTWARE_RENDER) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('ignore-gpu-blacklist');
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
}

// Windows 系统通知需要显式的 AppUserModelId，否则通知不显示或显示成 electron.app.*
try { app.setAppUserModelId('NovaTrade'); } catch (e) {}

function log() { try { process.stdout && process.stdout.write(Array.from(arguments).join(' ') + '\n'); } catch(e) {} }
const https = require('https');
const tls = require('tls');
const fs = require('fs');

const V = require('./validate');

// 所有 IPC 入口先确认发送方是本应用加载的本地页面（file://）。
// 即使渲染进程被导航到外部页面或被注入，也调不动主进程能力。
function senderTrusted(e) {
  try {
    const u = (e.senderFrame && e.senderFrame.url) || (e.sender && e.sender.getURL && e.sender.getURL()) || '';
    return u.startsWith('file://');
  } catch (err) { return false; }
}
function ipcHandle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!senderTrusted(e)) { fileLog('ipc-denied', channel); return { __error: 'untrusted sender' }; }
    return fn(e, ...args);
  });
}
function ipcOn(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!senderTrusted(e)) { fileLog('ipc-denied', channel); return; }
    fn(e, ...args);
  });
}

const APP_ROOT = path.join(__dirname, '..');
const RENDERER_PATH = path.join(APP_ROOT, 'renderer', 'index.html');
const WIDGET_PATH = path.join(APP_ROOT, 'renderer', 'widget.html');
const ICON_PATH = path.join(APP_ROOT, 'assets', 'tray.png');
const PRELOAD_PATH = path.join(__dirname, 'preload.js');
// 开发者工具：打包后的正式版默认关闭，需要时用 --devtools 或环境变量 NOVATRADE_DEVTOOLS=1 打开
const DEVTOOLS_ENABLED = !app.isPackaged || process.argv.includes('--devtools') || process.env.NOVATRADE_DEVTOOLS === '1';
const APP_FILE_URL = require('url').pathToFileURL(path.join(APP_ROOT, 'renderer')).href;

// 页面加固：不允许新开窗口、不允许导航到应用目录之外、不允许 <webview>
function hardenWebContents(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(APP_FILE_URL)) { e.preventDefault(); fileLog('nav-blocked', url); } });
  wc.on('will-attach-webview', (e) => e.preventDefault());
}
const API_HOST = 'data-api.binance.vision';
const FUTURES_API_HOST = 'fapi.binance.com';

// ===== 代理配置：持久化 + 启动自动探测（此前为硬编码，代理未开时应用静默失效）=====
const DEFAULT_PROXY_CANDIDATES = [
  'http://127.0.0.1:7897',   // Clash Verge Rev 默认
  'http://127.0.0.1:7890',   // Clash / Clash for Windows
  'http://127.0.0.1:10809',  // V2Ray / Xray HTTP
  'http://127.0.0.1:10808',  // V2Ray SOCKS(常同时开 HTTP)
  'http://127.0.0.1:8080',
  'http://127.0.0.1:1087',   // Surge
  'http://127.0.0.1:8889',   // ClashX
  'http://127.0.0.1:33210'   // 部分客户端随机端口
];
let spotProxy = '';      // 空字符串 = 直连
let futuresProxy = '';
let proxyConfigPath = null;
let proxyStatus = { mode: 'unknown', proxy: '', checkedAt: 0, error: '' };

function configFile() {
  if (!proxyConfigPath) {
    try { proxyConfigPath = path.join(app.getPath('userData'), 'proxy_config.json'); }
    catch (e) { proxyConfigPath = path.join(APP_ROOT, 'proxy_config.json'); }
  }
  return proxyConfigPath;
}

function loadProxyConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (cfg && typeof cfg === 'object') {
      if (typeof cfg.spotProxy === 'string') spotProxy = cfg.spotProxy;
      if (typeof cfg.futuresProxy === 'string') futuresProxy = cfg.futuresProxy;
      if (spotProxy || futuresProxy) {
        log('[main] proxy config loaded:', spotProxy || futuresProxy);
        return true;
      }
    }
  } catch (e) { /* 无配置文件时走自动探测 */ }
  return false;
}

function saveProxyConfig() {
  try {
    fs.writeFileSync(configFile(), JSON.stringify({
      spotProxy, futuresProxy, savedAt: new Date().toISOString()
    }, null, 2));
    return true;
  } catch (e) { fileLog('proxy-save', e.message); return false; }
}

// 探测某个代理端口是否可用（用 http/bare CONNECT 之外的简单 GET 判断连通性）
function probeProxy(proxyUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(proxyUrl); } catch (e) { return resolve(false); }
    const req = require('http').get({
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 80,
      path: proxyUrl,                      // 请求代理自身地址，能连上即认为端口在监听
      method: 'GET',
      timeout: 1200
    }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 依次探测候选端口，返回第一个可用的
async function detectProxy() {
  for (const cand of DEFAULT_PROXY_CANDIDATES) {
    if (await probeProxy(cand)) {
      log('[main] proxy auto-detected:', cand);
      return cand;
    }
  }
  return '';
}

// 通过代理访问币安，确认代理真的能通外网（比端口探测更可靠）
function verifyProxy(proxyUrl) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(proxyUrl); } catch (e) { return resolve(false); }
    const host = 'fapi.binance.com';
    const req = require('http').get({
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 80,
      path: 'https://' + host + '/fapi/v1/ping',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Host': host },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 把当前代理同步给 Chromium 会话。
// 主进程的 REST 请求走自己的 CONNECT 隧道，但渲染进程里的 WebSocket（强平流）走 Chromium 网络栈，
// 不会用到上面探测 / 配置的代理 —— 直连不通币安时连接必然失败。这里让两条链路用同一个代理。
// 未配置代理时保持 Chromium 默认的系统代理行为。
function proxyRulesFor(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    let scheme = u.protocol.replace(':', '');
    if (scheme === 'socks') scheme = 'socks5';
    if (!['http', 'https', 'socks4', 'socks5'].includes(scheme)) return null;
    return scheme + '://' + u.host;
  } catch (e) { return null; }
}
async function applySessionProxy() {
  try {
    const rules = proxyRulesFor(futuresProxy || spotProxy);
    if (rules) await session.defaultSession.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
    else await session.defaultSession.setProxy({ mode: 'system' });
    log('[main] session proxy:', rules || 'system');
  } catch (e) { fileLog('session-proxy', e.message); }
}

// 启动时初始化代理：优先用已保存配置，否则自动探测，最后校验是否真能通外网
async function initProxy() {
  const hadConfig = loadProxyConfig();
  if (!hadConfig) {
    const detected = await detectProxy();
    spotProxy = detected;
    futuresProxy = detected;
  }
  // 校验可用性（直连模式也校验一次，判断是否需要提醒用户开代理）
  const candidate = spotProxy || futuresProxy;
  let ok = false;
  if (candidate) {
    ok = await verifyProxy(candidate);
  } else {
    // 直连：试试不走代理能否直接访问
    ok = await new Promise((resolve) => {
      const req = https.get({ hostname: FUTURES_API_HOST, port: 443, path: '/fapi/v1/ping', timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => { res.resume(); resolve(res.statusCode < 500); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }
  proxyStatus = {
    mode: candidate ? 'proxy' : 'direct',
    proxy: candidate,
    checkedAt: Date.now(),
    error: ok ? '' : (candidate ? '代理无法访问币安，请检查代理是否开启' : '直连无法访问币安，请开启代理或在设置中配置')
  };
  log('[main] proxy init:', proxyStatus.mode, candidate || '(direct)', ok ? 'OK' : 'FAIL');
  fileLog('proxy-init', JSON.stringify(proxyStatus));
  // 自动探测成功时也持久化，下次启动直接复用（避免每次都探测）
  if (!hadConfig && candidate && ok) saveProxyConfig();
  return proxyStatus;
}

// ===== 文件日志（userData/error.log）：异常不再被静默吞掉 =====
const LOG_MAX_BYTES = 2 * 1024 * 1024; // 超过 2MB 自动轮转
let LOG_FILE = null;
function ensureLogFile() {
  if (LOG_FILE) return LOG_FILE;
  try {
    LOG_FILE = path.join(app.getPath('userData'), 'error.log');
  } catch (e) { LOG_FILE = path.join(APP_ROOT, 'error.log'); }
  return LOG_FILE;
}
function fileLog(tag, msg) {
  try {
    const f = ensureLogFile();
    try { if (fs.statSync(f).size > LOG_MAX_BYTES) fs.renameSync(f, f + '.1'); } catch (e) {}
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] [' + tag + '] ' + msg + '\n');
  } catch (e) { /* 日志自身失败时不再递归 */ }
}

// ===== 1009 性能优化：HTTPS keep-alive 连接池 =====
// 裸 https.get 经 HTTP 代理时每个请求都完整 TCP+TLS 握手（经本地代理单次约 0.3-0.8s），
// AI 推荐一次加载 40+ 请求，重复握手是首屏延迟的最大头。自定义 createConnection：
// 先向本地代理发 CONNECT 建隧道，再在隧道上做 TLS 握手；keepAlive 令后续请求复用已建连接。
const __agentCache = new Map(); // key -> agent（proxy 变更时 key 变化自动新建，旧连接空闲后自行回收）
function proxyTunnelAgent(proxyUrlStr, maxSockets) {
  const key = 'tunnel|' + proxyUrlStr + '|' + (maxSockets || 24);
  if (__agentCache.has(key)) return __agentCache.get(key);
  const proxyUrl = new URL(proxyUrlStr);
  const proto = proxyUrl.protocol === 'https:' ? https : require('http');
  const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: maxSockets || 24, maxFreeSockets: 8 });
  agent.createConnection = function (options, cb) {
    const host = options.host, port = options.port || 443;
    const creq = proto.request({
      hostname: proxyUrl.hostname, port: parseInt(proxyUrl.port) || 80,
      method: 'CONNECT', path: host + ':' + port,
      headers: { Host: host + ':' + port, 'User-Agent': 'Mozilla/5.0' }
    });
    creq.setTimeout(10000, () => { creq.destroy(new Error('Proxy CONNECT timeout')); });
    creq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); cb(new Error('Proxy CONNECT failed: ' + res.statusCode)); return; }
      socket.setTimeout(0);
      cb(null, tls.connect({ socket: socket, servername: host }));
    });
    creq.on('error', (e) => cb(e));
    creq.end();
  };
  __agentCache.set(key, agent);
  return agent;
}
function directKeepAliveAgent(maxSockets) {
  const key = 'direct|' + (maxSockets || 24);
  if (__agentCache.has(key)) return __agentCache.get(key);
  const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: maxSockets || 24, maxFreeSockets: 8 });
  __agentCache.set(key, agent);
  return agent;
}

// ===== 统一 REST 请求层（main/binance-http.js）=====
// 检查 HTTP 状态码（429/418 限流退避、4xx 业务错误直接抛出、5xx/网络错误换主机重试）、
// 同类接口并发上限、相同请求在途去重。所有币安 / 第三方 JSON 请求都走这里。
const { createBinanceHttp } = require('./binance-http');
const binanceHttp = createBinanceHttp({ log });

const SPOT_HOSTS = [API_HOST, 'api.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com'];
// 代理模式下 api.binance.com 系列更稳；直连（尤其国内）时 data-api.binance.vision 优先，避免先吃一次超时
const SPOT_KLINE_HOSTS_PROXY = ['api.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com', API_HOST];
const FUTURES_HOSTS = [FUTURES_API_HOST, 'fapi1.binance.com', 'fapi2.binance.com', 'fapi3.binance.com'];

function agentFor(proxy, maxSockets) {
  return proxy ? proxyTunnelAgent(proxy, maxSockets || 24) : directKeepAliveAgent(maxSockets || 24);
}

function binanceRequest(urlPath) {
  return binanceHttp.requestJson({
    family: 'spot', hosts: SPOT_HOSTS, path: urlPath,
    agent: agentFor(spotProxy), proxyKey: spotProxy || 'direct', timeoutMs: 10000
  });
}

function binanceKlinesRequest(urlPath) {
  return binanceHttp.requestJson({
    family: 'spot', hosts: spotProxy ? SPOT_KLINE_HOSTS_PROXY : SPOT_HOSTS, path: urlPath,
    agent: agentFor(spotProxy), proxyKey: spotProxy || 'direct', timeoutMs: 10000
  });
}

function binanceFuturesRequest(urlPath) {
  return binanceHttp.requestJson({
    family: 'futures', hosts: FUTURES_HOSTS, path: urlPath,
    agent: agentFor(futuresProxy), proxyKey: futuresProxy || 'direct', timeoutMs: 10000
  });
}

process.on('uncaughtException', (err) => {
  fileLog('uncaughtException', (err && err.stack) || String(err));
  log('[main] uncaughtException:', (err && err.message) || err);
});
process.on('unhandledRejection', (reason) => {
  fileLog('unhandledRejection', (reason && reason.stack) || String(reason));
  log('[main] unhandledRejection:', (reason && reason.message) || reason);
});
let mainWindow = null, tray = null, widgetWindow = null, lastWidgetData = null;

function createWindow() {
  const displays = screen.getAllDisplays();
  const display = displays[0];
  mainWindow = new BrowserWindow({
    width: 1400, height: 1000, minWidth: 900, minHeight: 600,
    x: display.bounds.x + 100, y: display.bounds.y + 100,
    frame: false, backgroundColor: '#0a0a0f', show: true,
    // backgroundThrottling:false —— 窗口隐藏到托盘后，渲染进程里的轮询与价格预警仍按原频率运行
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: PRELOAD_PATH, devTools: DEVTOOLS_ENABLED, backgroundThrottling: false }
  });
  hardenWebContents(mainWindow.webContents);
  log('[main] Window created');
  mainWindow.loadFile(RENDERER_PATH);
  // Create menu with DevTools option
  const menu = Menu.buildFromTemplate([
    { label: "查看", submenu: [
      ...(DEVTOOLS_ENABLED ? [{ label: "开发者工具", accelerator: "Ctrl+Shift+I", click: () => { mainWindow.webContents.openDevTools(); } }, { type: "separator" }] : []),
      { label: "使用软件渲染（重启生效）", type: "checkbox", checked: SOFTWARE_RENDER,
        click: (item) => { if (GPU_CFG_FILE) { gpuCfg.setSoftwareRendering(GPU_CFG_FILE, item.checked); app.isQuitting = true; app.relaunch(); app.quit(); } } },
      { type: "separator" },
      { label: "刷新", accelerator: "F5", click: () => { mainWindow.reload(); } },
      { label: "强制刷新", accelerator: "Ctrl+Shift+R", click: () => { mainWindow.webContents.reloadIgnoringCache(); } }
    ]}
  ]);
  mainWindow.setMenu(menu);
  mainWindow.webContents.on('did-finish-load', () => { log('[main] Page loaded'); fileLog('info', 'main window loaded'); });
  mainWindow.webContents.on('did-fail-load', (e, code, desc) => { log('[main] Load failed:', code, desc); fileLog('did-fail-load', 'code=' + code + ' desc=' + desc); });
  mainWindow.webContents.on('render-process-gone', (e, details) => { fileLog('render-gone', JSON.stringify(details)); });
  mainWindow.webContents.on('console-message', (e, level, msg) => {
    log('[main] Renderer:', msg.substring(0, 80));
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) fileLog('renderer-' + (level === 3 ? 'error' : 'warn'), msg);
  });
  // 【托盘修复配套】点关闭 = 隐藏到托盘，不真正销毁窗口。
  // 否则窗口销毁后托盘左键无从唤起（原代码把 mainWindow 置 null，托盘就"死"了）。
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;      // 托盘菜单"退出"走真关闭
    e.preventDefault();
    mainWindow.hide();
    log('[main] Window hidden to tray');
  });
  mainWindow.on('closed', () => { log('[main] Window closed'); });
}

function createWidget() {
  if (widgetWindow) { widgetWindow.show(); return; }
  const displays = screen.getAllDisplays();
  const primary = displays[0];
  widgetWindow = new BrowserWindow({
    width: 320, height: 200,
    x: primary.bounds.x + primary.bounds.width - 340, y: primary.bounds.y + 20,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: PRELOAD_PATH, devTools: DEVTOOLS_ENABLED, backgroundThrottling: false }
  });
  hardenWebContents(widgetWindow.webContents);
  widgetWindow.loadFile(WIDGET_PATH);
  widgetWindow.webContents.on('console-message', (e, level, msg) => { log('[widget]', msg); });
  widgetWindow.webContents.on('did-finish-load', () => {
    if (lastWidgetData) {
      widgetWindow.webContents.send('widget:data', lastWidgetData);
      log('[main] Sent cached data to new widget');
    }
    if (mainWindow) mainWindow.webContents.send('widget:created');
  });
  widgetWindow.setAlwaysOnTop(true);
  widgetWindow.setVisibleOnAllWorkspaces(true);
  widgetWindow.on('close', () => { widgetWindow = null; });
  log('[main] Widget created');
}

// 唤起主窗口的统一入口（托盘左键 / 双击 / 菜单项共用），三类边界都处理
function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  try {
    if (mainWindow.isDestroyed()) { mainWindow = null; createWindow(); return; }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === 'win32') mainWindow.setAlwaysOnTop(true), mainWindow.setAlwaysOnTop(false);
  } catch (e) {
    fileLog('tray-show-main', e.message);
  }
}

function createTray() {
  // 图标加载失败此前会静默创建空托盘（有图标占位但点不出菜单），改为捕获并落盘
  try {
    tray = new Tray(ICON_PATH);
  } catch (e) {
    fileLog('tray-create-fail', e.message + ' | icon=' + ICON_PATH);
    return;
  }
  tray.setToolTip('NovaTrade - 单击显示主窗口');
  tray.setIgnoreDoubleClickEvents(false);

  // 【本次修复核心】此前缺 click 绑定，Windows 上左键单击完全无响应 —— 这就是"点不动"
  tray.on('click', () => { showMainWindow(); });
  tray.on('double-click', () => { showMainWindow(); });
  tray.on('right-click', () => {
    try { tray.popUpContextMenu(); } catch (e) { fileLog('tray-popup', e.message); }
  });

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showMainWindow() },
    { label: '显示组件', click: () => createWidget() },
    { type: 'separator' },
    { label: '退出', click: () => { try { app.isQuitting = true; } catch (e) {} app.quit(); } }
  ]));
}

ipcOn('window:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcOn('window:maximize', () => { if (mainWindow) { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); } });
ipcOn('window:close', () => { if (mainWindow) mainWindow.close(); });
ipcOn('window:show', () => { showMainWindow(); });
// ===== 托盘状态：把当前关注币的涨跌写进托盘 tooltip（纯只读展示）=====
ipcHandle('tray:status', (e, text) => {
  try {
    if (!tray) return false;
    tray.setToolTip(V.str(text || 'NovaTrade - 单击显示主窗口', 200));
    return true;
  } catch (err) { return false; }
});
ipcHandle('widget:create', () => { createWidget(); return true; });
ipcOn('devtools:open', () => {
  if (DEVTOOLS_ENABLED && mainWindow) mainWindow.webContents.openDevTools();
});
ipcOn('widget:update', (e, data) => {
  // 小组件数据必须是不太大的普通对象
  if (!data || typeof data !== 'object') return;
  try { if (JSON.stringify(data).length > 200000) return; } catch (err) { return; }
  lastWidgetData = data;
  if (widgetWindow) widgetWindow.webContents.send('widget:data', data);
});
ipcOn('renderer:refresh', () => { if (mainWindow) mainWindow.webContents.reload(); });

// ===== 悬浮窗控制（preload 已暴露，此前主进程缺失导致按钮无效）=====
ipcOn('widget:close', () => {
  if (widgetWindow) { widgetWindow.close(); }
});
// 注意：preload 传入的是内容尺寸（240x320 / 260x520），需换算为窗口尺寸（含 .wb 的 8px 外边距 + 头部）
ipcOn('widget:resize', (e, w, h) => {
  if (!widgetWindow) return;
  const width = V.int((Number(w) || 240) + 16, 200, 1200, 256);
  const height = V.int((Number(h) || 320) + 16, 120, 1600, 336);
  widgetWindow.setContentSize(width, height);
  log('[main] widget resized to', width + 'x' + height);
});
ipcOn('widget:alwaysOnTop', (e, enabled) => {
  if (!widgetWindow) return;
  widgetWindow.setAlwaysOnTop(!!enabled);
  if (enabled) widgetWindow.setVisibleOnAllWorkspaces(true);
  log('[main] widget alwaysOnTop =', !!enabled);
});
// 渲染层通用消息通道（此前无接收方，仅落日志便于排查）
ipcOn('renderer-msg', (e, msg) => { log('[main] renderer-msg:', V.str(msg, 500)); });

ipcHandle('futures:setProxy', async (e, proxy) => {
  // 渲染层传来的值不可信：只接受空字符串（直连）或 http/https/socks 代理地址
  if (V.proxyUrl(proxy) === null) return false;
  futuresProxy = proxy || '';
  log('[main] futures proxy set:', proxy || 'none');
  saveProxyConfig();
  await applySessionProxy();
  return true;
});
ipcHandle('futures:getProxy', () => futuresProxy);
ipcHandle('spot:setProxy', async (e, proxy) => {
  // 渲染层传来的值不可信：只接受空字符串（直连）或 http/https/socks 代理地址
  if (V.proxyUrl(proxy) === null) return false;
  spotProxy = proxy || '';
  log('[main] spot proxy set:', proxy || 'none');
  saveProxyConfig();
  await applySessionProxy();
  return true;
});
ipcHandle('spot:getProxy', () => spotProxy);
// 代理状态查询 / 重新检测（供渲染层显示提示与手动重试）
ipcHandle('proxy:getStatus', () => proxyStatus);
ipcHandle('proxy:redetect', async () => {
  const detected = await detectProxy();
  spotProxy = detected || '';
  futuresProxy = detected || '';
  const ok = detected ? await verifyProxy(detected) : false;
  proxyStatus = {
    mode: detected ? 'proxy' : 'direct', proxy: detected || '', checkedAt: Date.now(),
    error: ok ? '' : (detected ? '检测到的代理无法访问币安' : '未检测到可用代理，请手动配置')
  };
  saveProxyConfig();
  await applySessionProxy();
  log('[main] proxy redetect:', proxyStatus.mode, detected || '(direct)', ok ? 'OK' : 'FAIL');
  return proxyStatus;
});
ipcHandle('proxy:verify', async () => {
  const candidate = spotProxy || futuresProxy;
  const ok = candidate ? await verifyProxy(candidate) : false;
  proxyStatus = { ...proxyStatus, checkedAt: Date.now(), error: ok ? '' : (candidate ? '代理无法访问币安，请检查代理是否开启' : '直连无法访问币安，请开启代理或在设置中配置') };
  return { ok, status: proxyStatus };
});
const bad = (what, extra) => Object.assign({ __error: 'invalid ' + what }, extra || {});
// 统一的"出错返回 { __error }"包装，渲染层按 __error 字段判断失败
function safe(tag, fn, extra) {
  return async (e, ...args) => {
    try { return await fn(...args); }
    catch (err) { log('[main] ' + tag + ' error:', err.message); return Object.assign({ __error: err.message }, extra || {}); }
  };
}
// ===== 数据源：币安为主，OKX 现货公开行情为备用 =====
// 只有「币安整体不可用」（网络 / 5xx / 限流）才会切到备用源；币安明确拒绝的请求（如非法交易对）不会切换。
// 备用源只覆盖现货 USDT 对（见 main/okx.js），切换后用 data:source 告诉界面「当前数据来自备用源」。
const { createOkx } = require('./okx');
const okx = createOkx((host, urlPath) => binanceHttp.requestJson({
  family: 'okx', hosts: [host], path: urlPath, agent: agentFor(spotProxy), proxyKey: spotProxy || 'direct', timeoutMs: 10000
}));
let dataSource = { name: 'binance', at: 0 };
function noteSource(name) { dataSource = { name, at: Date.now() }; }
const isDefinitive = (e) => !!(e && e.kind === 'client');

async function spotTickers() {
  try { const r = await binanceRequest('/api/v3/ticker/24hr'); noteSource('binance'); return r; }
  catch (e) {
    if (isDefinitive(e)) throw e;
    try { const r = await okx.tickers(); noteSource('okx'); log('[main] tickers: fell back to OKX (' + e.message + ')'); return r; }
    catch (e2) { throw e; }
  }
}
// 一页 K 线：合约优先，合约不可用时回退现货（现货单次上限 1000，合约 1500）；两者都不可用时再试 OKX（仅最近 300 根）
async function fetchKlinesPage(sym, iv, lim, startMs) {
  const st = startMs ? '&startTime=' + startMs : '';
  try { const r = await binanceFuturesRequest('/fapi/v1/klines?symbol=' + sym + '&interval=' + iv + '&limit=' + lim + st); noteSource('binance'); return r; }
  catch (err) {
    log('[main] klines futures fail, try spot:', err.message);
    try { const r = await binanceKlinesRequest('/api/v3/klines?symbol=' + sym + '&interval=' + iv + '&limit=' + Math.min(lim, 1000) + st); noteSource('binance'); return r; }
    catch (err2) {
      log('[main] klines spot fail:', err2.message);
      if (isDefinitive(err2) || startMs) throw err2;          // 带起点的历史分页不走备用源（OKX 备用只有最近 300 根）
      try { const r = await okx.klines(sym, iv, lim); noteSource('okx'); return r; }
      catch (err3) { throw err2; }
    }
  }
}
ipcHandle('data:source', () => dataSource);
ipcHandle('binance:getTickers', safe('getTickers', () => spotTickers()));
ipcHandle('binance:getFuturesTickers', safe('getFuturesTickers', () => binanceFuturesRequest('/fapi/v1/ticker/24hr')));
ipcHandle('binance:getFuturesPrice', safe('getFuturesPrice', async (symRaw) => {
  const sym = V.symbol(symRaw); if (!sym) return bad('symbol', { price: '0' });
  return binanceFuturesRequest('/fapi/v1/ticker/price?symbol=' + sym);
}, { price: '0' }));
ipcHandle('binance:getFuturesKlines', safe('getFuturesKlines', async (symRaw, ivRaw, limit) => {
  const sym = V.symbol(symRaw), iv = V.interval(ivRaw);
  if (!sym) return bad('symbol'); if (!iv) return bad('interval');
  return binanceFuturesRequest('/fapi/v1/klines?symbol=' + sym + '&interval=' + iv + '&limit=' + V.int(limit, 1, 1500, 100));
}));
ipcHandle('binance:getFuturesSymbols', safe('getFuturesSymbols', () => binanceFuturesRequest('/fapi/v1/exchangeInfo'), { symbols: [] }));
ipcHandle('binance:getPrice', safe('getPrice', async (symRaw) => {
  const sym = V.symbol(symRaw); if (!sym) return bad('symbol', { price: '0' });
  return binanceRequest('/api/v3/ticker/price?symbol=' + sym);
}, { price: '0' }));
ipcHandle('binance:get24hrTicker', safe('get24hrTicker', async (symRaw) => {
  const sym = V.symbol(symRaw); if (!sym) return bad('symbol');
  return binanceRequest('/api/v3/ticker/24hr?symbol=' + sym);
}));
ipcHandle('binance:getExchangeInfo', safe('getExchangeInfo', () => binanceRequest('/api/v3/exchangeInfo'), { symbols: [] }));
ipcHandle('binance:getKlines', async (e, symRaw, ivRaw, limitRaw, startRaw) => {
  const sym = V.symbol(symRaw), iv = V.interval(ivRaw);
  if (!sym) return bad('symbol'); if (!iv) return bad('interval');
  try { return await fetchKlinesPage(sym, iv, V.int(limitRaw, 1, 1500, 100), V.timestamp(startRaw)); }
  catch (err) { return { __error: err.message }; }
});

// ===== 本地历史 K 线库（长周期回测用，见 main/kline-store.js）=====
const { createKlineStore } = require('./kline-store');
let klineStore = null;
function getKlineStore() {
  if (!klineStore) {
    klineStore = createKlineStore({
      dir: path.join(app.getPath('userData'), 'klines'), pageSize: 1000, log,
      fetchPage: (sym, iv, start, limit) => fetchKlinesPage(sym, iv, limit, start)
    });
  }
  return klineStore;
}
ipcHandle('history:get', async (e, symRaw, ivRaw, barsRaw) => {
  const sym = V.symbol(symRaw), iv = V.interval(ivRaw);
  if (!sym) return bad('symbol'); if (!iv) return bad('interval');
  try { return (await getKlineStore().get(sym, iv, V.int(barsRaw, 100, 200000, 2000))).rows; }
  catch (err) { log('[main] history error:', err.message); return { __error: err.message }; }
});

// ===== 信号前向验证：记录持久化（userData/forward_validation.json）=====
function fwdFile() { return path.join(app.getPath('userData'), 'forward_validation.json'); }
const FWD_MAX_RECORDS = 50000;
function readFwdFile(f) {
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!Array.isArray(arr)) throw new Error('not an array');
  return arr;
}
ipcHandle('fwd:load', () => {
  const f = fwdFile();
  if (!fs.existsSync(f)) return [];
  try { return readFwdFile(f); }
  catch (err) {
    // 文件损坏：先把坏文件改名留证（避免后续保存把它覆盖成空数组，造成静默丢数据），再尝试读备份
    fileLog('fwd-load', 'corrupt forward_validation.json: ' + err.message);
    try { fs.renameSync(f, f + '.corrupt-' + Date.now()); } catch (e) {}
    try { const bak = readFwdFile(f + '.bak'); fileLog('fwd-load', 'recovered from .bak, records=' + bak.length); return bak; }
    catch (e) { return []; }
  }
});
// 写入串行化 + 原子替换：先写临时文件，再 rename 覆盖，崩溃 / 断电时不会留下写了一半的 JSON
let fwdWriteChain = Promise.resolve();
function fwdWriteAtomic(json) {
  const f = fwdFile(), tmp = f + '.tmp';
  return fs.promises.writeFile(tmp, json, 'utf8')
    .then(() => fs.promises.copyFile(f, f + '.bak').catch(() => {}))   // 首次保存没有旧文件，忽略
    .then(() => fs.promises.rename(tmp, f));
}
ipcHandle('fwd:save', (e, data) => {
  // 渲染层传来的数据不可信：必须是不太大的对象数组
  if (!Array.isArray(data) || data.length > FWD_MAX_RECORDS || !data.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    fileLog('fwd-save', 'rejected invalid payload');
    return false;
  }
  let json;
  try { json = JSON.stringify(data); } catch (err) { fileLog('fwd-save', 'stringify: ' + err.message); return false; }
  const run = () => fwdWriteAtomic(json).then(() => true, (err) => { log('[main] fwd save error:', err.message); fileLog('fwd-save', err.message); return false; });
  fwdWriteChain = fwdWriteChain.then(run, run);
  return fwdWriteChain;
});

// ===== 衍生品资金面：一次取齐 5 组数据（纯只读，不参与任何评分/下单）=====
// 全部走 binanceFuturesRequest，自动复用代理与多主机回退。
// 单个端点失败不影响其余（返回 __error 字段，由渲染层按字段判断缺失）。
async function derivOne(urlPath) {
  try { const r = await binanceFuturesRequest(urlPath); if (r && r.__error) return { __error: r.__error }; return r; }
  catch (e) { return { __error: e.message }; }
}
ipcHandle('deriv:snapshot', async (e, symRaw, periodRaw, limit) => {
  const sym = V.symbol(symRaw);
  if (!sym) return bad('symbol');
  const p = V.period(periodRaw) || '1h';
  const n = V.int(limit, 2, 500, 24);
  const q = 'symbol=' + sym + '&period=' + p + '&limit=' + n;
  const [premium, oi, lsAccount, lsTop, taker] = await Promise.all([
    derivOne('/fapi/v1/premiumIndex?symbol=' + sym),
    derivOne('/futures/data/openInterestHist?' + q),
    derivOne('/futures/data/globalLongShortAccountRatio?' + q),
    derivOne('/futures/data/topLongShortPositionRatio?' + q),
    derivOne('/futures/data/takerlongshortRatio?' + q)
  ]);
  return { symbol: sym, period: p, fetchedAt: Date.now(), premium, oi, lsAccount, lsTop, taker };
});

// ===== 市场雷达：全市场资金费率（一次请求取齐）+ 单币轻量衍生品数据（持仓量 24h、账户多空比）=====
ipcHandle('binance:premiumAll', safe('premiumAll', () => binanceFuturesRequest('/fapi/v1/premiumIndex')));
ipcHandle('deriv:lite', async (e, symRaw) => {
  const sym = V.symbol(symRaw);
  if (!sym) return bad('symbol');
  const q = 'symbol=' + sym + '&period=1h&limit=25';
  const [oi, ls] = await Promise.all([
    derivOne('/futures/data/openInterestHist?' + q),
    derivOne('/futures/data/globalLongShortAccountRatio?symbol=' + sym + '&period=1h&limit=1')
  ]);
  return { symbol: sym, oi, ls };
});

// ===== 2026-10-09 第十批：新数据源 =====
// 【硬边界】本批全部为**只读**数据通道，不包含任何下单 / 撤单 / 资金划转能力。
// 应用定位始终是"分析辅助工具"，不参与实盘交易。
// 通用 JSON 请求：给币安以外的第三方源用，同样复用已探测到的代理
function genericJsonRequest(host, urlPath, proxyUrl, timeoutMs) {
  return binanceHttp.requestJson({
    family: 'generic:' + host, hosts: [host], path: urlPath,
    agent: agentFor(proxyUrl, 6), proxyKey: proxyUrl || 'direct', timeoutMs: timeoutMs || 10000
  });
}
// ① 恐惧贪婪指数（alternative.me，免费无 key，与币安评分体系完全独立）
ipcHandle('alt:fng', async (e, limit) => {
  const n = V.int(limit, 1, 200, 30);
  try { return await genericJsonRequest('api.alternative.me', '/fng/?limit=' + n, futuresProxy || spotProxy, 10000); }
  catch (err) { log('[main] fng error:', err.message); return { __error: err.message }; }
});
// ② 订单簿深度（只读盘口快照，用于观察买卖墙；不提供任何下单入口）
// 币安 depth 只接受固定档位的 limit，其余值会被拒绝
const DEPTH_LIMITS = [5, 10, 20, 50, 100, 500, 1000];
ipcHandle('binance:futuresDepth', async (e, symRaw, limit) => {
  const sym = V.symbol(symRaw);
  if (!sym) return bad('symbol');
  const want = V.int(limit, 5, 1000, 500);
  const n = DEPTH_LIMITS.find((x) => x >= want) || 1000;
  try { return await binanceFuturesRequest('/fapi/v1/depth?symbol=' + sym + '&limit=' + n); }
  catch (err) { log('[main] depth error:', err.message); return { __error: err.message }; }
});
// ③ 逐笔聚合成交（用于筛大额单；只读）
ipcHandle('binance:aggTrades', async (e, symRaw, limit) => {
  const sym = V.symbol(symRaw);
  if (!sym) return bad('symbol');
  const n = V.int(limit, 10, 1000, 500);
  try { return await binanceFuturesRequest('/fapi/v1/aggTrades?symbol=' + sym + '&limit=' + n); }
  catch (err) { log('[main] aggTrades error:', err.message); return { __error: err.message }; }
});

// ===== 系统通知（价格提醒 / 模拟跟踪触发时，窗口可能在托盘里）=====
ipcHandle('notify:show', (e, payload) => {
  try {
    if (!Notification.isSupported()) return false;
    const o = (payload && typeof payload === 'object') ? payload : {};
    const n = new Notification({
      title: V.str(o.title || 'NovaTrade', 100),
      body: V.str(o.body, 500),
      silent: !!o.silent,
      urgency: ['low', 'normal', 'critical'].includes(o.urgency) ? o.urgency : 'normal'
    });
    // 点通知 → 把主窗口唤到前台
    n.on('click', () => { try { showMainWindow(); } catch (err) {} });
    n.show();
    return true;
  } catch (err) { log('[main] notify error:', err.message); return false; }
});

// ===== 导出：CSV / PNG（弹系统保存对话框，由用户选路径）=====
const SAVE_KINDS = {
  csv: { title: '导出 CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] },
  png: { title: '导出图片', filters: [{ name: 'PNG 图片', extensions: ['png'] }] },
  json: { title: '导出备份', filters: [{ name: 'JSON', extensions: ['json'] }] },
  txt: { title: '导出诊断包', filters: [{ name: '文本', extensions: ['txt'] }] }
};
function saveWithDialog(kind, defaultName, dataOrBase64) {
  return new Promise((resolve) => {
    try {
      const k = SAVE_KINDS[kind];
      if (!k) return resolve({ ok: false, error: 'unsupported kind' });
      const target = dialog.showSaveDialog(mainWindow || undefined, { title: k.title, defaultPath: defaultName, filters: k.filters });
      Promise.resolve(target).then((res) => {
        if (!res || res.canceled || !res.filePath) return resolve({ ok: false, canceled: true });
        try {
          if (kind === 'csv') fs.writeFileSync(res.filePath, '\ufeff' + String(dataOrBase64), 'utf8');   // 加 BOM，否则 Excel 打开中文会乱码
          else if (kind === 'png') fs.writeFileSync(res.filePath, Buffer.from(String(dataOrBase64).replace(/^data:image\/png;base64,/, ''), 'base64'));
          else fs.writeFileSync(res.filePath, String(dataOrBase64), 'utf8');
          log('[main] exported ->', res.filePath);
          resolve({ ok: true, path: res.filePath });
        } catch (err) { log('[main] export write error:', err.message); resolve({ ok: false, error: err.message }); }
      }).catch((err) => resolve({ ok: false, error: err.message }));
    } catch (err) { resolve({ ok: false, error: err.message }); }
  });
}
const EXPORT_MAX_CHARS = 60 * 1024 * 1024;
ipcHandle('file:exportCsv', (e, defaultName, text) => {
  if (typeof text !== 'string' || text.length > EXPORT_MAX_CHARS) return { ok: false, error: 'invalid or too large payload' };
  return saveWithDialog('csv', V.fileName(defaultName, 'novatrade.csv'), text);
});
ipcHandle('file:exportPng', (e, defaultName, dataUrl) => {
  if (typeof dataUrl !== 'string' || dataUrl.length > EXPORT_MAX_CHARS || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return { ok: false, error: 'invalid or too large payload' };
  return saveWithDialog('png', V.fileName(defaultName, 'novatrade.png'), dataUrl);
});

// ===== 远程推送 / AI 解读 / 备份 / 诊断 / 更新检查 =====
// 这些功能的凭据（推送令牌、API Key）都用 safeStorage 加密落盘；渲染进程只能读到打码值。
const { createPush } = require('./push');
const { createLlm } = require('./llm');
const diag = require('./diagnostics');
const UPDATE_REPO = '121012445/NovaTrade';
let pushSvc = null, llmSvc = null;
const agentForUse = (useProxy) => (useProxy ? agentFor(futuresProxy || spotProxy, 6) : directKeepAliveAgent(6));
function getPush() {
  if (!pushSvc) pushSvc = createPush({ safeStorage, file: path.join(app.getPath('userData'), 'push_config.json'), getAgent: agentForUse, log });
  return pushSvc;
}
function getLlm() {
  if (!llmSvc) llmSvc = createLlm({ safeStorage, file: path.join(app.getPath('userData'), 'llm_config.json'), getAgent: agentForUse, log });
  return llmSvc;
}
const { createAccount } = require('./binance-account');
let acctSvc = null;
function getAccount() {
  if (!acctSvc) acctSvc = createAccount({ safeStorage, file: path.join(app.getPath('userData'), 'account_key.json'), http: binanceHttp, agent: () => agentFor(spotProxy || futuresProxy), log });
  return acctSvc;
}
ipcHandle('account:getConfig', () => getAccount().getPublicConfig());
ipcHandle('account:setKey', (e, key, secret) => getAccount().setKey(typeof key === 'string' ? key : '', typeof secret === 'string' ? secret : ''));
ipcHandle('account:import', (e, opts) => getAccount().importTrades({
  spotSymbols: opts && Array.isArray(opts.spotSymbols) ? opts.spotSymbols.map(V.symbol).filter(Boolean) : [],
  futures: !(opts && opts.futures === false)
}));
ipcHandle('push:getConfig', () => getPush().getPublicConfig());
ipcHandle('push:setConfig', (e, cfg) => getPush().setConfig(cfg));
ipcHandle('push:send', (e, msg) => { getPush().send(msg).catch((err) => log('[main] push error:', err.message)); return true; });   // 即发即忘
ipcHandle('push:test', (e, id) => getPush().test(typeof id === 'string' ? id : undefined));
ipcHandle('llm:getConfig', () => getLlm().getPublicConfig());
ipcHandle('llm:setConfig', (e, cfg) => getLlm().setConfig(cfg));
ipcHandle('llm:analyze', (e, payload) => getLlm().analyze(payload));

ipcHandle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, softwareRendering: SOFTWARE_RENDER }));
ipcHandle('update:check', async () => {
  return diag.checkUpdate({
    repo: UPDATE_REPO, current: app.getVersion(),
    request: (host, urlPath) => binanceHttp.requestJson({ family: 'generic:' + host, hosts: [host], path: urlPath, agent: agentFor(futuresProxy || spotProxy, 2), proxyKey: futuresProxy || spotProxy || 'direct', timeoutMs: 10000 })
  });
});
// 只允许打开本项目的发布页（固定地址，不接受渲染层传入的 URL）
ipcHandle('app:openReleases', () => { shell.openExternal('https://github.com/' + UPDATE_REPO + '/releases'); return true; });
ipcHandle('diagnostics:export', async () => {
  let errorLog = '';
  try { errorLog = fs.readFileSync(ensureLogFile(), 'utf8'); } catch (err) { /* 还没有日志 */ }
  const report = diag.buildReport({
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform + ' ' + process.arch, packaged: app.isPackaged },
    proxyStatus, gpu: Object.assign({ softwareRenderingNow: SOFTWARE_RENDER }, GPU_CONFIG),
    extra: { dataSource, pushConfigured: getPush().getPublicConfig().channels.length, llmConfigured: getLlm().getPublicConfig().configured },
    errorLog, maxLogBytes: 200 * 1024
  });
  return saveWithDialog('txt', 'novatrade-diagnostics-' + new Date().toISOString().slice(0, 10) + '.txt', report);
});

// 备份：渲染层把需要备份的本地数据（自选 / 预警 / 持仓 / 日志 / 设置 / 前向验证记录）序列化成 JSON 交给主进程保存；
// 恢复时主进程只负责弹框读文件并校验大小 / 结构，应用到哪些键由渲染层按白名单决定。
const BACKUP_MAX_BYTES = 30 * 1024 * 1024;
ipcHandle('backup:export', (e, json, name) => {
  if (typeof json !== 'string' || json.length > BACKUP_MAX_BYTES) return { ok: false, error: 'invalid or too large payload' };
  return saveWithDialog('json', V.fileName(name, 'novatrade-backup.json'), json);
});
ipcHandle('backup:import', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow || undefined, { title: '导入备份', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
    const f = res.filePaths[0];
    if (fs.statSync(f).size > BACKUP_MAX_BYTES) return { ok: false, error: '文件过大' };
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '不是有效的备份文件' };
    return { ok: true, data };
  } catch (err) { return { ok: false, error: '读取失败：' + err.message }; }
});

// ===== 单实例限制：同一时间只允许运行一个 NovaTrade =====
// Electron 的单实例锁以 userData 目录为键；本项目源码运行版与安装版 package.json 的
// name 都是 nova-trade（productName 在 build 段内，不参与 app.getName()）
// ⇒ 两者共用 Electron userData 目录 ⇒ 互相也会互斥，正好符合"只能开一个"的预期。
// 需要同时跑两份做调试时：加 --multi-instance 参数，或设 NOVATRADE_ALLOW_MULTI=1。
const ALLOW_MULTI_INSTANCE = process.argv.includes('--multi-instance') || process.env.NOVATRADE_ALLOW_MULTI === '1';
const gotSingleInstanceLock = ALLOW_MULTI_INSTANCE ? true : app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 已有实例在运行：立刻退出，不做任何初始化
  // （窗口/托盘都在 whenReady 里，会被下面的守卫短路掉）
  log('[main] another instance is already running -> quit');
  try { fileLog('info', 'second launch blocked by single-instance lock'); } catch (e) {}
  app.quit();
} else {
  // 用户又双击了一次图标：把已有实例的窗口唤到最前。
  // 本应用"关闭"= 隐藏到托盘，所以第二次启动必须能叫醒托盘里的窗口，
  // 否则用户会以为程序点了没反应（这正是加单实例限制后最容易踩的坑）。
  app.on('second-instance', () => {
    log('[main] second-instance detected -> focus existing window');
    try { fileLog('info', 'second-instance -> focus existing window'); } catch (e) {}
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;   // 第二实例：不建窗口、不建托盘
  // 先完成代理初始化（读配置 → 自动探测 → 校验），再创建窗口，
  // 保证渲染层首次请求就带上正确的代理设置，避免启动瞬间请求全部失败
  try { await initProxy(); } catch (e) { fileLog('proxy-init-fail', e.message); }
  await applySessionProxy();
  // 渲染页不需要任何浏览器权限（通知走主进程的 Notification）：一律拒绝
  try {
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
  } catch (e) { fileLog('permission-handler', e.message); }
  createWindow();
  // 正常启动完成一段时间后清零 GPU 崩溃计数（崩溃要「连续」才算）
  setTimeout(() => { if (GPU_CFG_FILE) gpuCfg.clearCrashes(GPU_CFG_FILE); }, 60000);
  // 页面加载完成后把代理状态推给渲染层（用于显示"代理未开启"提示）
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      try { mainWindow.webContents.send('proxy:status', proxyStatus); } catch (e) {}
    });
  }
  // 延迟创建托盘，确保主窗口句柄正常
  setTimeout(() => { createTray(); }, 1000);
});
// 【关键】托盘修复依赖主窗口保持存活：窗口真销毁后托盘左键就再也唤不回来。
// 所以关闭按钮 = 隐藏到托盘（托盘菜单"退出"才是真退出）。
app.on('window-all-closed', () => {
  // 不设置 mainWindow = null，保留引用供托盘唤起；非 darwin 平台也不退出
});
app.on('activate', () => { showMainWindow(); });
// GPU 进程异常退出：累计到阈值后自动切到软件渲染并重启一次，避免用户面对黑屏 / 反复崩溃
app.on('child-process-gone', (e, details) => {
  try {
    if (!details || details.type !== 'GPU' || details.reason === 'clean-exit' || !GPU_CFG_FILE || SOFTWARE_RENDER) return;
    fileLog('gpu-gone', JSON.stringify(details));
    const r = gpuCfg.recordGpuCrash(GPU_CFG_FILE);
    if (r.switched) { fileLog('gpu-fallback', 'switching to software rendering and relaunching'); app.isQuitting = true; app.relaunch(); app.quit(); }
  } catch (err) { fileLog('gpu-gone-handler', err.message); }
});








