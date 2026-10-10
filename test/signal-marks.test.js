'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('../bt/engine');

const E = loadEngine({ console: { log() {}, warn() {}, error() {} } });
const plain = (v) => JSON.parse(JSON.stringify(v));
const H = 3600;
const times = Array.from({ length: 10 }, (_, i) => 1700000000 + i * H);   // 10 根 1h K 线（秒）
const ms = (sec) => sec * 1000;

test('信号落在包含它的那根 K 线上；方向 / 颜色 / 文字正确', () => {
  const recs = [
    { ts: ms(times[2] + 600), symbol: 'BTCUSDT', dir: 'long', score: 68.4, gated: true, r4h: { hit: true } },
    { ts: ms(times[5] + 10), symbol: 'BTCUSDT', dir: 'short', score: 33, gated: false, r4h: { hit: false } },
    { ts: ms(times[7]), symbol: 'BTCUSDT', dir: 'long', score: 66, gated: true, r4h: null },
    { ts: ms(times[8]), symbol: 'ETHUSDT', dir: 'long', score: 70, gated: true, r4h: null }
  ];
  const m = plain(E.sgMarks(recs, [], times, { symbol: 'BTCUSDT', colors: { up: 'G', down: 'R', neutral: 'N', accent: 'A' } }));
  assert.deepEqual(m.map((x) => [x.time, x.position, x.shape, x.color, x.text]), [
    [times[2], 'belowBar', 'arrowUp', 'G', '多68✓'],
    [times[5], 'aboveBar', 'arrowDown', 'R', '拦空33✗'],
    [times[7], 'belowBar', 'arrowUp', 'N', '多66…']
  ]);
});

test('范围外的信号被忽略；同一根 K 线同方向只保留最新一条；焦点信号放大', () => {
  const recs = [
    { ts: ms(times[0] - 10), symbol: 'X', dir: 'long', score: 70 },             // 早于第一根
    { ts: ms(times[9] + 2 * H), symbol: 'X', dir: 'long', score: 70 },          // 晚于最后一根
    { ts: ms(times[3] + 1), symbol: 'X', dir: 'long', score: 66 },
    { ts: ms(times[3] + 99), symbol: 'X', dir: 'long', score: 67 },
    { ts: ms(times[3] + 50), symbol: 'X', dir: 'short', score: 30 }
  ];
  const m = plain(E.sgMarks(recs, [], times, { symbol: 'X' }));
  assert.equal(m.length, 2);
  assert.equal(m.find((x) => x.shape === 'arrowUp').text, '多67…', '同一根同方向保留最新一条');
  const f = plain(E.sgMarks(recs, [], times, { symbol: 'X', focusTs: ms(times[3] + 1) }));
  const up = f.find((x) => x.shape === 'arrowUp');
  assert.equal(up.text, '多66…', '焦点信号优先显示');
  assert.equal(up.size, 2);
});

test('模拟跟踪也会标出；按时间升序；K 线不足时返回空', () => {
  const m = plain(E.sgMarks(
    [{ ts: ms(times[6]), symbol: 'X', dir: 'long', score: 70 }],
    [{ symbol: 'X', direction: 'short', createdAt: ms(times[4] + 5), status: 'invalid' }],
    times, { symbol: 'X' }));
  assert.deepEqual(m.map((x) => x.text), ['模拟止损', '多70…']);
  assert.equal(m[0].shape, 'circle');
  assert.deepEqual(plain(E.sgMarks([], [], [times[0]], { symbol: 'X' })), []);
});
