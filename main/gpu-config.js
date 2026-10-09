'use strict';
// GPU / 软件渲染开关。
// 以前无条件 disable-gpu + swiftshader（软件渲染）：K 线图与 4 个子图全走 CPU，低配机器很吃力。
// 现在默认启用 GPU，仅在以下情况之一才降级为软件渲染：
//   1. 命令行带 --disable-gpu，或环境变量 NOVATRADE_SOFTWARE_RENDER=1
//   2. 用户在菜单里勾选了「使用软件渲染」（持久化在 userData/gpu_config.json）
//   3. GPU 进程连续崩溃 / 启动失败（达到阈值后自动写入配置并重启一次）
const fs = require('fs');

const CRASH_LIMIT = 2;

function defaults() { return { softwareRendering: false, gpuCrashes: 0 }; }

function read(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!c || typeof c !== 'object') return defaults();
    return {
      softwareRendering: c.softwareRendering === true,
      gpuCrashes: Number.isInteger(c.gpuCrashes) && c.gpuCrashes >= 0 ? c.gpuCrashes : 0
    };
  } catch (e) { return defaults(); }
}

function write(file, cfg) {
  try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); return true; } catch (e) { return false; }
}

function shouldDisableGpu(o) {
  const argv = o.argv || [], env = o.env || {}, cfg = o.config || defaults();
  return argv.includes('--disable-gpu') || env.NOVATRADE_SOFTWARE_RENDER === '1' || cfg.softwareRendering === true;
}

// 记录一次 GPU 进程异常退出。返回 { config, switched }：switched=true 表示刚达到阈值、已改为软件渲染，需要重启一次。
function recordGpuCrash(file) {
  const cfg = read(file);
  cfg.gpuCrashes += 1;
  let switched = false;
  if (!cfg.softwareRendering && cfg.gpuCrashes >= CRASH_LIMIT) { cfg.softwareRendering = true; switched = true; }
  write(file, cfg);
  return { config: cfg, switched };
}

// 一次正常的启动完成后清零计数（崩溃要「连续」才算）
function clearCrashes(file) {
  const cfg = read(file);
  if (cfg.gpuCrashes !== 0) { cfg.gpuCrashes = 0; write(file, cfg); }
}

function setSoftwareRendering(file, on) {
  const cfg = read(file);
  cfg.softwareRendering = !!on;
  if (!on) cfg.gpuCrashes = 0;
  return write(file, cfg);
}

module.exports = { read, write, shouldDisableGpu, recordGpuCrash, clearCrashes, setSoftwareRendering, CRASH_LIMIT };
