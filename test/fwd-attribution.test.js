'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));

// 生成记录：dir、是否放行、gates、1h/4h 是否命中
let id = 0;
function rec(dir, gated, gates, h1, h4, pct4) {
  return { ts: ++id, dir, gated, gates, r1h: h1 === null ? null : { hit: h1, pct: 0.1 }, r4h: { hit: h4, pct: pct4 === undefined ? (h4 === (dir === 'long') ? 1 : -1) : pct4 } };
}
const longPass = { overheat: false, dailyOK: true, stopCapVeto: false };
const longOverheat = { overheat: true, dailyOK: true, stopCapVeto: false };
const longOverheatDaily = { overheat: true, dailyOK: false, stopCapVeto: false };
const shortPass = { score39: true, dailyOK: true, btcVeto: false, nearSupVeto: false, stopCapVeto: false };
const short39 = { score39: false, dailyOK: true, btcVeto: false, nearSupVeto: false, stopCapVeto: false };
const rep = (n, f) => Array.from({ length: n }, f);

test('faWilson：边界与常见值', () => {
  assert.equal(E.faWilson(0, 0), null);
  const c = plain(E.faWilson(50, 100));
  assert.ok(c.lo > 40 && c.lo < 41 && c.hi > 59 && c.hi < 60);
  const z = plain(E.faWilson(0, 10));
  assert.equal(z.lo, 0);
  assert.ok(z.hi > 25 && z.hi < 35);
});

test('被拦截的明显更好 → harmful；明显更差 → useful；接近 → unclear；样本少 → insufficient', () => {
  // 多头：放行 40 笔命中 12 笔（30%）；过热区单独拦下 40 笔命中 32 笔（80%）
  const recs = [].concat(
    rep(40, (_, i) => rec('long', true, longPass, i % 2 === 0, i < 12)),
    rep(40, (_, i) => rec('long', false, longOverheat, true, i < 32)),
    rep(5, () => rec('long', false, longOverheatDaily, true, true)),          // 同时被两道门控拦截：只计入 any，不计入 only
    // 空头：放行 30 笔命中 24 笔（80%）；评分门槛拦下 30 笔命中 6 笔（20%）
    rep(30, (_, i) => rec('short', true, shortPass, true, i < 24)),
    rep(30, (_, i) => rec('short', false, short39, false, i < 6))
  );
  const A = plain(E.faAttribution(recs));
  assert.equal(A.total, recs.length);
  const L = A.dirs.long, S = A.dirs.short;
  assert.equal(L.passed.n, 40);
  assert.equal(Math.round(L.passed.h4Rate), 30);
  const oh = L.gates.find((g) => g.key === 'overheat');
  assert.equal(oh.any.n, 45);
  assert.equal(oh.only.n, 40, '同时被日线门控拦截的不计入「仅被过热区拦截」');
  assert.equal(oh.verdict, 'harmful');
  assert.equal(L.gates.find((g) => g.key === 'dailyL').only.n, 0);
  assert.equal(L.gates.find((g) => g.key === 'dailyL').verdict, 'insufficient');
  assert.equal(S.gates.find((g) => g.key === 'score39').verdict, 'useful');
  assert.equal(S.overall, 'useful');

  const close = [].concat(rep(30, (_, i) => rec('long', true, longPass, true, i < 15)), rep(30, (_, i) => rec('long', false, longOverheat, true, i < 17)));
  assert.equal(plain(E.faAttribution(close)).dirs.long.gates.find((g) => g.key === 'overheat').verdict, 'unclear');
  const few = [].concat(rep(5, () => rec('long', true, longPass, true, true)), rep(5, () => rec('long', false, longOverheat, true, true)));
  assert.equal(plain(E.faAttribution(few)).dirs.long.gates.find((g) => g.key === 'overheat').verdict, 'insufficient');
});

test('1h/4h 一致性分布、方向收益（空单按价格下跌为正）', () => {
  const recs = [
    rec('long', true, longPass, true, true, 2), rec('long', true, longPass, true, false, -1),
    rec('long', true, longPass, false, false, -2), rec('long', true, longPass, null, true, 1),
    rec('short', true, shortPass, true, true, -3)
  ];
  const A = plain(E.faAttribution(recs));
  const p = A.dirs.long.passed;
  assert.equal(p.n, 4);
  assert.equal(Math.round(p.bothHit), 33);
  assert.equal(Math.round(p.mixed), 33);
  assert.equal(Math.round(p.bothMiss), 33);
  assert.equal(p.avgRet4h, 0);
  assert.equal(A.dirs.short.passed.avgRet4h, 3, '空单价格跌 3% 记为 +3%');
});

test('忽略没有 gates / 4h 未结算 / 方向非法的记录', () => {
  const recs = [
    { ts: 1, dir: 'long', gated: true, r4h: { hit: true, pct: 1 } },
    { ts: 2, dir: 'long', gated: true, gates: longPass, r4h: null },
    { ts: 3, dir: 'flat', gated: true, gates: longPass, r4h: { hit: true, pct: 1 } },
    rec('long', true, longPass, true, true)
  ];
  assert.equal(plain(E.faAttribution(recs)).total, 1);
});

// ---------- 随机基线 ----------
function mk(dir, up, gated, pct, btcPct) {
  const hit = dir === 'long' ? up : !up;
  return { ts: ++id, dir, gated: gated !== false, gates: {}, r4h: { hit, pct: pct === undefined ? (up ? 1 : -1) : pct, btcPct } };
}

test('faBaseline：方向判断完全正确 → p 值很小；方向随机 → p 值不小', () => {
  // 一半上涨一半下跌，信号每次都猜对
  const perfect = [].concat(rep(30, () => mk('long', true)), rep(30, () => mk('short', false)));
  const b = plain(E.faBaseline(perfect, { rng: E.faRng(1), iters: 2000 }));
  assert.equal(b.n, 60);
  assert.equal(b.hitRate, 100);
  assert.ok(b.pValue < 0.01, 'p=' + b.pValue);
  assert.ok(Math.abs(b.randMean - 50) < 5, '随机方向命中率约 50%，实际 ' + b.randMean);
  assert.equal(b.allLongRate, 50);
  // 方向与涨跌无关：多空各半，涨跌各半，交叉均匀
  const noise = [].concat(rep(15, () => mk('long', true)), rep(15, () => mk('long', false)), rep(15, () => mk('short', true)), rep(15, () => mk('short', false)));
  const c = plain(E.faBaseline(noise, { rng: E.faRng(2), iters: 2000 }));
  assert.equal(c.hitRate, 50);
  assert.ok(c.pValue > 0.3, 'p=' + c.pValue);
});

test('faBaseline：只是赶上涨行情的「全做多」信号，命中率高但 p 值不显著', () => {
  // 80% 的记录上涨，信号全部做多 → 命中 80%，但随机打乱（全是多单）也是 80%
  const recs = [].concat(rep(40, () => mk('long', true)), rep(10, () => mk('long', false)));
  const b = plain(E.faBaseline(recs, { rng: E.faRng(3), iters: 1000 }));
  assert.equal(b.hitRate, 80);
  assert.equal(b.allLongRate, 80);
  assert.equal(b.randMean, 80);
  assert.ok(b.pValue > 0.5, '没有方向选择可言：p=' + b.pValue);
});

test('faBaseline：只统计放行、相对 BTC 超额（空单取反）', () => {
  const recs = [mk('long', true, true, 3, 1), mk('short', false, true, -2, -4), mk('long', true, false, 5, 0), mk('long', false, true, -1)];
  const b = plain(E.faBaseline(recs, { onlyPassed: true, rng: E.faRng(4), iters: 100 }));
  assert.equal(b.n, 3);
  assert.equal(b.excessN, 2, '缺 btcPct 的记录不计入超额');
  // 多单 3−1 = +2；空单 −(−2 − (−4)) = −2 → 平均 0，跑赢 50%
  assert.equal(b.excessAvg, 0);
  assert.equal(b.excessHit, 50);
  assert.equal(plain(E.faBaseline([], {})).n, 0);
});
