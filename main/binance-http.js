'use strict';
// 币安（及同类 REST）JSON 请求层。
//
// 为什么单独成文件：
// 1. 旧实现只做 JSON.parse、不看 HTTP 状态码 —— 429/418（限流）、400（-1121 非法交易对）、
//    451（地区限制）这类错误体本身也是合法 JSON，会被当成"成功数据"返回，
//    导致「合约失败 → 回退现货」的兜底永远不触发，限流时还会继续猛打接口。
// 2. spot / futures / klines / generic 四套请求代码几乎一样，集中后只需维护一份。
// 3. 传输层（request）可注入，方便脱离真实网络做单元测试。
const https = require('https');

const MAX_BODY_BYTES = 32 * 1024 * 1024;   // 单次响应上限，防止异常大包撑爆内存
const MAX_BACKOFF_MS = 5 * 60 * 1000;      // 限流退避上限

class HttpError extends Error {
  // kind: 'ratelimit' | 'client' | 'server' | 'parse' | 'network'
  constructor(message, info) {
    super(message);
    this.name = 'HttpError';
    const i = info || {};
    this.kind = i.kind || 'network';
    this.status = i.status || 0;
    this.code = i.code;                    // 币安业务错误码，如 -1121
    this.retryAfterMs = i.retryAfterMs || 0;
  }
}

// 默认传输层：一次 GET，返回 { status, headers, body }。超时 / 断连 / 超大响应都会 reject。
function defaultRequest(o) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.get({
      hostname: o.host, port: 443, path: o.path, method: 'GET', agent: o.agent,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => done(resolve, {
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', (e) => done(reject, e));
      res.on('close', () => done(reject, new Error('connection closed before response completed')));
    });
    req.on('error', (e) => done(reject, e));
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error('timeout after ' + o.timeoutMs + 'ms')));
  });
}

// 简单信号量：限制同一类接口的并发请求数，避免瞬间打出几十个请求触发限流
class Semaphore {
  constructor(n) { this.n = n; this.queue = []; }
  acquire() {
    if (this.n > 0) { this.n--; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.n++;
  }
}

function parseRetryAfter(headers) {
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  const sec = parseInt(raw, 10);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

function describeClientError(status, body) {
  try {
    const j = JSON.parse(body);
    if (j && (j.code !== undefined || j.msg)) return { code: j.code, text: 'Binance ' + j.code + ': ' + j.msg };
  } catch (e) { /* 非 JSON 错误体 */ }
  return { code: undefined, text: 'HTTP ' + status };
}

function createBinanceHttp(options) {
  const o = options || {};
  const log = o.log || function () {};
  const now = o.now || Date.now;
  const request = o.request || defaultRequest;
  const maxConcurrent = o.maxConcurrent || 16;

  const backoffUntil = new Map();   // family -> 解封时间戳
  const inflight = new Map();       // 去重表：相同请求在途时直接复用同一个 Promise
  const semaphores = new Map();     // family -> Semaphore

  function sem(family) {
    let s = semaphores.get(family);
    if (!s) { s = new Semaphore(maxConcurrent); semaphores.set(family, s); }
    return s;
  }

  function setBackoff(family, status, headers) {
    // 币安：429 = 触发限流（按 Retry-After 退避）；418 = 继续请求被封 IP（退避更久）
    const fallback = status === 418 ? 60000 : 10000;
    const ms = Math.min(MAX_BACKOFF_MS, parseRetryAfter(headers) || fallback);
    backoffUntil.set(family, now() + ms);
    log('[http] rate limited family=' + family + ' status=' + status + ' backoff=' + ms + 'ms');
    return ms;
  }

  async function runHosts(opt) {
    const timeoutMs = opt.timeoutMs || 10000;
    let lastErr = null;
    for (const host of opt.hosts) {
      try {
        const r = await request({ host, path: opt.path, agent: opt.agent, timeoutMs });
        const st = r.status;
        if (st >= 200 && st < 300) {
          try { return JSON.parse(r.body); }
          catch (e) { lastErr = new HttpError('invalid JSON from ' + host, { kind: 'parse', status: st }); continue; }
        }
        if (st === 429 || st === 418) {
          const ms = setBackoff(opt.family, st, r.headers);
          // 限流是按 IP 计的，换主机没有意义，立即停止并把等待时间告诉调用方
          throw new HttpError('Binance rate limited (HTTP ' + st + '), retry in ' + Math.ceil(ms / 1000) + 's',
            { kind: 'ratelimit', status: st, retryAfterMs: ms });
        }
        if (st >= 500) { lastErr = new HttpError('HTTP ' + st + ' from ' + host, { kind: 'server', status: st }); continue; }
        // 其余 4xx：参数 / 交易对 / 地区限制（451）等，换主机也不会好，直接抛出业务错误
        const d = describeClientError(st, r.body);
        throw new HttpError(d.text, { kind: 'client', status: st, code: d.code });
      } catch (e) {
        if (e instanceof HttpError && (e.kind === 'ratelimit' || e.kind === 'client')) throw e;
        lastErr = e;   // 超时 / 断连 / 5xx / 解析失败：换下一个主机
        log('[http] ' + opt.family + ' ' + host + ' failed: ' + (e && e.message));
      }
    }
    throw lastErr || new HttpError('no hosts configured', { kind: 'network' });
  }

  // opt: { family, hosts[], path, agent, proxyKey, timeoutMs }
  //   family   —— 限流 / 并发的分组（'spot' | 'futures' | 'generic:host'）
  //   proxyKey —— 当前代理标识，仅用于去重键（代理变了就不应复用旧请求）
  function requestJson(opt) {
    const until = backoffUntil.get(opt.family) || 0;
    const t = now();
    if (t < until) {
      return Promise.reject(new HttpError('Binance rate limited, retry in ' + Math.ceil((until - t) / 1000) + 's',
        { kind: 'ratelimit', status: 429, retryAfterMs: until - t }));
    }
    const key = opt.family + '|' + (opt.proxyKey || 'direct') + '|' + opt.path;
    const existing = inflight.get(key);
    if (existing) return existing;
    const s = sem(opt.family);
    const p = (async () => {
      await s.acquire();
      try { return await runHosts(opt); }
      finally { s.release(); }
    })();
    inflight.set(key, p);
    const clear = () => { if (inflight.get(key) === p) inflight.delete(key); };
    p.then(clear, clear);
    return p;
  }

  return {
    requestJson,
    // 供调试 / 测试：查询某类接口当前是否处于限流退避中（返回剩余毫秒）
    backoffRemaining: (family) => Math.max(0, (backoffUntil.get(family) || 0) - now())
  };
}

module.exports = { createBinanceHttp, HttpError, defaultRequest };
