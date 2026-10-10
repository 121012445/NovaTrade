// 回测后台线程（Web Worker）：在独立线程里跑最耗时的「逐点打分收集信号」（btCollectSignals），界面不再卡顿。
// 加载与页面相同的评分 / 回测引擎文件，保证结果与主线程计算完全一致。
// 主线程侧的调度与降级（Worker 不可用时退回主线程）见 app.js 的 btCollectInWorker。
/* global importScripts, btCollectSignals */
self.window = self;
importScripts("indicators.js", "analysis-core.js", "scoring.js", "backtest-core.js");

var aborted = {};
self.onmessage = function (ev) {
  var m = ev.data || {};
  if (m.abort) { aborted[m.abort] = true; return; }
  if (m.ping) { self.postMessage({ pong: m.ping }); return; }
  var id = m.id;
  // 页面里的门控开关 / 止损上限保存在 localStorage，Worker 读不到，由主线程随任务一起传进来
  if (m.gates) { self.__gateCfg = m.gates; SHORT_SCORE_MIN = m.gates.score39 === false ? SIGNAL_SHORT_MAX : SHORT_SCORE_STRICT; }
  if (typeof m.maxStopPct === "number") self.__maxStopPct = m.maxStopPct;
  btCollectSignals(m.kl, m.cfg, m.maxHoldRef, {
    isAborted: function () { return !!aborted[id]; },
    onProgress: function (n) { self.postMessage({ id: id, progress: n }); }
  }).then(function (res) {
    delete aborted[id];
    self.postMessage({ id: id, ok: true, res: res });
  }, function (err) {
    delete aborted[id];
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
  });
};
