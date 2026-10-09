// 影子模型：用已经积累的「前向验证」记录训练一个逻辑回归，预测「这条信号 4 小时后方向命中」的概率。
// 经典脚本（纯函数，无 DOM 依赖），定义全局 sm* 函数。
//
// 定位是「影子」：只展示、只统计，**不参与任何门控或评分**。是否有用由样本外指标说了算：
// 只有样本外 AUC ≥ 0.55 且 Brier 优于「永远预测基础命中率」的基线，才标记为 ready 并在界面上显示概率。
// 训练 / 评估都按时间顺序切分（前 70% 训练、后 30% 检验），不做随机打乱，避免用未来信息评估过去。
var SM_FEATURES = ["score", "dir", "conv", "adx", "rsi", "volRatio", "tf15", "tf1h", "tf4h", "btc", "dv", "chg"];
var SM_MIN_SAMPLES = 150;
var SM_MIN_AUC = 0.55;

function smClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function smNum(v, def) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : def; }

// 从一条分析结果提取特征向量（顺序见 SM_FEATURES）。缺失项用中性值，且不会抛错。
// a: analyzeMultiTimeframe 的合并结果；extra: { btcScore, dv }
function smFeatures(a, extra) {
  var ex = extra || {};
  var ind = (a && a.indicators) || {};
  var tf = {};
  ((a && a.tfData) || []).forEach(function (r) { if (r && r.interval && r.analysis) tf[r.interval] = smNum(r.analysis.score, 50); });
  var score = smNum(a && a.score, 50);
  var long = score >= 50;
  return [
    score / 100,                                         // score
    long ? 1 : -1,                                       // dir
    Math.abs(score - 50) / 50,                           // conv：离中性的距离
    smClamp(smNum(ind.adx, 20), 0, 80) / 50,             // adx
    smClamp(smNum(ind.rsi, 50), 0, 100) / 100,           // rsi
    smClamp(smNum(a && a.volRatio, 1), 0, 5) / 5,        // volRatio
    smNum(tf["15m"], 50) / 100,                          // tf15
    smNum(tf["1h"], 50) / 100,                           // tf1h
    smNum(tf["4h"], 50) / 100,                           // tf4h
    smNum(ex.btcScore, 50) / 100,                        // btc：BTC 当时的评分
    smClamp(smNum(ex.dv, 0), -4, 4) / 4,                 // dv：衍生品倾向
    smClamp(smNum(a && a.change, 0), -20, 20) / 20       // chg：24h 涨跌
  ];
}

function smSigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)); }

// 高斯消元解 A·x = b（A 为 n×n，带主元选择）。奇异时返回 null。
function smSolve(A, b) {
  var n = b.length, M = A.map(function (row, i) { return row.slice().concat([b[i]]); });
  for (var c = 0; c < n; c++) {
    var p = c;
    for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    var t = M[c]; M[c] = M[p]; M[p] = t;
    for (var r2 = c + 1; r2 < n; r2++) {
      var f = M[r2][c] / M[c][c];
      for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
    }
  }
  var x = new Array(n);
  for (var i = n - 1; i >= 0; i--) {
    var s = M[i][n];
    for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

// 训练：samples = [{x:[…], y:0|1}]。标准化 + L2（lambda）+ 牛顿法（IRLS）。
function smTrain(samples, opts) {
  var o = opts || {}, lambda = o.lambda === undefined ? 1.0 : o.lambda;
  var n = samples.length, d = samples[0].x.length;
  var mean = new Array(d).fill(0), std = new Array(d).fill(0);
  samples.forEach(function (s) { for (var j = 0; j < d; j++) mean[j] += s.x[j] / n; });
  samples.forEach(function (s) { for (var j = 0; j < d; j++) std[j] += Math.pow(s.x[j] - mean[j], 2) / n; });
  for (var j0 = 0; j0 < d; j0++) std[j0] = Math.sqrt(std[j0]) || 1;
  var X = samples.map(function (s) { return s.x.map(function (v, j) { return (v - mean[j]) / std[j]; }); });
  var y = samples.map(function (s) { return s.y; });
  var w = new Array(d + 1).fill(0);                    // w[0] 是截距，不做正则
  for (var it = 0; it < 30; it++) {
    var g = new Array(d + 1).fill(0), H = [];
    for (var a = 0; a <= d; a++) H.push(new Array(d + 1).fill(0));
    for (var i = 0; i < n; i++) {
      var z = w[0];
      for (var j1 = 0; j1 < d; j1++) z += w[j1 + 1] * X[i][j1];
      var p = smSigmoid(z), r = p - y[i], wt = Math.max(1e-6, p * (1 - p));
      g[0] += r;
      for (var j2 = 0; j2 < d; j2++) g[j2 + 1] += r * X[i][j2];
      H[0][0] += wt;
      for (var j3 = 0; j3 < d; j3++) {
        H[0][j3 + 1] += wt * X[i][j3]; H[j3 + 1][0] += wt * X[i][j3];
        for (var j4 = 0; j4 < d; j4++) H[j3 + 1][j4 + 1] += wt * X[i][j3] * X[i][j4];
      }
    }
    for (var k = 1; k <= d; k++) { g[k] += lambda * w[k]; H[k][k] += lambda; }
    var step = smSolve(H, g);
    if (!step) break;
    var maxStep = 0;
    for (var m = 0; m <= d; m++) { w[m] -= step[m]; maxStep = Math.max(maxStep, Math.abs(step[m])); }
    if (maxStep < 1e-6) break;
  }
  return { w: w, mean: mean, std: std, n: n, lambda: lambda };
}

function smPredict(model, x) {
  var z = model.w[0];
  for (var j = 0; j < x.length; j++) z += model.w[j + 1] * ((x[j] - model.mean[j]) / model.std[j]);
  return smSigmoid(z);
}

// AUC：随机取一个正样本和一个负样本，模型给正样本更高概率的概率（平局算 0.5）。用秩和计算。
function smAuc(scores, labels) {
  var idx = scores.map(function (s, i) { return i; }).sort(function (a, b) { return scores[a] - scores[b]; });
  var ranks = new Array(scores.length), i = 0;
  while (i < idx.length) {
    var j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    var r = (i + j) / 2 + 1;
    for (var k = i; k <= j; k++) ranks[idx[k]] = r;
    i = j + 1;
  }
  var pos = 0, sumPos = 0;
  labels.forEach(function (l, t) { if (l === 1) { pos++; sumPos += ranks[t]; } });
  var neg = labels.length - pos;
  if (!pos || !neg) return null;
  return (sumPos - pos * (pos + 1) / 2) / (pos * neg);
}

// 评估：对数损失、Brier（越小越好）、AUC，以及「永远预测训练集命中率」的基线
function smEvaluate(model, samples, baseRate) {
  var n = samples.length;
  if (!n) return null;
  var ps = samples.map(function (s) { return smPredict(model, s.x); });
  var ll = 0, br = 0, brBase = 0;
  samples.forEach(function (s, i) {
    var p = smClamp(ps[i], 1e-6, 1 - 1e-6);
    ll += -(s.y * Math.log(p) + (1 - s.y) * Math.log(1 - p));
    br += Math.pow(ps[i] - s.y, 2);
    brBase += Math.pow(baseRate - s.y, 2);
  });
  return { n: n, logloss: ll / n, brier: br / n, baselineBrier: brBase / n, auc: smAuc(ps, samples.map(function (s) { return s.y; })) };
}

// 从前向验证记录训练并评估。records 需带 feat（特征向量）与已结算的 r4h。
// 返回 { n, ready, reason, model, oos }：model 用全部样本训练（用于预测），oos 是「前 70% 训练 → 后 30% 检验」的样本外指标。
function smFit(records) {
  var samples = records.filter(function (r) { return r && r.feat && r.feat.length === SM_FEATURES.length && r.r4h && typeof r.r4h.hit === "boolean"; })
    .sort(function (a, b) { return a.ts - b.ts; })
    .map(function (r) { return { x: r.feat, y: r.r4h.hit ? 1 : 0 }; });
  var n = samples.length;
  if (n < SM_MIN_SAMPLES) return { n: n, ready: false, reason: "样本积累中（" + n + " / " + SM_MIN_SAMPLES + "）", model: null, oos: null };
  var cut = Math.floor(n * 0.7);
  var train = samples.slice(0, cut), test = samples.slice(cut);
  var base = train.reduce(function (s, x) { return s + x.y; }, 0) / train.length;
  var mTrain = smTrain(train);
  var oos = smEvaluate(mTrain, test, base);
  var model = smTrain(samples);
  model.baseRate = samples.reduce(function (s, x) { return s + x.y; }, 0) / n;
  var ok = !!(oos && oos.auc !== null && oos.auc >= SM_MIN_AUC && oos.brier < oos.baselineBrier);
  return {
    n: n, ready: ok, model: model, oos: oos, trainedAt: Date.now(),
    reason: ok ? "样本外有效" : (oos && oos.auc !== null ? "样本外未达标（AUC " + oos.auc.toFixed(3) + "，需 ≥ " + SM_MIN_AUC + " 且 Brier 优于基线）" : "样本外无法评估")
  };
}
