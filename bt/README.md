# NovaTrade 回测工具

本目录提供基于应用当前评分逻辑的离线回测与实时只读检查工具：

- `backtest.js` — 批量回测器，通过 `engine.js` 加载 `renderer/lib/*.js`（与应用共用同一份评分引擎）。
- `engine.js` — 在 Node 里按 `index.html` 相同的顺序加载评分 / 回测引擎，供回测 CLI 与单元测试使用。
- `live_check.js` — 检查 BTC/ETH 多周期分析结果。
- `live_reco_check.js` — 按应用规则检查当前市场推荐结果。

## 常用命令

```bash
# 全量基线（1h、成交额 Top60、2000 根 K 线）
node backtest.js --top 60 --bars 2000 --out last_run.json

# 与基线比较；先准备一个由 backtest.js 生成的基线 JSON
node backtest.js --top 60 --bars 2000 --baseline last_run.json --out new_run.json

# 快速迭代
node backtest.js --top 15 --bars 2000

# 代理：默认读环境变量 NOVATRADE_PROXY / HTTPS_PROXY / HTTP_PROXY，都没有则直连；也可显式指定
node backtest.js --proxy http://127.0.0.1:7890
node backtest.js --proxy none

# 数据源：默认合约（与应用一致）；切到现货
node backtest.js --market spot

# 实时只读检查
node live_check.js
node live_reco_check.js
```

K 线缓存与回测输出均为本地生成数据，不纳入版本控制。

## 回测口径

- 信号基于**已收盘** K 线（未收盘的最后一根会被丢弃）；默认阈值直接取自应用常量（`SIGNAL_LONG_MIN` / `SHORT_SCORE_MIN`），不会与应用漂移。可用 `--long-th` / `--short-th` 覆盖。
- 默认使用合约 K 线（`--market futures`），与应用的数据源一致。遇到 HTTP 429/418 会按 `Retry-After` 等待重试；4xx 业务错误直接报错。
- 入场为下一根开盘价；默认止损、止盈和持仓周期见 `backtest.js` 参数与输出。
- 同一根 K 线同时触及止损与止盈时，按保守原则记止损。
- 回测成本与仓位假设由脚本参数控制；横向比较时保持参数一致。

## 实验纪律

1. 一次只调整一个变量。
2. 使用相同币种范围、时间窗口、K 线缓存新鲜度和成本参数比较。
3. 同时观察期望收益、收益/回撤与样本数，不能只看胜率。
4. 小样本结果不作为定阈依据；在多个时间窗口复核，避免窗口过拟合。
5. 离线结果仅用于研究与验证，不构成收益承诺，也不会执行真实下单。

## 应用内的完整回测

应用里的「完整回测」（回测页）使用同一份 `renderer/lib/backtest-core.js`，在 CLI 的基础上多了：

- 成本模型：往返手续费 + 单边滑点 + 资金费率（保守地多空都按支付计）；开盘即越过止损价按开盘价成交（跳空）。
- 同一币种默认不重叠持仓，避免样本被重复计数；每笔期望给出 95% 置信区间。
- 参数稳定性扫描（止盈倍数 × 最长持有）、按时间分段的稳定性、按块重采样的回撤分布。
- 多币种组合回测（币种池取当前成交额靠前的币，存在幸存者偏差）。
- 样本根数超过 1400 时走主进程的本地 K 线库（分页拉取 + 增量更新）。

> 注意：此前「完整回测」把「往返手续费%」又乘了 2，等于多收了一倍。现已修正为按往返口径计一次。
