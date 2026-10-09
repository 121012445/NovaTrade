'use strict';
// IPC 入参校验：渲染进程传来的一切都视为不可信。
// 这些值最终会拼进 URL / 文件名 / 通知文案，必须先收敛到白名单或合理范围。
const path = require('path');

const INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M']);
// 合约统计类接口（持仓量 / 多空比）允许的 period
const PERIODS = new Set(['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d']);

// 交易对：大写字母 + 数字（含 1000PEPEUSDT、BTCUSDT_250627 这类），长度受限
function symbol(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^[A-Z0-9_]{2,30}$/.test(s) ? s : null;
}
function interval(v) { return INTERVALS.has(v) ? v : null; }
function period(v) { return PERIODS.has(v) ? v : null; }
// 整数并夹到 [lo, hi]；不是有限数字时返回默认值
function int(v, lo, hi, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
// 毫秒时间戳：正的有限数，且不晚于「现在 + 1 天」
function timestamp(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0 || n > Date.now() + 86400e3) return null;
  return n;
}
function str(v, max) { return String(v == null ? '' : v).slice(0, max); }
// 文件名：去掉路径、非法字符与控制字符，限制长度；空则用默认名
function fileName(v, def) {
  let b = path.basename(String(v == null ? '' : v)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim().slice(0, 80);
  if (!b || b === '.' || b === '..') b = def;
  return b;
}
// 只接受 http/https/socks 代理地址或空串（直连）；返回规范化后的字符串，非法返回 null
function proxyUrl(v) {
  if (v === '' || v == null) return '';
  if (typeof v !== 'string' || v.length > 200) return null;
  try {
    const u = new URL(v);
    const scheme = u.protocol.replace(':', '');
    if (!['http', 'https', 'socks', 'socks4', 'socks5'].includes(scheme) || !u.hostname) return null;
    return v;
  } catch (e) { return null; }
}

module.exports = { symbol, interval, period, int, timestamp, str, fileName, proxyUrl, INTERVALS, PERIODS };
