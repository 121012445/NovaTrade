'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBinanceHttp, HttpError } = require('../main/binance-http');

// 构造假的传输层：按主机返回预设响应（或抛网络错误），并记录调用顺序
function fakeTransport(script) {
  const calls = [];
  const request = async (o) => {
    calls.push(o.host + o.path);
    const step = typeof script === 'function' ? script(o, calls.length) : script[o.host];
    if (step instanceof Error) throw step;
    return step;
  };
  return { request, calls };
}
const ok = (obj) => ({ status: 200, headers: {}, body: JSON.stringify(obj) });
const resp = (status, body, headers) => ({ status, headers: headers || {}, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('2xx：返回解析后的 JSON', async () => {
  const t = fakeTransport({ a: ok([1, 2, 3]) });
  const h = createBinanceHttp({ request: t.request });
  assert.deepEqual(await h.requestJson({ family: 'f', hosts: ['a'], path: '/x' }), [1, 2, 3]);
});

test('4xx 业务错误（如 -1121 非法交易对）：直接抛出，不再换主机', async () => {
  const t = fakeTransport({ a: resp(400, { code: -1121, msg: 'Invalid symbol.' }), b: ok([]) });
  const h = createBinanceHttp({ request: t.request });
  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a', 'b'], path: '/x' }), (e) => {
    assert.ok(e instanceof HttpError);
    assert.equal(e.kind, 'client');
    assert.equal(e.code, -1121);
    assert.match(e.message, /Invalid symbol/);
    return true;
  });
  assert.equal(t.calls.length, 1, '不应继续请求第二个主机');
});

test('429：抛出限流错误并进入退避，退避期内的请求不再发出', async () => {
  let clock = 1000;
  const t = fakeTransport({ a: resp(429, {}, { 'retry-after': '7' }), b: ok([]) });
  const h = createBinanceHttp({ request: t.request, now: () => clock });
  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a', 'b'], path: '/x' }), (e) => {
    assert.equal(e.kind, 'ratelimit');
    assert.equal(e.retryAfterMs, 7000);
    return true;
  });
  assert.equal(t.calls.length, 1, '限流按 IP 计，不应换主机');
  assert.equal(h.backoffRemaining('f'), 7000);

  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a'], path: '/y' }), (e) => e.kind === 'ratelimit');
  assert.equal(t.calls.length, 1, '退避期内不应真正发请求');

  // 其他类别的接口不受影响
  assert.deepEqual(await h.requestJson({ family: 'other', hosts: ['b'], path: '/z' }), []);

  clock += 7001;   // 退避结束后恢复
  assert.equal(h.backoffRemaining('f'), 0);
});

test('418（IP 被封）：退避时间比 429 更长，且有上限', async () => {
  const t = fakeTransport({ a: resp(418, {}, {}) });
  const h = createBinanceHttp({ request: t.request, now: () => 0 });
  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a'], path: '/x' }), (e) => e.kind === 'ratelimit' && e.retryAfterMs === 60000);
  const t2 = fakeTransport({ a: resp(429, {}, { 'retry-after': '99999' }) });
  const h2 = createBinanceHttp({ request: t2.request, now: () => 0 });
  await assert.rejects(h2.requestJson({ family: 'f', hosts: ['a'], path: '/x' }), (e) => e.retryAfterMs === 5 * 60 * 1000);
});

test('5xx / 网络错误 / 非 JSON：换下一个主机重试', async () => {
  const t = fakeTransport({
    a: resp(502, 'Bad Gateway'),
    b: new Error('ECONNRESET'),
    c: resp(200, '<html>not json</html>'),
    d: ok({ ok: true })
  });
  const h = createBinanceHttp({ request: t.request });
  assert.deepEqual(await h.requestJson({ family: 'f', hosts: ['a', 'b', 'c', 'd'], path: '/x' }), { ok: true });
  assert.deepEqual(t.calls, ['a/x', 'b/x', 'c/x', 'd/x']);
});

test('所有主机都失败：抛出最后一个错误', async () => {
  const t = fakeTransport({ a: new Error('timeout'), b: resp(503, 'x') });
  const h = createBinanceHttp({ request: t.request });
  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a', 'b'], path: '/x' }), (e) => e.kind === 'server');
});

test('451（地区限制）按业务错误处理，不重试', async () => {
  const t = fakeTransport({ a: resp(451, 'Service unavailable from a restricted location'), b: ok([]) });
  const h = createBinanceHttp({ request: t.request });
  await assert.rejects(h.requestJson({ family: 'f', hosts: ['a', 'b'], path: '/x' }), (e) => e.kind === 'client' && e.status === 451);
  assert.equal(t.calls.length, 1);
});

test('相同请求在途时合并为一次；完成后不缓存', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const h = createBinanceHttp({ request: async () => { n++; await gate; return ok({ n }); } });
  const p1 = h.requestJson({ family: 'f', hosts: ['a'], path: '/same' });
  const p2 = h.requestJson({ family: 'f', hosts: ['a'], path: '/same' });
  const p3 = h.requestJson({ family: 'f', hosts: ['a'], path: '/diff' });
  release();
  const [r1, r2] = await Promise.all([p1, p2, p3]);
  assert.deepEqual(r1, r2);
  assert.equal(n, 2, '/same 合并成一次，/diff 单独一次');
  await h.requestJson({ family: 'f', hosts: ['a'], path: '/same' });
  assert.equal(n, 3, '完成后的再次请求应重新发出');
});

test('代理变化后不复用旧代理下的在途请求', async () => {
  let n = 0;
  const h = createBinanceHttp({ request: async () => { n++; return ok({}); } });
  await Promise.all([
    h.requestJson({ family: 'f', hosts: ['a'], path: '/x', proxyKey: 'direct' }),
    h.requestJson({ family: 'f', hosts: ['a'], path: '/x', proxyKey: 'http://127.0.0.1:7890' })
  ]);
  assert.equal(n, 2);
});

test('同类接口并发数受限', async () => {
  let running = 0, peak = 0;
  const h = createBinanceHttp({
    maxConcurrent: 3,
    request: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return ok({}); }
  });
  await Promise.all(Array.from({ length: 12 }, (_, i) => h.requestJson({ family: 'f', hosts: ['a'], path: '/p' + i })));
  assert.equal(peak, 3);
});
