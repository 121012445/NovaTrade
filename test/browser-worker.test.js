'use strict';
// 回测后台线程：Worker 可用时结果与主线程完全一致、界面不被阻塞；Worker 不可用时自动退回主线程。
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../testlib/browser-harness');

const skip = h.available() ? false : '没有可用的 playwright-core / Chromium';

async function run(args) {
  const { browser, ctx } = await h.launch(args);
  try {
    const { page, errors } = await h.openApp(ctx);
    await page.waitForFunction(() => document.querySelectorAll('#coinGrid .coin-card').length > 0, null, { timeout: 15000 });
    const out = await page.evaluate(async () => {
      const kl = window.__mockKlines('ETHUSDT', '1h', 900).slice(0, -1);
      const cfg = { tf: '1h', bars: 600, step: 3, sym: 'ETHUSDT' };
      // 在 Worker 计算期间测一下主线程是否还能及时响应（计时器延迟）
      let maxLag = 0, last = performance.now();
      const probe = setInterval(() => { const n = performance.now(); maxLag = Math.max(maxLag, n - last - 20); last = n; }, 20);
      const t0 = performance.now();
      const viaWorker = await btCollectInWorker(kl, cfg, 48, {});
      const tWorker = performance.now() - t0;
      clearInterval(probe);
      const direct = await btCollectSignals(kl, cfg, 48, {});
      return { state: btWorkerState(), n: viaWorker.signals.length, same: JSON.stringify(viaWorker.signals) === JSON.stringify(direct.signals), maxLag, tWorker };
    });
    return { out, errors };
  } finally { await browser.close(); }
}

test('Worker 可用（模拟 Electron 的 file:// 权限）：结果与主线程一致，计算期间主线程不被长时间阻塞', { skip }, async () => {
  const { out, errors } = await run(['--allow-file-access-from-files']);
  assert.equal(out.state, 'ok');
  assert.ok(out.n > 5, '应产生若干信号，实际 ' + out.n);
  assert.equal(out.same, true, 'Worker 与主线程结果必须完全一致');
  assert.ok(out.maxLag < 200, '主线程最长卡顿 ' + Math.round(out.maxLag) + 'ms（总耗时 ' + Math.round(out.tWorker) + 'ms）');
  assert.deepEqual(errors.filter((e) => !/worker/i.test(e)), []);
});

test('Worker 不可用（普通浏览器的 file:// 限制）：自动退回主线程，结果不变', { skip }, async () => {
  const { out } = await run([]);
  assert.equal(out.state, 'failed');
  assert.ok(out.n > 5);
  assert.equal(out.same, true);
});
