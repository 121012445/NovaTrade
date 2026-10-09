// NovaTrade 技术指标（纯函数，无 DOM 依赖）。经典脚本，定义全局 const Indicators。
const Indicators = {
  SMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  },
  EMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
  },
  EMA_Ribbon(closes, periods) {
    return periods.map(p => this.EMA(closes, p));
  },
  RSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  },
  // MACD 线 = EMA(fast) - EMA(slow)，返回与 closes 等长、下标对齐的数组（暂时算不出的位置为 null）
  _macdLine(closes, fast, slow) {
    const emaF = this._emaArr(closes, fast);
    const emaS = this._emaArr(closes, slow);
    if (!emaF || !emaS) return null;
    return emaF.map((v, i) => (v !== null && emaS[i] !== null) ? v - emaS[i] : null);
  },
  MACD(closes, fast = 12, slow = 26, signal = 9) {
    if (closes.length < slow) return null;
    const line = this._macdLine(closes, fast, slow);
    return line ? line[line.length - 1] : null;
  },
  MACDHist(closes, fast = 12, slow = 26, signal = 9) {
    // 信号线是 MACD 线的 EMA(signal)，MACD 线从第 slow 根才有值，所以至少要 slow + signal - 1 根
    if (closes.length < slow + signal - 1) return null;
    const line = this._macdLine(closes, fast, slow);
    if (!line) return null;
    const sigLine = this._emaArr(line, signal);
    if (!sigLine) return null;
    return line[line.length - 1] - sigLine[sigLine.length - 1];
  },
  // EMA 序列：与 arr 等长、下标对齐。首个 EMA 取前 period 个有效值的 SMA 作种子，种子之前为 null。
  // arr 开头允许有 null（例如 MACD 线的前导空洞），种子从第一个有效值起算。
  // 旧实现把结果整体右移了一位，且把 null 当 0 参与减法，污染了信号线（序列较短时偏差很大）。
  _emaArr(arr, period) {
    let start = 0;
    while (start < arr.length && (arr[start] === null || !isFinite(arr[start]))) start++;
    if (arr.length - start < period) return null;
    const k = 2 / (period + 1);
    const out = new Array(arr.length).fill(null);
    let ema = 0;
    for (let i = start; i < start + period; i++) ema += arr[i];
    ema /= period;
    out[start + period - 1] = ema;
    for (let i = start + period; i < arr.length; i++) { ema = arr[i] * k + ema * (1 - k); out[i] = ema; }
    return out;
  },
  BB(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    const up = mean + stdDev * std, low = mean - stdDev * std;
    // 2026-10-09 新增：%B = 现价在通道中的相对位置（0=下轨,1=上轨）；width = 带宽占中轨百分比。
    // 原实现只返回 up/mid/low，带宽在 analyzeCoin 里另算且从未渲染，这里统一补齐（up/mid/low 保持原值不变）。
    const last = closes[closes.length - 1];
    const pctB = (up - low) > 0 ? (last - low) / (up - low) : 0.5;
    const width = mean > 0 ? ((up - low) / mean) * 100 : 0;
    return { up: up, mid: mean, low: low, pctB: pctB, width: width };
  },
  // ---- 以下 4 组为 2026-10-09「第一步：补齐基础指标 + 量价分析」新增 ----
  // 均为纯计算、无外部依赖；仅用于展示与三维投票，不参与 analyzeCoin 的主 score。
  // OBV（能量潮）：价涨加量、价跌减量并累计。用途是判断「量能是否跟上了价格」——单看量比只能看当下这一根。
  OBV_Array(ohlc) {
    if (!ohlc || ohlc.length < 2) return null;
    const out = [0];
    for (let i = 1; i < ohlc.length; i++) {
      const vol = ohlc[i][5] || 0, prev = out[i - 1];
      if (ohlc[i][4] > ohlc[i - 1][4]) out.push(prev + vol);
      else if (ohlc[i][4] < ohlc[i - 1][4]) out.push(prev - vol);
      else out.push(prev);
    }
    return out;
  },
  OBV(ohlc, lookback = 20) {
    const arr = this.OBV_Array(ohlc);
    if (!arr) return null;
    const n = arr.length, value = arr[n - 1];
    const j = Math.max(0, n - 1 - lookback);
    const ref = arr[j];
    const priceUp = ohlc[n - 1][4] > ohlc[j][4], obvUp = value > ref;
    let state = "neutral", note = "量价中性";
    if (priceUp && obvUp) { state = "bull"; note = "量价齐升，上行有量能确认"; }
    else if (priceUp && !obvUp) { state = "bear"; note = "价涨量不跟（顶背离风险）"; }
    else if (!priceUp && obvUp) { state = "bull"; note = "价跌量在收（底背离迹象）"; }
    else { state = "bear"; note = "量价齐跌，下行有量能确认"; }
    return { value: value, slope: value - ref, state: state, note: note };
  },
  // KDJ（随机指标）：比 RSI 更敏感，适合短周期择时；与 RSI 同属超买超卖族但响应更快。
  KDJ_Array(ohlc, n = 9, kSmooth = 3, dSmooth = 3) {
    if (!ohlc || ohlc.length < n) return null;
    const K = [], D = [], J = [];
    let k = 50, d = 50;
    for (let i = 0; i < ohlc.length; i++) {
      const from = Math.max(0, i - n + 1);
      let hh = -Infinity, ll = Infinity;
      for (let j = from; j <= i; j++) {
        if (ohlc[j][2] > hh) hh = ohlc[j][2];
        if (ohlc[j][3] < ll) ll = ohlc[j][3];
      }
      const rsv = (hh - ll) > 0 ? ((ohlc[i][4] - ll) / (hh - ll)) * 100 : 50;
      k = (k * (kSmooth - 1) + rsv) / kSmooth;
      d = (d * (dSmooth - 1) + k) / dSmooth;
      K.push(k); D.push(d); J.push(3 * k - 2 * d);
    }
    return { k: K, d: D, j: J };
  },
  KDJ(ohlc, n = 9) {
    const a = this.KDJ_Array(ohlc, n);
    if (!a) return null;
    const i = a.k.length - 1;
    return { k: a.k[i], d: a.d[i], j: a.j[i] };
  },
  // VWAP（成交量加权均价）：机构成本线。加密 7×24 无自然日切分，故用滚动 N 根窗口（默认 96 根 ≈ 4h 图上 16 天）。
  VWAP(ohlc, period = 96) {
    if (!ohlc || ohlc.length === 0) return null;
    const from = Math.max(0, ohlc.length - period);
    let pv = 0, v = 0;
    for (let i = from; i < ohlc.length; i++) {
      const tp = (ohlc[i][2] + ohlc[i][3] + ohlc[i][4]) / 3; // typical price
      const vol = ohlc[i][5] || 0;
      pv += tp * vol; v += vol;
    }
    if (v <= 0) return null;
    const value = pv / v, price = ohlc[ohlc.length - 1][4];
    return { value: value, above: price >= value, dev: value > 0 ? ((price - value) / value) * 100 : 0 };
  },
  // 成交量分布（Volume Profile）：按价格分箱统计成交量 → POC（最大量价区）与 VA（70% 价值区）。
  // 单根 K 线的量按 high-low 区间均匀摊到覆盖的各箱，比「按收盘价整根归箱」更贴近真实筹码分布。
  VolumeProfile(ohlc, bins = 24) {
    if (!ohlc || ohlc.length < 10) return null;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ohlc.length; i++) {
      if (ohlc[i][3] < lo) lo = ohlc[i][3];
      if (ohlc[i][2] > hi) hi = ohlc[i][2];
    }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins;
    const vols = new Array(bins).fill(0);
    for (let i = 0; i < ohlc.length; i++) {
      const vol = ohlc[i][5] || 0;
      const b1 = Math.min(bins - 1, Math.max(0, Math.floor((ohlc[i][3] - lo) / step)));
      const b2 = Math.min(bins - 1, Math.max(0, Math.floor((ohlc[i][2] - lo) / step)));
      const span = b2 - b1 + 1;
      for (let b = b1; b <= b2; b++) vols[b] += vol / span;
    }
    let pocIdx = 0;
    for (let b = 1; b < bins; b++) if (vols[b] > vols[pocIdx]) pocIdx = b;
    const total = vols.reduce((a, b) => a + b, 0);
    // 价值区：自 POC 向两侧扩张，直到累计量达到总量 70%（经典 Market Profile 口径）
    let acc = vols[pocIdx], loIdx = pocIdx, hiIdx = pocIdx;
    const target = total * 0.7;
    while (acc < target && (loIdx > 0 || hiIdx < bins - 1)) {
      const left = loIdx > 0 ? vols[loIdx - 1] : -1;
      const right = hiIdx < bins - 1 ? vols[hiIdx + 1] : -1;
      if (right >= left) { hiIdx++; acc += Math.max(0, right); }
      else { loIdx--; acc += Math.max(0, left); }
    }
    return {
      poc: lo + step * (pocIdx + 0.5),
      vaLow: lo + step * loIdx,
      vaHigh: lo + step * (hiIdx + 1),
      lo: lo, hi: hi, bins: bins, step: step, vols: vols, total: total,
      price: ohlc[ohlc.length - 1][4]
    };
  },
  ADX(closes, period = 14, smooth = 14, ohlc) {
    if (closes.length < period + 1) return { adx: 20, pdi: 20, mdi: 20 };
    const highs = [], lows = [];
    for (let i = 0; i < closes.length; i++) {
      if (ohlc && ohlc.length > i) { highs.push(ohlc[i][2]); lows.push(ohlc[i][3]); }
      else {
        highs.push(i > 0 ? Math.max(closes[i], closes[i-1]) : closes[i]);
        lows.push(i > 0 ? Math.min(closes[i], closes[i-1]) : closes[i]);
      }
    }
    // TR 与方向性移动 DM（Wilder）：无 ohlc 时高低价由收盘价合成，TR 至少为 |Δclose|
    let atr = 0, plusDM = 0, minusDM = 0;
    for (let i = 1; i <= period; i++) {
      atr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      if (up > dn && up > 0) plusDM += up;
      if (dn > up && dn > 0) minusDM += dn;
    }
    atr /= period;
    let sp = plusDM, sm = minusDM;
    let plusDI = atr > 0 ? (sp / atr) * 100 : 0;
    let minusDI = atr > 0 ? (sm / atr) * 100 : 0;
    let dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
    let adxVal = dx;
    for (let i = period + 1; i < closes.length; i++) {
      const trv = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      const p = (up > dn && up > 0) ? up : 0;
      const m = (dn > up && dn > 0) ? dn : 0;
      atr = (atr * (smooth - 1) + trv) / smooth;
      sp = (sp * (smooth - 1) + p) / smooth;
      sm = (sm * (smooth - 1) + m) / smooth;
      plusDI = atr > 0 ? (sp / atr) * 100 : 0;
      minusDI = atr > 0 ? (sm / atr) * 100 : 0;
      dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
      adxVal = (adxVal * (smooth - 1) + dx) / smooth;
    }
    return { adx: adxVal, pdi: plusDI, mdi: minusDI };
  },
  DI(closes, period = 14, ohlc) { return this.ADX(closes, period, period, ohlc); },
  ADX_Array(closes, period = 14, smooth = 14, ohlc) {
    if (closes.length < period + 1) return null;
    const highs = [], lows = [];
    for (let i = 0; i < closes.length; i++) {
      if (ohlc && ohlc.length > i) { highs.push(ohlc[i][2]); lows.push(ohlc[i][3]); }
      else {
        highs.push(i > 0 ? Math.max(closes[i], closes[i-1]) : closes[i]);
        lows.push(i > 0 ? Math.min(closes[i], closes[i-1]) : closes[i]);
      }
    }
    let atr = 0, plusDM = 0, minusDM = 0;
    for (let i = 1; i <= period; i++) {
      atr += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      if (up > dn && up > 0) plusDM += up;
      if (dn > up && dn > 0) minusDM += dn;
    }
    atr /= period;
    let sp = plusDM, sm = minusDM;
    let plusDI = atr > 0 ? (sp / atr) * 100 : 0;
    let minusDI = atr > 0 ? (sm / atr) * 100 : 0;
    let dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
    let adxVal = dx;
    const adxArr = [], pdiArr = [], mdiArr = [];
    for (let i = 0; i < period; i++) { adxArr.push(null); pdiArr.push(null); mdiArr.push(null); }
    adxArr.push(adxVal); pdiArr.push(plusDI); mdiArr.push(minusDI);
    for (let i = period + 1; i < closes.length; i++) {
      const trv = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
      const up = highs[i] - highs[i-1], dn = lows[i-1] - lows[i];
      const p = (up > dn && up > 0) ? up : 0;
      const m = (dn > up && dn > 0) ? dn : 0;
      atr = (atr * (smooth - 1) + trv) / smooth;
      sp = (sp * (smooth - 1) + p) / smooth;
      sm = (sm * (smooth - 1) + m) / smooth;
      plusDI = atr > 0 ? (sp / atr) * 100 : 0;
      minusDI = atr > 0 ? (sm / atr) * 100 : 0;
      dx = (plusDI + minusDI) > 0 ? Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 : 0;
      adxVal = (adxVal * (smooth - 1) + dx) / smooth;
      adxArr.push(adxVal); pdiArr.push(plusDI); mdiArr.push(minusDI);
    }
    return { adx: adxArr, pdi: pdiArr, mdi: mdiArr };
  },  RSI_Array(closes, period = 14) {
    if (closes.length < period + 1) return null;
    const result = [];
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    for (let i = 0; i < period; i++) result.push(null);
    if (avgLoss === 0) { result.push(100); } else { result.push(100 - 100 / (1 + avgGain / avgLoss)); }
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
      if (avgLoss === 0) { result.push(100); } else { result.push(100 - 100 / (1 + avgGain / avgLoss)); }
    }
    return result;
  }
};
