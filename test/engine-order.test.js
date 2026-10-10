'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIB_ORDER, RENDERER } = require('../bt/engine');

const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

test('index.html 按 bt/engine.js 的 LIB_ORDER 顺序加载 lib 脚本，最后才是 app.js', () => {
  const srcs = [...html.matchAll(/<script\s+src="?([^"\s>]+)"?\s*>\s*<\/script>/g)].map((m) => m[1]);
  const mine = srcs.filter((s) => s.startsWith('lib/') || s === 'app.js' || s === 'settings.js' || s === 'radar.js' || s === 'fills-view.js');
  // inline-handlers 只依赖 DOM，不进 Node 引擎；它必须在 app.js 之前加载
  assert.deepEqual(mine, LIB_ORDER.concat(['lib/inline-handlers.js', 'app.js', 'settings.js', 'radar.js', 'fills-view.js']));
  assert.ok(srcs.indexOf('lightweight-charts.js') < srcs.indexOf(LIB_ORDER[0]), '图表库应先于业务脚本');
});

test('lib 与 app.js 都在打包文件列表里（electron-builder files 是白名单）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RENDERER, '..', 'package.json'), 'utf8'));
  const files = pkg.build.files;
  assert.ok(files.includes('renderer/app.js'));
  assert.ok(files.includes('renderer/settings.js'));
  assert.ok(files.includes('renderer/radar.js'));
  assert.ok(files.includes('renderer/fills-view.js'));
  assert.ok(files.includes('renderer/widget.js'));
  assert.ok(files.includes('renderer/lib/*.js'));
  assert.ok(files.includes('main/*.js'));
});

test('页面不再含内联脚本，CSP 的 script-src 不含 unsafe-inline', () => {
  for (const f of ['index.html', 'widget.html']) {
    const h = fs.readFileSync(path.join(RENDERER, f), 'utf8');
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(h)[1];
    const scriptSrc = /script-src([^;]*)/.exec(csp)[1];
    assert.ok(!scriptSrc.includes('unsafe-inline'), f + ' 的 script-src 不应含 unsafe-inline');
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(h), f + ' 不应再有内联 <script> 代码');
  }
});
