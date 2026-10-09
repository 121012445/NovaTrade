'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOkx, instId, klinesToBinance, tickersToBinance } = require('../main/okx');

test('instId：只接受 USDT 现货交易对', () => {
  assert.equal(instId('BTCUSDT'), 'BTC-USDT');
  assert.equal(instId('btcusdt'), 'BTC-USDT');
  assert.equal(instId('1000PEPEUSDT'), '1000PEPE-USDT');
  for (const bad of ['BTCUSDC', 'BTC', '', null, 'BTC-USDT', '../x']) assert.equal(instId(bad), null, String(bad));
});

test('K 线：OKX（最新在前、字符串）→ 币安格式（升序、含 closeTime）', () => {
  const okx = [
    ['1700003600000', '102', '103', '101', '102.5', '11', '1100', '1127', '0'],
    ['1700000000000', '100', '102', '99', '102', '10', '1000', '1010', '1']
  ];
  const rows = klinesToBinance(okx, '1h');
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], 1700000000000, '升序');
  assert.deepEqual(rows[0].slice(0, 7), [1700000000000, '100', '102', '99', '102', '10', 1700000000000 + 3600e3 - 1]);
  assert.equal(rows[0][7], '1010', '成交额取计价币');
  assert.equal(rows[1][4], '102.5');
});

test('24h 行情：OKX → 币安格式，涨跌幅按 24h 前开盘价计算，非 USDT 对被过滤', () => {
  const out = tickersToBinance([
    { instId: 'BTC-USDT', last: '110', open24h: '100', high24h: '120', low24h: '95', volCcy24h: '5000000' },
    { instId: 'ETH-BTC', last: '0.05', open24h: '0.04', volCcy24h: '1' },
    { instId: 'BAD-USDT', last: '0', open24h: '1' },
    { instId: 'DOGE-USDT', last: '0.1', open24h: '0', high24h: '0.1', low24h: '0.1', volCcy24h: '10' }
  ]);
  assert.deepEqual(out.map((x) => x.symbol), ['BTCUSDT', 'DOGEUSDT']);
  assert.equal(out[0].priceChangePercent, '10');
  assert.equal(out[0].quoteVolume, '5000000');
  assert.equal(out[1].priceChangePercent, '0');
});

test('createOkx：请求路径、limit 上限、错误处理', async () => {
  const calls = [];
  const okx = createOkx(async (host, path) => {
    calls.push(host + path);
    if (path.includes('FAIL')) return { code: '51001', msg: 'Instrument ID does not exist' };
    if (path.startsWith('/api/v5/market/tickers')) return { code: '0', data: [{ instId: 'BTC-USDT', last: '1', open24h: '1', volCcy24h: '1' }] };
    return { code: '0', data: [['1700000000000', '1', '1', '1', '1', '1', '1', '1', '1']] };
  });
  assert.equal((await okx.tickers())[0].symbol, 'BTCUSDT');
  assert.equal(calls[0], 'www.okx.com/api/v5/market/tickers?instType=SPOT');
  await okx.klines('BTCUSDT', '4h', 5000);
  assert.equal(calls[1], 'www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=4H&limit=300');
  await assert.rejects(okx.klines('FAILUSDT', '1h', 10), /OKX error 51001/);
  await assert.rejects(okx.klines('BTCUSDC', '1h', 10), /unsupported symbol/);
  await assert.rejects(okx.klines('BTCUSDT', '3d', 10), /unsupported interval/);
});
