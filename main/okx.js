'use strict';
// OKX 现货公开行情，作为币安完全不可达（网络 / 封禁 / 地区限制）时的备用数据源。
// 只做「只读行情」：24h 行情与 K 线，且统一转换成币安的返回格式，上层代码无需感知数据来自哪里。
// 备用数据源只覆盖现货 USDT 交易对：没有合约行情、没有衍生品数据，K 线单次最多 300 根。
const OKX_HOST = 'www.okx.com';
const BAR = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W' };
const IV_MS = { '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '12h': 43200e3, '1d': 86400e3, '1w': 604800e3 };

// BTCUSDT -> BTC-USDT；非 USDT 计价或形态不对返回 null
function instId(symbol) {
  const m = /^([A-Z0-9]{2,20})USDT$/.exec(String(symbol || '').toUpperCase());
  return m ? m[1] + '-USDT' : null;
}

// OKX 返回 { code:'0', data:[…] }；非 '0' 视为失败
function unwrap(j) {
  if (!j || j.code !== '0' || !Array.isArray(j.data)) throw new Error('OKX error ' + (j && j.code) + ' ' + String((j && j.msg) || '').slice(0, 80));
  return j.data;
}

// candles 行：[ts, o, h, l, c, vol(base), volCcy, volCcyQuote, confirm]，最新在前
function klinesToBinance(data, iv) {
  const ms = IV_MS[iv];
  return data.slice().reverse().map((r) => {
    const t = Number(r[0]);
    return [t, String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5]), t + ms - 1, String(r[7] || r[6] || '0'), 0, '0', '0', '0'];
  });
}

// tickers 行：{ instId, last, open24h, high24h, low24h, volCcy24h(现货为计价币成交额) }
function tickersToBinance(data) {
  const out = [];
  for (const t of data) {
    const m = /^([A-Z0-9]+)-USDT$/.exec(t.instId || '');
    if (!m) continue;
    const last = parseFloat(t.last), open = parseFloat(t.open24h);
    if (!(last > 0)) continue;
    out.push({
      symbol: m[1] + 'USDT', lastPrice: String(last),
      priceChangePercent: String(open > 0 ? (last - open) / open * 100 : 0),
      quoteVolume: String(parseFloat(t.volCcy24h) || 0),
      highPrice: String(parseFloat(t.high24h) || 0), lowPrice: String(parseFloat(t.low24h) || 0)
    });
  }
  return out;
}

// request(host, path) -> 解析后的 JSON（由调用方提供，复用统一的 HTTP 层）
function createOkx(request) {
  return {
    async tickers() {
      return tickersToBinance(unwrap(await request(OKX_HOST, '/api/v5/market/tickers?instType=SPOT')));
    },
    async klines(symbol, iv, limit) {
      const id = instId(symbol), bar = BAR[iv];
      if (!id) throw new Error('OKX fallback: unsupported symbol ' + symbol);
      if (!bar) throw new Error('OKX fallback: unsupported interval ' + iv);
      const n = Math.max(1, Math.min(300, Math.floor(limit) || 100));
      return klinesToBinance(unwrap(await request(OKX_HOST, '/api/v5/market/candles?instId=' + id + '&bar=' + bar + '&limit=' + n)), iv);
    }
  };
}

module.exports = { createOkx, instId, klinesToBinance, tickersToBinance, OKX_HOST };
