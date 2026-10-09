'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---------- 可手动推进时间的假环境 ----------
function fakeEnv() {
  let t = 1000, id = 0;
  const timers = new Map(), intervals = new Map();
  const sockets = [];
  class FakeWS {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    close() { this.closed = true; if (this.onclose) this.onclose({}); }
  }
  return {
    sockets,
    opts: {
      WebSocketImpl: FakeWS, now: () => t, random: () => 0,
      setTimeoutImpl: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id; },
      clearTimeoutImpl: (h) => timers.delete(h),
      setIntervalImpl: (fn, ms) => { intervals.set(++id, { fn, ms, next: t + ms }); return id; },
      clearIntervalImpl: (h) => intervals.delete(h)
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const cand = [...timers.entries()].map(([h, x]) => ({ h, x, at: x.at, kind: 't' }))
          .concat([...intervals.entries()].map(([h, x]) => ({ h, x, at: x.next, kind: 'i' })))
          .filter((c) => c.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!cand) break;
        t = cand.at;
        if (cand.kind === 't') { timers.delete(cand.h); cand.x.fn(); } else { cand.x.next += cand.x.ms; cand.x.fn(); }
      }
      t = end;
    },
    pending: () => timers.size
  };
}

test('ReconnectingWS：断线后按 2s、4s、8s… 指数退避重连，成功后计数清零', () => {
  const env = fakeEnv();
  const statuses = [];
  const ws = E.createReconnectingWS(Object.assign({ url: 'wss://x', onStatus: (s) => statuses.push(s) }, env.opts));
  ws.start();
  assert.equal(env.sockets.length, 1);
  env.sockets[0].onclose({});                       // 连接失败
  assert.equal(ws.state().retry, 1);
  env.advance(1999); assert.equal(env.sockets.length, 1, '2s 之前不应重连');
  env.advance(2);    assert.equal(env.sockets.length, 2);
  env.sockets[1].onclose({});
  env.advance(3999); assert.equal(env.sockets.length, 2);
  env.advance(2);    assert.equal(env.sockets.length, 3);
  env.sockets[2].onopen();                          // 连上了
  assert.equal(ws.state().retry, 0);
  assert.equal(ws.state().status, 'open');
  env.sockets[2].onclose({});
  env.advance(2001); assert.equal(env.sockets.length, 4, '成功后退避从头开始');
});

test('ReconnectingWS：退避封顶 60s；stop() 后不再重连', () => {
  const env = fakeEnv();
  const ws = E.createReconnectingWS(Object.assign({ url: 'wss://x' }, env.opts));
  ws.start();
  for (let i = 0; i < 10; i++) { env.sockets[env.sockets.length - 1].onclose({}); env.advance(61000); }
  assert.equal(env.sockets.length, 11);
  assert.ok(ws.state().retry >= 10);
  ws.stop();
  const n = env.sockets.length;
  env.advance(300000);
  assert.equal(env.sockets.length, n);
  assert.equal(ws.state().status, 'idle');
});

test('ReconnectingWS：已连接但长时间没有消息（半死连接）会被主动断开并重连；有消息则不会', () => {
  const env = fakeEnv();
  const ws = E.createReconnectingWS(Object.assign({ url: 'wss://x', staleMs: 10000, onMessage() {} }, env.opts));
  ws.start();
  env.sockets[0].onopen();
  env.advance(8000); env.sockets[0].onmessage({ data: '[]' });
  env.advance(8000);
  assert.equal(env.sockets[0].closed, false, '期间收到过消息，不应判定为卡死');
  env.advance(20000);
  assert.equal(env.sockets[0].closed, true);
  env.advance(3000);
  assert.equal(env.sockets.length, 2, '应已自动重连');
  assert.equal(ws.healthy(), false);
});

test('applyMiniTickers：只更新有合约的币，按推送计算 24h 涨跌', () => {
  const coins = [
    { symbol: 'BTCUSDT', price: 100, change: 0, volume: 1, hasFutures: true },
    { symbol: 'ETHUSDT', price: 50, change: 0, volume: 1, hasFutures: false },
  ];
  const prices = { BTCUSDT: 100, ETHUSDT: 50 };
  const idx = {};
  const n = E.applyMiniTickers(coins, prices, [
    { s: 'BTCUSDT', c: '110', o: '100', h: '120', l: '90', q: '5000' },
    { s: 'ETHUSDT', c: '60', o: '50', q: '1' },           // 现货币：不处理
    { s: 'NOPEUSDT', c: '1', o: '1' },                     // 不在列表
    { s: 'BTCUSDT', c: 'abc', o: '1' },                    // 脏数据
    null
  ], idx, 12345);
  assert.equal(n, 1);
  assert.equal(coins[0].price, 110);
  assert.equal(prices.BTCUSDT, 110);
  assert.ok(Math.abs(coins[0].change - 10) < 1e-9);
  assert.equal(coins[0].volume, 5000);
  assert.equal(coins[0].high, 120);
  assert.equal(coins[0].rtAt, 12345);
  assert.equal(coins[1].price, 50);
  // 数组被整体替换（重新拉取）后索引会重建
  const coins2 = [{ symbol: 'BTCUSDT', price: 1, change: 0, volume: 1, hasFutures: true }];
  assert.equal(E.applyMiniTickers(coins2, {}, [{ s: 'BTCUSDT', c: '2', o: '1' }], idx), 1);
  assert.equal(coins2[0].price, 2);
});

// ---------- 预警判定 ----------
const A = (extra) => Object.assign({ kind: 'above', value: 100, enabled: true }, extra);

test('alertSatisfied：各类条件与缺数据', () => {
  const s = (a, ctx) => E.alertSatisfied(a, ctx);
  assert.equal(s(A(), { price: 100 }), true);
  assert.equal(s(A(), { price: 99.9 }), false);
  assert.equal(s(A({ kind: 'below' }), { price: 100 }), true);
  assert.equal(s(A({ kind: 'chgUp', value: 5 }), { change: 5.1 }), true);
  assert.equal(s(A({ kind: 'chgDown', value: 5 }), { change: -5 }), true);
  assert.equal(s(A({ kind: 'chgDown', value: 5 }), { change: -4.9 }), false);
  assert.equal(s(A({ kind: 'scoreAbove', value: 65 }), { score: 70 }), true);
  assert.equal(s(A({ kind: 'scoreBelow', value: 38 }), { score: 30 }), true);
  assert.equal(s(A(), null), null);
  assert.equal(s(A(), { price: NaN }), null);
  assert.equal(s(A({ kind: 'scoreAbove', value: 65 }), { price: 1, score: NaN }), null, '没有评分数据时不判');
});

test('一次性预警：满足即触发并停用；旧数据（无 armed 字段）行为不变', () => {
  const r = plain(E.alertStep(A(), { price: 101 }, 5000));
  assert.equal(r.fire, true);
  assert.equal(r.next.enabled, false);
  assert.equal(r.next.triggeredAt, 5000);
  assert.match(r.detail, /≥/);
  assert.equal(plain(E.alertStep(A(), { price: 99 }, 5000)).fire, false);
});

test('穿越语义：创建时已满足 → 先不触发，离开满足区后重新进入才触发', () => {
  const a = A({ armed: E.alertInitialArmed(A(), { price: 105 }) });
  assert.equal(a.armed, false);
  let r = plain(E.alertStep(a, { price: 110 }, 1));
  assert.equal(r.fire, false, '一直满足时不触发');
  assert.deepEqual(r.next, {});
  r = plain(E.alertStep(a, { price: 95 }, 2));           // 离开满足区 → 武装
  assert.equal(r.fire, false);
  assert.deepEqual(r.next, { armed: true });
  Object.assign(a, r.next);
  r = plain(E.alertStep(a, { price: 101 }, 3));
  assert.equal(r.fire, true);
  assert.equal(E.alertInitialArmed(A(), { price: 90 }), true, '创建时未满足 → 直接武装');
  assert.equal(E.alertInitialArmed(A(), null), true, '取不到行情时按已武装处理');
});

test('重复预警：冷却期内不重复；触发后需离开再进入；触发计数累加；保持启用', () => {
  const a = A({ repeat: true, cooldownMin: 10, armed: true });
  let r = plain(E.alertStep(a, { price: 101 }, 1000000));
  assert.equal(r.fire, true);
  assert.equal(r.next.enabled, undefined, '重复预警不应被停用');
  assert.equal(r.next.armed, false);
  assert.equal(r.next.fireCount, 1);
  Object.assign(a, r.next);
  assert.equal(plain(E.alertStep(a, { price: 120 }, 1000001)).fire, false, '持续满足不再触发');
  Object.assign(a, plain(E.alertStep(a, { price: 90 }, 1000002)).next);   // 离开 → 重新武装
  assert.equal(a.armed, true);
  assert.equal(plain(E.alertStep(a, { price: 101 }, 1000000 + 5 * 60000)).fire, false, '冷却 10 分钟未到');
  r = plain(E.alertStep(a, { price: 101 }, 1000000 + 11 * 60000));
  assert.equal(r.fire, true);
  assert.equal(r.next.fireCount, 2);
});

test('评分类预警文案', () => {
  const r = plain(E.alertStep(A({ kind: 'scoreAbove', value: 65, armed: true }), { score: 71.4 }, 1));
  assert.equal(r.fire, true);
  assert.match(r.detail, /评分 71 ≥ 65/);
});
