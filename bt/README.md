# NovaTrade 回测工具

本目录提供基于应用当前评分逻辑的离线回测与实时只读检查工具：

- `backtest.js` — 批量回测器，直接加载 `renderer/index.html` 的内联脚本。
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

# 不使用 HTTP 代理
node backtest.js --proxy none

# 实时只读检查
node live_check.js
node live_reco_check.js
```

K 线缓存与回测输出均为本地生成数据，不纳入版本控制。

## 回测口径

- 信号基于已收盘 K 线；默认阈值与应用当前回测配置一致。
- 入场为下一根开盘价；默认止损、止盈和持仓周期见 `backtest.js` 参数与输出。
- 同一根 K 线同时触及止损与止盈时，按保守原则记止损。
- 回测成本与仓位假设由脚本参数控制；横向比较时保持参数一致。

## 实验纪律

1. 一次只调整一个变量。
2. 使用相同币种范围、时间窗口、K 线缓存新鲜度和成本参数比较。
3. 同时观察期望收益、收益/回撤与样本数，不能只看胜率。
4. 小样本结果不作为定阈依据；在多个时间窗口复核，避免窗口过拟合。
5. 离线结果仅用于研究与验证，不构成收益承诺，也不会执行真实下单。
