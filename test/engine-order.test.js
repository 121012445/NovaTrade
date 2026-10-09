'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LIB_ORDER, RENDERER } = require('../bt/engine');

const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

test('index.html 按 bt/engine.js 的 LIB_ORDER 顺序加载 lib 脚本，最后才是 app.js', () => {
  const srcs = [...html.matchAll(/<script\s+src="?([^"\s>]+)"?\s*>\s*<\/script>/g)].map((m) => m[1]);
  const mine = srcs.filter((s) => s.startsWith('lib/') || s === 'app.js');
  assert.deepEqual(mine, LIB_ORDER.concat(['app.js']));
  assert.ok(srcs.indexOf('lightweight-charts.js') < srcs.indexOf(LIB_ORDER[0]), '图表库应先于业务脚本');
});

test('lib 与 app.js 都在打包文件列表里（electron-builder files 是白名单）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RENDERER, '..', 'package.json'), 'utf8'));
  const files = pkg.build.files;
  assert.ok(files.includes('renderer/app.js'));
  assert.ok(files.includes('renderer/lib/*.js'));
  assert.ok(files.includes('main/*.js'));
});
