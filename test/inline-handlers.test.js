'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const IH = require('../renderer/lib/inline-handlers.js');

const RENDERER = path.resolve(__dirname, '..', 'renderer');

function exec(src, extra) {
  const calls = [];
  const win = Object.assign({
    showView: (...a) => calls.push(['showView', ...a]),
    toggleWatch: (...a) => calls.push(['toggleWatch', ...a]),
    whaleMinChange: (...a) => calls.push(['whaleMinChange', ...a]),
    electronAPI: { close() { calls.push(['close', this === win.electronAPI]); } },
    console: { error() {} }
  }, extra || {});
  const ev = { key: 'Enter', stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
  const el = { value: '123', checked: true };
  const res = IH.run(IH.parseProgram(src), el, ev, win);
  return { calls, ev, res };
}

test('常见写法：带字符串 / 数字参数的调用', () => {
  assert.deepEqual(exec("showView('analysis')").calls, [['showView', 'analysis']]);
  assert.deepEqual(exec('showView("a b")').calls, [['showView', 'a b']]);
  assert.deepEqual(exec("toggleWatch('BTCUSDT', 12, -3.5, 1e-7, true, null)").calls, [['toggleWatch', 'BTCUSDT', 12, -3.5, 1e-7, true, null]]);
});

test('字符串转义：\\\' \\" \\\\ \\uXXXX', () => {
  assert.deepEqual(exec("toggleWatch('it\\'s')").calls[0].slice(1), ["it's"]);
  assert.deepEqual(exec("toggleWatch('a\\\"b')").calls[0].slice(1), ['a"b']);
  assert.deepEqual(exec("toggleWatch('a\\\\b')").calls[0].slice(1), ['a\\b']);
  assert.deepEqual(exec("toggleWatch('\\u003cb\\u003e')").calls[0].slice(1), ['<b>']);
  assert.deepEqual(exec("toggleWatch('a;b)(c')").calls[0].slice(1), ['a;b)(c'], '字符串里的 ; 和括号不影响切分');
});

test('this.value / this.checked / event / window. 前缀 / 点路径', () => {
  assert.deepEqual(exec('whaleMinChange(this.value)').calls, [['whaleMinChange', '123']]);
  assert.deepEqual(exec('window.electronAPI.close()').calls, [['close', true]]);
  assert.deepEqual(exec('toggleWatch(this.checked)').calls, [['toggleWatch', true]]);
});

test('多条语句与 event.stopPropagation / preventDefault', () => {
  const r = exec("event.stopPropagation();toggleWatch('X')");
  assert.equal(r.ev.stopped, true);
  assert.equal(r.res.stopped, true);
  assert.deepEqual(r.calls, [['toggleWatch', 'X']]);
  assert.equal(exec('event.preventDefault()').ev.prevented, true);
});

test('if(event.key===…){…}：只在按键匹配时执行', () => {
  const src = "if(event.key==='Enter'){event.preventDefault();showView('go');}";
  const hit = exec(src);
  assert.deepEqual(hit.calls, [['showView', 'go']]);
  assert.equal(hit.ev.prevented, true);
  const win = { showView() { throw new Error('should not run'); } };
  const ev = { key: 'a', preventDefault() { throw new Error('no'); } };
  IH.run(IH.parseProgram(src), {}, ev, win);
});

test('不在文法内的写法一律拒绝，不会被执行', () => {
  const bad = [
    'alert(document.cookie)+1',
    "fetch('http://evil')",                // 解析能过，但 window 上没有该函数时执行失败（见下）
    'a.b = 1',
    "x(function(){})",
    "x(1+2)",
    "x(document)",
    'eval("1")',
    'window.constructor("return 1")()',
    "toggleWatch.constructor('return 1')()",
    'a.__proto__.x()',
    'event.target.remove()',
    'foo(',
    "foo('unterminated)",
    'foo(1,)'
  ];
  for (const b of bad) {
    let threw = false;
    try { exec(b); } catch (e) { threw = true; }
    assert.ok(threw, '应当拒绝：' + b);
  }
});

test('不能调用浏览器内置的原生函数，点路径只允许 electronAPI.*', () => {
  const ev = { stopPropagation() {}, preventDefault() {} };
  const win = { isNaN, parseInt, document: { write() {} }, electronAPI: { ok() {} }, other: { x() {} } };
  assert.throws(() => IH.run(IH.parseProgram("isNaN('x')"), {}, ev, win), /native function/);
  assert.throws(() => IH.run(IH.parseProgram("parseInt('1')"), {}, ev, win), /native function/);
  assert.throws(() => IH.run(IH.parseProgram("document.write('x')"), {}, ev, win), /electronAPI/);
  assert.throws(() => IH.run(IH.parseProgram('other.x()'), {}, ev, win), /electronAPI/);
  assert.doesNotThrow(() => IH.run(IH.parseProgram('electronAPI.ok()'), {}, ev, win));
});

test('只能调用 window 上已有的函数', () => {
  assert.throws(() => exec("doesNotExist('x')"), /not a function|cannot resolve/);
  assert.throws(() => exec('electronAPI.nope()'), /not a function/);
});

test('index.html 里的静态内联处理器全部可解析', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const found = [...html.matchAll(/\bon(?:click|change|input|keydown)="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  assert.ok(found.length > 20, '应找到若干静态处理器，实际 ' + found.length);
  for (const f of found) assert.doesNotThrow(() => IH.parseProgram(f), f);
});

test('app.js 中拼接的处理器文本（还原 JS 字符串转义后）全部可解析', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  // 取出 onclick="…" 片段：先处理 JS 层 \' 与 \" 转义，再把 '+ expr +' 拼接位置替换成占位值
  const found = [...src.matchAll(/\bon(?:click|change|input|keydown)=(?:\\)?"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(found.length > 20, '应找到若干处理器，实际 ' + found.length);
  let checked = 0;
  for (let t of found) {
    // 形如 openLinkedCoin(' " + expr + " ') 的写法会在字符串字面量处被正则截断，这类片段无法静态还原，交给浏览器集成测试覆盖
    if ((t.match(/'/g) || []).length % 2 === 1 && !/\\'/.test(t)) continue;
    t = t.replace(/\\$/, '').replace(/\\'/g, "'")                                  // JS 源码里的 \'
      .replace(/'\s*\+\s*[^+]+?\s*\+\s*'/g, 'X')                // '… + expr + '…  →  X
      .replace(/\$\{[^}]*\}/g, '1');                            // 模板字面量插值 → 数字
    assert.doesNotThrow(() => IH.parseProgram(t), t);
    checked++;
  }
  assert.ok(checked > 20, '实际解析了 ' + checked + ' 个');
});
