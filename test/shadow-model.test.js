'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));

let seed = 99;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; };

// 合成数据：命中概率只依赖 conv（第 3 个特征）和 dv（第 11 个特征），其余是噪声
function synth(n, signal) {
  return Array.from({ length: n }, (_, i) => {
    const f = Array.from({ length: E.SM_FEATURES.length }, () => rnd());
    const z = signal ? 3 * (f[2] - 0.5) + 2 * (f[10] - 0.5) : 0;
    const hit = rnd() < 1 / (1 + Math.exp(-z));
    return { ts: i, feat: f, r4h: { hit } };
  });
}

test('smFeatures：长度固定、范围合理、缺失字段不抛错', () => {
  const a = { score: 72, indicators: { adx: '31.2', rsi: '61.5' }, volRatio: 2, change: -3, tfData: [{ interval: '15m', analysis: { score: 60 } }, { interval: '4h', analysis: { score: 80 } }] };
  const f = plain(E.smFeatures(a, { btcScore: 55, dv: 2 }));
  assert.equal(f.length, E.SM_FEATURES.length);
  assert.ok(Math.abs(f[0] - 0.72) < 1e-9);
  assert.equal(f[1], 1);
  assert.ok(Math.abs(f[2] - 0.44) < 1e-9);
  assert.ok(Math.abs(f[6] - 0.6) < 1e-9 && Math.abs(f[8] - 0.8) < 1e-9);
  assert.equal(f[7], 0.5, '缺失的周期用中性值');
  assert.ok(f.every((v) => Number.isFinite(v) && v >= -1 && v <= 1.0001));
  const empty = plain(E.smFeatures({}, {}));
  assert.equal(empty.length, E.SM_FEATURES.length);
  assert.ok(empty.every(Number.isFinite));
  assert.equal(plain(E.smFeatures({ score: 30 }))[1], -1, '空头方向为 -1');
});

test('smAuc：完美 / 随机 / 反向 / 平局 / 单一类别', () => {
  assert.equal(E.smAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(E.smAuc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0);
  assert.equal(E.smAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.equal(E.smAuc([0.1, 0.2], [1, 1]), null);
});

test('smTrain：能学到有信号的数据（样本外 AUC 明显高于 0.5），且概率在 (0,1)', () => {
  const rows = synth(1200, true).map((r) => ({ x: r.feat, y: r.r4h.hit ? 1 : 0 }));
  const model = E.smTrain(rows.slice(0, 800));
  const base = rows.slice(0, 800).reduce((s, r) => s + r.y, 0) / 800;
  const ev = plain(E.smEvaluate(model, rows.slice(800), base));
  assert.ok(ev.auc > 0.65, 'AUC ' + ev.auc);
  assert.ok(ev.brier < ev.baselineBrier, 'Brier 应优于基线 ' + ev.brier + ' vs ' + ev.baselineBrier);
  rows.slice(0, 50).forEach((r) => { const p = E.smPredict(model, r.x); assert.ok(p > 0 && p < 1); });
});

test('smFit：有信号的数据 → ready；纯噪声 → 不 ready（避免把运气当规律）；样本不足 → 提示积累中', () => {
  seed = 7;
  const good = plain(E.smFit(synth(1200, true)));
  assert.equal(good.ready, true, good.reason + ' ' + JSON.stringify(good.oos));
  assert.equal(good.n, 1200);
  assert.ok(good.oos.auc >= 0.55);
  seed = 1234;
  const noise = plain(E.smFit(synth(1200, false)));
  assert.equal(noise.ready, false, '纯噪声不应被判定有效：' + JSON.stringify(noise.oos));
  const few = plain(E.smFit(synth(40, true)));
  assert.equal(few.ready, false);
  assert.match(few.reason, /样本积累中（40 \/ 150）/);
  assert.equal(few.model, null);
});

test('smFit：忽略没有特征 / 未结算 / 特征长度不对的记录；按时间排序切分', () => {
  const recs = synth(200, true);
  recs.push({ ts: 999, r4h: { hit: true } }, { ts: 1000, feat: [1, 2], r4h: { hit: true } }, { ts: 1001, feat: recs[0].feat, r4h: null });
  assert.equal(plain(E.smFit(recs)).n, 200);
});
