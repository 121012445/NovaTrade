'use strict';
// 币安只读 API：导入你自己的真实成交，用来和系统信号对照（见 renderer/lib/fills.js）。
//
// 安全边界（与应用「不具备任何交易能力」的定位一致）：
// - 只调用读取类接口（成交历史、资金流水、权限查询、服务器时间），代码里没有任何下单 / 撤单 / 划转 / 提现接口。
// - 保存 Key 之前先查询它的权限（/sapi/v1/account/apiRestrictions）：只要开了交易、杠杆、合约、期权、提现、划转中的任何一项就拒绝保存。
//   也就是说，只接受「仅读取」的 Key —— 即使 Key 泄漏，也没人能用它下单或提币。
// - Key / Secret 用系统安全存储（safeStorage）加密落盘；渲染进程只能看到打码后的 Key 尾号，永远拿不到 Secret。
//
// 注意：币安的部分合约读取接口可能要求 Key 开启「允许合约」权限（该权限同时允许合约交易），
// 本应用不接受这类 Key，所以合约成交可能无法通过 API 导入 —— 这时请在币安网页导出成交历史 CSV，再用「导入 CSV」。
const crypto = require('crypto');
const fs = require('fs');

const MASK = '••••';
const SPOT_HOSTS = ['api.binance.com', 'api1.binance.com', 'api2.binance.com', 'api3.binance.com'];
const FUT_HOSTS = ['fapi.binance.com', 'fapi1.binance.com', 'fapi2.binance.com'];
// 这些权限任何一项为 true 都拒绝
const UNSAFE = ['enableWithdrawals', 'enableInternalTransfer', 'permitsUniversalTransfer', 'enableSpotAndMarginTrading',
  'enableMargin', 'enableFutures', 'enableVanillaOptions', 'enablePortfolioMarginTrading'];
const UNSAFE_LABEL = {
  enableWithdrawals: '提现', enableInternalTransfer: '内部转账', permitsUniversalTransfer: '万向划转', enableSpotAndMarginTrading: '现货与杠杆交易',
  enableMargin: '杠杆', enableFutures: '合约', enableVanillaOptions: '期权', enablePortfolioMarginTrading: '统一账户交易'
};

function sign(query, secret) { return crypto.createHmac('sha256', secret).update(query).digest('hex'); }

// 只检查权限对象本身（纯函数，便于测试）。返回 { ok, error?, perms }
function checkRestrictions(r) {
  if (!r || typeof r !== 'object') return { ok: false, error: '无法读取该 Key 的权限' };
  if (r.enableReading !== true) return { ok: false, error: '该 Key 没有「允许读取」权限' };
  const bad = UNSAFE.filter((k) => r[k] === true);
  if (bad.length) return { ok: false, error: '为安全起见只接受只读 Key：请在币安关闭该 Key 的「' + bad.map((k) => UNSAFE_LABEL[k]).join('、') + '」权限后再试（或新建一个只读 Key）', perms: r };
  return { ok: true, perms: r };
}

// 币安合约 userTrades / 现货 myTrades → 统一的成交格式
function normSpot(t, symbol) {
  return {
    id: 'spot:' + symbol + ':' + t.id, ts: Number(t.time), symbol, market: 'spot', side: t.isBuyer ? 'BUY' : 'SELL',
    price: parseFloat(t.price), qty: parseFloat(t.qty), quote: parseFloat(t.quoteQty),
    fee: parseFloat(t.commission) || 0, feeAsset: String(t.commissionAsset || ''), realizedPnl: null, positionSide: 'BOTH'
  };
}
function normFut(t) {
  return {
    id: 'fut:' + t.symbol + ':' + t.id, ts: Number(t.time), symbol: t.symbol, market: 'futures', side: t.side === 'BUY' ? 'BUY' : 'SELL',
    price: parseFloat(t.price), qty: parseFloat(t.qty), quote: parseFloat(t.quoteQty),
    fee: parseFloat(t.commission) || 0, feeAsset: String(t.commissionAsset || ''), realizedPnl: parseFloat(t.realizedPnl) || 0,
    positionSide: t.positionSide || 'BOTH'
  };
}

// deps: { safeStorage, file, http（createBinanceHttp 的实例）, agent?(): https.Agent, now?, log? }
function createAccount(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || function () {};
  let cfg = { apiKey: '', apiSecret: '', perms: null, savedAt: 0 };
  let offset = 0;                                     // 本机时间与币安服务器时间的差

  function encryptable() { try { return !!(deps.safeStorage && deps.safeStorage.isEncryptionAvailable()); } catch (e) { return false; } }
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.file, 'utf8'));
      if (!raw || raw.v !== 1 || !encryptable()) return;
      const c = JSON.parse(deps.safeStorage.decryptString(Buffer.from(raw.data, 'base64')));
      if (c && typeof c.apiKey === 'string' && typeof c.apiSecret === 'string') cfg = c;
    } catch (e) { /* 未配置 */ }
  }
  function persist() {
    if (!encryptable()) return { ok: false, error: '系统安全存储不可用，无法安全保存 API Key' };
    const tmp = deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, data: deps.safeStorage.encryptString(JSON.stringify(cfg)).toString('base64') }));
    fs.renameSync(tmp, deps.file);
    return { ok: true };
  }

  async function syncTime() {
    try {
      const r = await deps.http.requestJson({ family: 'acct-spot', hosts: SPOT_HOSTS, path: '/api/v3/time', agent: deps.agent && deps.agent(), noDedupe: true });
      if (r && isFinite(r.serverTime)) offset = r.serverTime - now();
    } catch (e) { offset = 0; }
  }
  // 签名的只读 GET 请求
  function signedGet(host, family, path, params, key, secret) {
    const q = Object.assign({}, params || {}, { recvWindow: 10000, timestamp: Math.floor(now() + offset) });
    const qs = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(q[k])).join('&');
    return deps.http.requestJson({
      family, hosts: host, path: path + '?' + qs + '&signature=' + sign(qs, secret),
      headers: { 'X-MBX-APIKEY': key }, agent: deps.agent && deps.agent(), noDedupe: true, timeoutMs: 15000
    });
  }

  function getPublicConfig() {
    return {
      canStore: encryptable(), configured: !!cfg.apiKey,
      apiKey: cfg.apiKey ? MASK + cfg.apiKey.slice(-4) : '', savedAt: cfg.savedAt || 0,
      perms: cfg.perms ? { enableReading: !!cfg.perms.enableReading, ipRestrict: !!cfg.perms.ipRestrict } : null
    };
  }

  // 保存前先验证权限：只读才保存
  async function setKey(apiKey, apiSecret) {
    const k = String(apiKey || '').trim(), s = String(apiSecret || '').trim();
    if (!k && !s) { cfg = { apiKey: '', apiSecret: '', perms: null, savedAt: 0 }; const r = persist(); return r.ok ? { ok: true, config: getPublicConfig() } : r; }
    if (!/^[A-Za-z0-9]{32,128}$/.test(k) || !/^[A-Za-z0-9]{32,128}$/.test(s)) return { ok: false, error: 'API Key / Secret 格式不对（应为 32–128 位字母数字）' };
    if (!encryptable()) return { ok: false, error: '系统安全存储不可用，无法安全保存 API Key' };
    await syncTime();
    let perms;
    try { perms = await signedGet(SPOT_HOSTS, 'acct-spot', '/sapi/v1/account/apiRestrictions', {}, k, s); }
    catch (e) { return { ok: false, error: '验证 Key 失败：' + String((e && e.message) || e).slice(0, 160) }; }
    const chk = checkRestrictions(perms);
    if (!chk.ok) return { ok: false, error: chk.error };
    cfg = { apiKey: k, apiSecret: s, perms: chk.perms, savedAt: now() };
    const r = persist();
    if (!r.ok) { cfg = { apiKey: '', apiSecret: '', perms: null, savedAt: 0 }; return r; }
    return { ok: true, config: getPublicConfig() };
  }

  // 导入：现货按给定交易对拉最近 1000 笔；合约先从资金流水里找出最近交易过的合约，再逐个拉成交。
  // 返回 { ok, fills, warnings }
  async function importTrades(opts) {
    if (!cfg.apiKey) return { ok: false, error: '还没有配置只读 API Key' };
    const o = opts || {};
    const spotSyms = (Array.isArray(o.spotSymbols) ? o.spotSymbols : []).filter((x) => /^[A-Z0-9]{2,30}$/.test(x)).slice(0, 40);
    const fills = [], warnings = [];
    await syncTime();
    for (const sym of spotSyms) {
      try {
        const r = await signedGet(SPOT_HOSTS, 'acct-spot', '/api/v3/myTrades', { symbol: sym, limit: 1000 }, cfg.apiKey, cfg.apiSecret);
        if (Array.isArray(r)) r.forEach((t) => fills.push(normSpot(t, sym)));
      } catch (e) {
        if (e && e.code === -1121) continue;          // 没有这个现货交易对
        warnings.push('现货 ' + sym + '：' + String(e.message).slice(0, 100));
      }
    }
    if (o.futures !== false) {
      try {
        const start = now() + offset - 90 * 86400e3;
        const income = await signedGet(FUT_HOSTS, 'acct-fut', '/fapi/v1/income', { incomeType: 'REALIZED_PNL', startTime: Math.floor(start), limit: 1000 }, cfg.apiKey, cfg.apiSecret);
        const syms = Array.from(new Set((Array.isArray(income) ? income : []).map((x) => x.symbol).filter((x) => /^[A-Z0-9]{2,30}$/.test(x)))).slice(0, 40);
        for (const sym of syms) {
          try {
            const r = await signedGet(FUT_HOSTS, 'acct-fut', '/fapi/v1/userTrades', { symbol: sym, limit: 1000 }, cfg.apiKey, cfg.apiSecret);
            if (Array.isArray(r)) r.forEach((t) => fills.push(normFut(t)));
          } catch (e) { warnings.push('合约 ' + sym + '：' + String(e.message).slice(0, 100)); }
        }
      } catch (e) {
        warnings.push(e && e.code === -2015
          ? '合约成交无法通过只读 Key 读取（币安要求开启合约权限，本应用不接受）。请在币安导出合约成交历史 CSV 后用「导入 CSV」。'
          : '合约：' + String((e && e.message) || e).slice(0, 120));
      }
    }
    log('[account] imported fills=' + fills.length + ' warnings=' + warnings.length);
    return { ok: true, fills: fills.filter((f) => f.price > 0 && f.qty > 0 && isFinite(f.ts)), warnings };
  }

  load();
  return { getPublicConfig, setKey, importTrades, _cfg: () => cfg };
}

module.exports = { createAccount, checkRestrictions, sign, normSpot, normFut, UNSAFE };
