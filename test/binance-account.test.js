'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createAccount, checkRestrictions, sign } = require('../main/binance-account');
const { createBinanceHttp } = require('../main/binance-http');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s).toString('hex').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString()
};
const KEY = 'K'.repeat(40) + '1234', SECRET = 'S'.repeat(48);
const READ_ONLY = { enableReading: true, ipRestrict: false, enableWithdrawals: false, enableSpotAndMarginTrading: false, enableFutures: false, enableMargin: false, enableInternalTransfer: false, permitsUniversalTransfer: false, enableVanillaOptions: false };

// 假交易所：校验签名与 API Key 头，按路径返回
function exchange(perms, extra) {
  const calls = [];
  const request = async (o) => {
    calls.push(o.host + o.path);
    const [p, qs] = o.path.split('?');
    if (p === '/api/v3/time') return { status: 200, headers: {}, body: JSON.stringify({ serverTime: 1700000000000 }) };
    const sig = new URLSearchParams(qs).get('signature');
    const unsigned = qs.replace(/&signature=[0-9a-f]+$/, '');
    if (o.headers['X-MBX-APIKEY'] !== KEY || sig !== crypto.createHmac('sha256', SECRET).update(unsigned).digest('hex')) {
      return { status: 401, headers: {}, body: JSON.stringify({ code: -2014, msg: 'API-key format invalid.' }) };
    }
    const q = new URLSearchParams(qs);
    assert.ok(Number(q.get('timestamp')) > 0 && q.get('recvWindow') === '10000');
    if (p === '/sapi/v1/account/apiRestrictions') return { status: 200, headers: {}, body: JSON.stringify(perms) };
    if (p === '/api/v3/myTrades') {
      if (q.get('symbol') === 'NOPEUSDT') return { status: 400, headers: {}, body: JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }) };
      return { status: 200, headers: {}, body: JSON.stringify([{ id: 1, time: 1700000000000, isBuyer: true, price: '100', qty: '1', quoteQty: '100', commission: '0.1', commissionAsset: 'USDT' }]) };
    }
    if (extra) return extra(p, q);
    return { status: 404, headers: {}, body: '{}' };
  };
  return { calls, http: createBinanceHttp({ request }) };
}
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-acct-')), 'k.json');

test('checkRestrictions：只接受仅读取的 Key', () => {
  assert.equal(checkRestrictions(READ_ONLY).ok, true);
  assert.match(checkRestrictions(Object.assign({}, READ_ONLY, { enableWithdrawals: true })).error, /提现/);
  assert.match(checkRestrictions(Object.assign({}, READ_ONLY, { enableSpotAndMarginTrading: true, enableFutures: true })).error, /现货与杠杆交易、合约/);
  assert.match(checkRestrictions(Object.assign({}, READ_ONLY, { enableReading: false })).error, /允许读取/);
  assert.equal(checkRestrictions(null).ok, false);
  assert.equal(sign('a=1', 'k'), crypto.createHmac('sha256', 'k').update('a=1').digest('hex'));
});

test('setKey：签名请求查询权限；只读才加密保存；有交易权限的 Key 被拒绝且不落盘', async () => {
  const file = tmpFile();
  const ex = exchange(READ_ONLY);
  const a = createAccount({ safeStorage: fakeSafe, file, http: ex.http });
  assert.match((await a.setKey('short', 'x')).error, /格式/);
  const r = await a.setKey(KEY, SECRET);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.apiKey, '••••1234');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), '落盘不含明文 Secret');
  assert.equal(createAccount({ safeStorage: fakeSafe, file, http: ex.http })._cfg().apiSecret, SECRET, '重启可读回');

  const file2 = tmpFile();
  const bad = createAccount({ safeStorage: fakeSafe, file: file2, http: exchange(Object.assign({}, READ_ONLY, { enableSpotAndMarginTrading: true })).http });
  const r2 = await bad.setKey(KEY, SECRET);
  assert.equal(r2.ok, false);
  assert.match(r2.error, /只读 Key/);
  assert.ok(!fs.existsSync(file2));
  assert.equal(bad.getPublicConfig().configured, false);
  // 清除
  assert.equal((await a.setKey('', '')).config.configured, false);
});

test('importTrades：现货按交易对导入；合约从资金流水找交易对；只读 Key 读不了合约时给出 CSV 提示', async () => {
  const ex = exchange(READ_ONLY, (p) => {
    if (p === '/fapi/v1/income') return { status: 401, headers: {}, body: JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }) };
    return { status: 404, headers: {}, body: '{}' };
  });
  const a = createAccount({ safeStorage: fakeSafe, file: tmpFile(), http: ex.http });
  await a.setKey(KEY, SECRET);
  const r = await a.importTrades({ spotSymbols: ['BTCUSDT', 'NOPEUSDT', 'bad sym'] });
  assert.equal(r.ok, true);
  assert.equal(r.fills.length, 1);
  assert.deepEqual([r.fills[0].market, r.fills[0].side, r.fills[0].symbol, r.fills[0].fee], ['spot', 'BUY', 'BTCUSDT', 0.1]);
  assert.ok(r.warnings.some((w) => /导入 CSV/.test(w)));
  assert.ok(!ex.calls.some((c) => /order|withdraw|transfer/i.test(c)), '只调用读取接口: ' + ex.calls.join(' '));

  const ex2 = exchange(READ_ONLY, (p, q) => {
    if (p === '/fapi/v1/income') return { status: 200, headers: {}, body: JSON.stringify([{ symbol: 'ETHUSDT' }, { symbol: 'ETHUSDT' }]) };
    if (p === '/fapi/v1/userTrades') return { status: 200, headers: {}, body: JSON.stringify([{ id: 9, symbol: q.get('symbol'), time: 1, side: 'SELL', price: '2000', qty: '1', quoteQty: '2000', commission: '0.8', commissionAsset: 'USDT', realizedPnl: '0', positionSide: 'BOTH' }]) };
    return { status: 404, headers: {}, body: '{}' };
  });
  const b = createAccount({ safeStorage: fakeSafe, file: tmpFile(), http: ex2.http });
  await b.setKey(KEY, SECRET);
  const r2 = await b.importTrades({ spotSymbols: [] });
  assert.equal(r2.fills.length, 1);
  assert.deepEqual([r2.fills[0].market, r2.fills[0].side, r2.fills[0].id], ['futures', 'SELL', 'fut:ETHUSDT:9']);
  assert.equal(ex2.calls.filter((c) => c.includes('/fapi/v1/userTrades')).length, 1, '同一合约只请求一次');
  assert.equal((await createAccount({ safeStorage: fakeSafe, file: tmpFile(), http: ex2.http }).importTrades({})).ok, false, '未配置时拒绝');
});
