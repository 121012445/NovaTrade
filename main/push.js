'use strict';
// 远程推送：把预警 / 信号提醒发到手机或群机器人（Telegram、飞书、企业微信、Bark、通用 Webhook）。
// 只发文字通知，不接收任何指令，也没有任何交易能力。
//
// 安全：
// - 渠道配置里含机器人令牌 / Webhook 地址，属于凭据：用系统安全存储（safeStorage，Windows 下为 DPAPI）加密落盘，
//   系统安全存储不可用时拒绝保存（宁可不能用，也不把凭据明文写盘）。
// - 渲染进程永远拿不到明文：读取配置只返回打码后的尾号；保存时遇到打码占位符就保留原值。
// - 地址必须是 https（通用 Webhook 允许 http 但仅限本机 / 内网回环地址）；日志里不出现完整 URL。
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const MASK = '••••';
const MAX_CHANNELS = 6;
const MAX_TITLE = 100, MAX_BODY = 1000;
const HOURLY_CAP = 60, DEDUPE_MS = 30000;

// 每种渠道的字段、哪些是机密、默认是否走代理（Telegram 在国内通常需要代理，其余默认直连）
const TYPES = {
  telegram: { fields: ['botToken', 'chatId'], secret: ['botToken'], proxy: true },
  feishu: { fields: ['url', 'secret'], secret: ['url', 'secret'], proxy: false },
  wecom: { fields: ['url'], secret: ['url'], proxy: false },
  bark: { fields: ['url'], secret: ['url'], proxy: false },
  webhook: { fields: ['url'], secret: ['url'], proxy: false }
};

function isLoopbackHost(h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'; }

function validateUrl(v, allowLoopbackHttp) {
  let u;
  try { u = new URL(v); } catch (e) { return null; }
  if (u.protocol === 'https:') return u;
  if (allowLoopbackHttp && u.protocol === 'http:' && isLoopbackHost(u.hostname)) return u;
  return null;
}

// 校验并规范化一个渠道；返回 { ok, channel } 或 { ok:false, error }
function normalizeChannel(c) {
  if (!c || typeof c !== 'object') return { ok: false, error: '渠道格式不正确' };
  const spec = TYPES[c.type];
  if (!spec) return { ok: false, error: '不支持的渠道类型：' + String(c.type).slice(0, 20) };
  const out = { id: typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : 'c' + crypto.randomBytes(4).toString('hex'), type: c.type, enabled: c.enabled !== false, useProxy: c.useProxy === undefined ? spec.proxy : !!c.useProxy };
  for (const f of spec.fields) {
    const v = typeof c[f] === 'string' ? c[f].trim() : '';
    if (v.length > 600) return { ok: false, error: f + ' 过长' };
    out[f] = v;
  }
  return { ok: true, channel: out };
}

function validateComplete(ch) {
  if (ch.type === 'telegram') {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(ch.botToken)) return 'Telegram botToken 格式不对（应形如 123456:ABC…）';
    if (!/^-?\d+$/.test(ch.chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(ch.chatId)) return 'Telegram chatId 格式不对（数字 ID 或 @频道名）';
    return null;
  }
  if (!ch.url) return '请填写地址';
  if (!validateUrl(ch.url, ch.type === 'webhook')) return ch.type === 'webhook' ? '地址必须是 https（本机回环地址可用 http）' : '地址必须是 https';
  return null;
}

function mask(v) { return v ? MASK + v.slice(-4) : ''; }

// 构造请求（纯函数，便于测试）。返回 { url: URL, headers, body }
function buildRequest(ch, msg, nowSec) {
  const title = msg.title, body = msg.body;
  const text = body ? title + '\n' + body : title;
  const json = (o) => ({ headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(o) });
  switch (ch.type) {
    case 'telegram':
      return Object.assign({ url: new URL('https://api.telegram.org/bot' + ch.botToken + '/sendMessage') },
        json({ chat_id: ch.chatId, text: text, disable_web_page_preview: true }));
    case 'feishu': {
      const payload = { msg_type: 'text', content: { text: text } };
      if (ch.secret) {
        // 飞书自定义机器人「签名校验」：以 `timestamp\nsecret` 为 HMAC-SHA256 的 key，对空消息签名，Base64
        payload.timestamp = String(nowSec);
        payload.sign = crypto.createHmac('sha256', nowSec + '\n' + ch.secret).update('').digest('base64');
      }
      return Object.assign({ url: new URL(ch.url) }, json(payload));
    }
    case 'wecom':
      return Object.assign({ url: new URL(ch.url) }, json({ msgtype: 'text', text: { content: text } }));
    case 'bark':
      return Object.assign({ url: new URL(ch.url) }, json({ title: title, body: body, group: 'NovaTrade' }));
    default:
      return Object.assign({ url: new URL(ch.url) }, json({ title: title, body: body, ts: nowSec * 1000, source: 'NovaTrade' }));
  }
}

// 各渠道的「业务成功」判定（HTTP 200 不代表发送成功）
function isSuccess(ch, status, bodyText) {
  if (status < 200 || status >= 300) return false;
  let j = null;
  try { j = JSON.parse(bodyText); } catch (e) { /* 非 JSON 响应 */ }
  if (ch.type === 'telegram') return !!(j && j.ok === true);
  if (ch.type === 'feishu') return !!(j && (j.code === 0 || j.StatusCode === 0));
  if (ch.type === 'wecom') return !!(j && j.errcode === 0);
  if (ch.type === 'bark') return !j || j.code === undefined || j.code === 200;
  return true;
}

// 默认传输层：一次 POST，返回 { status, body }
function defaultPost(o) {
  return new Promise((resolve, reject) => {
    const lib = o.url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = lib.request({
      hostname: o.url.hostname, port: o.url.port || (o.url.protocol === 'https:' ? 443 : 80),
      path: o.url.pathname + o.url.search, method: 'POST', agent: o.url.protocol === 'https:' ? o.agent : undefined,
      headers: Object.assign({ 'User-Agent': 'NovaTrade', 'Content-Length': Buffer.byteLength(o.body) }, o.headers)
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 65536) chunks.push(c); });
      res.on('end', () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.setTimeout(o.timeoutMs || 10000, () => req.destroy(new Error('timeout')));
    req.end(o.body);
  });
}

// 错误信息里去掉可能出现的 URL / 令牌
function redact(s) {
  return String(s || '').replace(/https?:\/\/[^\s"')]+/g, '<url>').replace(/(?<!\d)\d{6,}:[A-Za-z0-9_-]{20,}/g, '<token>').slice(0, 160);
}

// deps: { safeStorage, file, post?, getAgent?(useProxy), now?, log? }
function createPush(deps) {
  const post = deps.post || defaultPost;
  const now = deps.now || Date.now;
  const log = deps.log || function () {};
  let channels = [];
  const recent = new Map();     // 去重：title|body -> 时间戳
  let hourStart = now(), hourCount = 0;

  function encryptable() { try { return !!(deps.safeStorage && deps.safeStorage.isEncryptionAvailable()); } catch (e) { return false; } }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.file, 'utf8'));
      if (!raw || raw.v !== 1 || typeof raw.data !== 'string') return;
      if (!encryptable()) return;
      const arr = JSON.parse(deps.safeStorage.decryptString(Buffer.from(raw.data, 'base64')));
      if (Array.isArray(arr)) channels = arr.map(normalizeChannel).filter((r) => r.ok).map((r) => r.channel);
    } catch (e) { /* 没有配置或无法解密：视为未配置 */ }
  }

  function persist() {
    if (!encryptable()) return { ok: false, error: '系统安全存储不可用，无法安全保存推送凭据' };
    const enc = deps.safeStorage.encryptString(JSON.stringify(channels)).toString('base64');
    const tmp = deps.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, data: enc }));
    fs.renameSync(tmp, deps.file);
    return { ok: true };
  }

  function getPublicConfig() {
    return {
      canStore: encryptable(),
      types: Object.keys(TYPES),
      channels: channels.map((c) => {
        const spec = TYPES[c.type], o = { id: c.id, type: c.type, enabled: c.enabled, useProxy: c.useProxy };
        for (const f of spec.fields) o[f] = spec.secret.includes(f) ? mask(c[f]) : c[f];
        return o;
      })
    };
  }

  // cfg: { channels: [...] }。打码占位符 = 保留该渠道该字段原值
  function setConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.channels)) return { ok: false, error: '配置格式不正确' };
    if (cfg.channels.length > MAX_CHANNELS) return { ok: false, error: '最多 ' + MAX_CHANNELS + ' 个渠道' };
    const next = [];
    for (const raw of cfg.channels) {
      const n = normalizeChannel(raw);
      if (!n.ok) return { ok: false, error: n.error };
      const ch = n.channel;
      const old = channels.find((c) => c.id === ch.id && c.type === ch.type);
      for (const f of TYPES[ch.type].fields) {
        if (ch[f].startsWith(MASK)) ch[f] = old ? old[f] : '';
      }
      const err = validateComplete(ch);
      if (err) return { ok: false, error: err };
      next.push(ch);
    }
    const prev = channels;
    channels = next;
    const r = persist();
    if (!r.ok) { channels = prev; return r; }
    return { ok: true, config: getPublicConfig() };
  }

  async function sendOne(ch, msg) {
    try {
      const req = buildRequest(ch, msg, Math.floor(now() / 1000));
      const agent = deps.getAgent ? deps.getAgent(ch.useProxy) : undefined;
      const res = await post({ url: req.url, headers: req.headers, body: req.body, agent: agent, timeoutMs: 10000 });
      if (isSuccess(ch, res.status, res.body)) return { id: ch.id, type: ch.type, ok: true };
      return { id: ch.id, type: ch.type, ok: false, error: 'HTTP ' + res.status + ' ' + redact(res.body) };
    } catch (e) {
      return { id: ch.id, type: ch.type, ok: false, error: redact(e && e.message) };
    }
  }

  // 发送一条通知到所有启用的渠道。带去重（30 秒内相同内容只发一次）与小时上限（防止异常循环刷屏）。
  async function send(m, opts) {
    const o = opts || {};
    const msg = { title: String((m && m.title) || 'NovaTrade').slice(0, MAX_TITLE), body: String((m && m.body) || '').slice(0, MAX_BODY) };
    const targets = channels.filter((c) => c.enabled && (!o.only || c.id === o.only));
    if (!targets.length) return { ok: true, skipped: 'no-channel', results: [] };
    if (!o.bypassLimits) {
      const t = now();
      if (t - hourStart >= 3600e3) { hourStart = t; hourCount = 0; }
      const key = msg.title + '|' + msg.body;
      if (recent.has(key) && t - recent.get(key) < DEDUPE_MS) return { ok: true, skipped: 'duplicate', results: [] };
      if (hourCount >= HOURLY_CAP) { log('[push] hourly cap reached'); return { ok: false, skipped: 'rate-limit', results: [] }; }
      recent.set(key, t); hourCount++;
      for (const [k, ts] of recent) if (t - ts > DEDUPE_MS) recent.delete(k);
    }
    const results = await Promise.all(targets.map((c) => sendOne(c, msg)));
    results.filter((r) => !r.ok).forEach((r) => log('[push] ' + r.type + ' failed: ' + r.error));
    return { ok: results.some((r) => r.ok), results: results };
  }

  function test(id) {
    return send({ title: 'NovaTrade 测试推送', body: '收到这条消息说明该渠道配置正确。' + new Date(now()).toISOString() }, { only: id, bypassLimits: true });
  }

  load();
  return { getPublicConfig, setConfig, send, test, _channels: () => channels };
}

module.exports = { createPush, buildRequest, isSuccess, normalizeChannel, validateComplete, TYPES, MASK };
