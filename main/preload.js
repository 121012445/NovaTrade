const { contextBridge, ipcRenderer } = require('electron');

try {
  contextBridge.exposeInMainWorld('binanceAPI', {
    getTickers: () => ipcRenderer.invoke('binance:getTickers'),
    getKlines: (symbol, interval, limit, startTime) => ipcRenderer.invoke('binance:getKlines', symbol, interval, limit, startTime),
    getPrice: (symbol) => ipcRenderer.invoke('binance:getPrice', symbol),
    get24hrTicker: (symbol) => ipcRenderer.invoke('binance:get24hrTicker', symbol),
    fwdLoad: () => ipcRenderer.invoke('fwd:load'),
    fwdSave: (data) => ipcRenderer.invoke('fwd:save', data),
    derivSnapshot: (symbol, period, limit) => ipcRenderer.invoke('deriv:snapshot', symbol, period, limit),
    getExchangeInfo: () => ipcRenderer.invoke('binance:getExchangeInfo'),
    getFuturesTickers: () => ipcRenderer.invoke('binance:getFuturesTickers'),
    getFuturesKlines: (symbol, interval, limit) => ipcRenderer.invoke('binance:getFuturesKlines', symbol, interval, limit),
    getFuturesPrice: (symbol) => ipcRenderer.invoke('binance:getFuturesPrice', symbol),
    getFuturesSymbols: () => ipcRenderer.invoke('binance:getFuturesSymbols'),
    fng: (limit) => ipcRenderer.invoke('alt:fng', limit),
    getFuturesDepth: (symbol, limit) => ipcRenderer.invoke('binance:futuresDepth', symbol, limit),
    getAggTrades: (symbol, limit) => ipcRenderer.invoke('binance:aggTrades', symbol, limit),
    getHistory: (symbol, interval, bars) => ipcRenderer.invoke('history:get', symbol, interval, bars),
    getDataSource: () => ipcRenderer.invoke('data:source'),
    premiumAll: () => ipcRenderer.invoke('binance:premiumAll'),
    derivLite: (symbol) => ipcRenderer.invoke('deriv:lite', symbol)
  });
  contextBridge.exposeInMainWorld('electronAPI', {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    createWidget: () => ipcRenderer.invoke('widget:create'),
    closeWidget: () => ipcRenderer.send('widget:close'),
    onWidgetUpdate: (cb) => ipcRenderer.on('widget:data', (e, data) => cb(data)),
    showMain: () => ipcRenderer.send('window:show'),
    widgetUpdate: (data) => ipcRenderer.send('widget:update', data),
    resizeWidget: (w, h) => ipcRenderer.send('widget:resize', w, h),
    setWidgetAlwaysOnTop: (enabled) => ipcRenderer.send('widget:alwaysOnTop', enabled),
    sendMessage: (msg) => ipcRenderer.send('renderer-msg', msg),
    openDevTools: () => ipcRenderer.send('devtools:open'),
    refresh: () => ipcRenderer.send('renderer:refresh'),
    setProxy: (proxy) => ipcRenderer.invoke('futures:setProxy', proxy),
    getProxy: () => ipcRenderer.invoke('futures:getProxy'),
    setSpotProxy: (proxy) => ipcRenderer.invoke('spot:setProxy', proxy),
    getSpotProxy: () => ipcRenderer.invoke('spot:getProxy'),
    getProxyStatus: () => ipcRenderer.invoke('proxy:getStatus'),
    redetectProxy: () => ipcRenderer.invoke('proxy:redetect'),
    verifyProxy: () => ipcRenderer.invoke('proxy:verify'),
    onProxyStatus: (cb) => ipcRenderer.on('proxy:status', (e, s) => cb(s)),
    onWidgetCreated: (cb) => ipcRenderer.on('widget:created', () => cb()),
    notify: (payload) => ipcRenderer.invoke('notify:show', payload),
    exportCsv: (defaultName, text) => ipcRenderer.invoke('file:exportCsv', defaultName, text),
    exportPng: (defaultName, dataUrl) => ipcRenderer.invoke('file:exportPng', defaultName, dataUrl),
    setTrayStatus: (text) => ipcRenderer.invoke('tray:status', text),
    pushGetConfig: () => ipcRenderer.invoke('push:getConfig'),
    pushSetConfig: (cfg) => ipcRenderer.invoke('push:setConfig', cfg),
    pushSend: (msg) => ipcRenderer.invoke('push:send', msg),
    pushTest: (id) => ipcRenderer.invoke('push:test', id),
    llmGetConfig: () => ipcRenderer.invoke('llm:getConfig'),
    llmSetConfig: (cfg) => ipcRenderer.invoke('llm:setConfig', cfg),
    llmAnalyze: (payload) => ipcRenderer.invoke('llm:analyze', payload),
    appInfo: () => ipcRenderer.invoke('app:info'),
    checkUpdate: () => ipcRenderer.invoke('update:check'),
    openReleases: () => ipcRenderer.invoke('app:openReleases'),
    exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
    backupExport: (json, name) => ipcRenderer.invoke('backup:export', json, name),
    backupImport: () => ipcRenderer.invoke('backup:import')
  });
  console.log('[preload] OK');
} catch(e) {
  console.error('[preload] ERROR:', e.message);
}
