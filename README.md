# NovaTrade

桌面端加密货币行情分析工具（Electron）：多周期技术评分、风险回报测算、选币扫描、信号前向验证、回测、价格预警与远程推送。
**只读取公开行情，不连接任何交易账户，不具备下单能力。**

> ⚠️ 免责声明：所有评分、信号、回测与 AI 解读都是基于公开数据的统计推断，**不构成投资建议**，也不保证未来表现。加密资产价格波动剧烈，请自行评估并承担风险。

## 功能

- **行情**：币安合约 `!miniTicker@arr` WebSocket 推送（每秒更新），断线自动指数退避重连；推送不可用时回退到轮询。币安整体不可达时回退到 OKX 现货公开行情（界面会标明「备用数据源」）。
- **AI 推荐 / 技术分析**：15m/1h/4h 加权评分（只用**已收盘** K 线）、支撑阻力、风险回报、日线趋势门控；附带相对 BTC 强弱、衍生品倾向（资金费率 / 持仓量 / 多空比，未经验证、仅记录）。
- **信号前向验证**：记录每条推荐，1h/4h 后用真实价格结算方向命中率；影子模型（逻辑回归）仅在样本外检验有效时才显示概率，不参与评分与门控。
- **信号是否有效**（信号台账上方）：
  - 随机基线：同一批币、同一时间随机给方向（置换检验），看命中率是否显著高于随机；附「全做多 / 全做空」与相对 BTC 超额收益。
  - 门控归因：每道门控拦下的信号与放行的信号比较，区间不重叠才下结论；门控可在设置里单独开关（关闭后仍记录「本来会不会拦」）。
  - 按行情状态（该币 ADX 状态 / BTC 环境 / 波动）分组的命中率，可选在显著偏弱的状态下暂停信号。
  - 记录带评分版本，默认只统计当前版本，避免新旧口径混在一起。
  - K 线图上标出历史信号与模拟跟踪；从台账点一条信号会画出它的入场 / 止损 / 目标线。
- **模拟跟踪**：按点击时的现价入场（越过止损 / 目标的拒绝），记录最大浮盈 / 浮亏、扣成本的净收益、相对 BTC 超额；「暂不交易」的信号需确认并单独统计。
- **市场雷达**：基于实时推送的 5 / 15 分钟异动榜与可选提醒；全市场资金费率、持仓量 24h 变化、账户多空比排行。
- **真实成交**：用**仅读取权限**的币安 API Key（带交易 / 提现等任何权限的 Key 会被拒绝）或币安导出的 CSV 导入成交，还原成完整交易，与系统信号对照，可写入交易日志。
- **回测**：
  - 阈值扫描（近似）与完整回测（逐根 K 线、实际止损止盈、日线门控）；
  - 成本模型含手续费、滑点、资金费率，开盘跳空越过止损按开盘价成交，同币种不重叠持仓；
  - 期望的 95% 置信区间、样本内 / 外对比、按时间分段稳定性、按块重采样回撤、参数稳定性扫描、多币种组合回测；
  - 超过 1400 根时走本地历史 K 线库（分页拉取 + 增量更新，落盘在用户数据目录）。
- **价格预警**：价格 / 24h 涨跌 / 多周期评分；穿越语义（创建时已满足不会立刻触发）、重复提醒 + 冷却；推送到 Telegram / 飞书 / 企业微信 / Bark / 通用 Webhook。
- **AI 解读**：把已算好的分析摘要交给你配置的 OpenAI 兼容接口（含本地 Ollama），生成中文解读；只发送摘要，不下单、不预测价格。
- **持仓与复盘**：手工记录持仓，算浮盈与组合风险概览（集中度、净敞口、加权杠杆、相关性折算后的有效独立仓位数）。
- **设置页**：推送渠道、扫描范围、新信号提醒、AI 接口、备份 / 恢复、诊断包导出、更新检查。

## 开发

要求：Node.js 20+（开发 / 测试）。运行桌面应用需要先 `npm install`。

```bash
npm install          # 首次会生成 package-lock.json（旧的 lock 对应 Electron 33，已删除），请一并提交
npm start            # 启动应用（Electron 44 首次运行时才下载自身二进制）
npm test             # 运行测试（不依赖 npm 包）
npm run build:win    # 打包 Windows 安装包；build:mac / build:linux 同理（需在对应系统上打包）
```

### 发版与自动更新

1. 修改 `package.json` 的 `version` 并提交；
2. `git tag v1.3.0 && git push origin v1.3.0`；
3. GitHub Actions（`.github/workflows/release.yml`）会在 Windows / macOS / Linux 上打包、上传到同一个 Release 并发布。

已安装的应用启动 30 秒后、之后每 6 小时检查一次，发现新版本在后台下载，提示「重启并安装」（不点也会在退出时安装），可在设置里关闭自动下载。
没有代码签名证书：Windows 安装包会出现 SmartScreen 提示；**macOS 未签名版本无法自动更新**，只会提示有新版本，需要手动下载。

### 目录结构

```
main/                 主进程
  index.js            窗口 / 托盘 / IPC 装配
  binance-http.js     统一 REST 请求层（状态码处理、限流退避、并发上限、去重）
  validate.js         IPC 入参校验
  push.js llm.js      远程推送 / AI 解读（凭据用 safeStorage 加密）
  kline-store.js      本地历史 K 线库
  okx.js              备用数据源
  binance-account.js  只读 API：权限校验、签名请求、导入成交
  updater.js          自动更新（electron-updater）
  diagnostics.js      诊断包脱敏、更新检查
  gpu-config.js       硬件加速 / 软件渲染开关
renderer/
  index.html app.js settings.js radar.js fills-view.js widget.html widget.js
  lib/                纯逻辑（浏览器与 Node 共用）：指标、评分、回测、预警、实时行情、影子模型、组合风险、信号归因、
                      信号标注、模拟跟踪、市场雷达、成交还原、内联处理器；bt-worker.js 是回测后台线程
bt/                   回测 CLI 与 Node 引擎加载器（见 bt/README.md）
test/ testlib/        测试与测试设施
```

`renderer/lib/*.js` 是经典脚本（共享全局作用域）。浏览器按 `index.html` 里的顺序加载，Node 里由 `bt/engine.js` 在 `vm` 中按同样顺序加载，两者的顺序由 `test/engine-order.test.js` 校验。

### 测试

```bash
npm test
```

- 单元测试：指标、评分、回测核心、预警、实时行情、影子模型、组合风险、HTTP 层、推送 / AI / 诊断。
- 主进程集成测试：用假的 `electron` + 假网络加载真实的 `main/index.js`（`testlib/mock-electron.js`）。
- 浏览器集成测试：用 headless Chromium 打开真实页面（严格 CSP），注入假的 `binanceAPI` / `electronAPI`。需要 `playwright-core` 与 Chromium，找不到时自动跳过（`PLAYWRIGHT_CORE`、`CHROMIUM_PATH` 环境变量可指定位置）。

## 安全设计

- 渲染进程：`contextIsolation`、`sandbox`、无 `nodeIntegration`；CSP `script-src 'self'`（无 `unsafe-inline`），页面不含内联脚本；`on*` 属性由受限文法的委托分发器处理（不使用 `eval`）。
- 主进程：所有 IPC 校验发送方是本地 `file://` 页面，入参走白名单 / 范围校验；禁止新开窗口、外部导航、`<webview>` 与全部浏览器权限；正式版默认关闭开发者工具（`--devtools` 或 `NOVATRADE_DEVTOOLS=1` 打开）。
- 凭据（推送令牌、API Key）用系统安全存储加密落盘，渲染进程只能看到打码值，也不会写进备份文件。
- 诊断包会脱敏令牌 / 密钥 / 带参数的 URL / 代理账号密码。

## 渲染

默认启用硬件加速。GPU 进程连续崩溃会自动切到软件渲染并重启一次；也可在菜单「查看 → 使用软件渲染」手动切换，或用 `--disable-gpu` / `NOVATRADE_SOFTWARE_RENDER=1`。

## 已知限制

- 回测币种池取「当前」成交额靠前的币，存在幸存者偏差；回测与评分都不含 BTC 趋势一票否决（需要实时 BTC 分析）。
- OKX 备用数据源仅覆盖现货 USDT 对，K 线最多 300 根，无合约 / 衍生品数据。
- 仓库目前还没有发布过 Release：第一次打 tag 发版之后，自动更新才有东西可以下载。
- 回测的信号收集放在 Web Worker 里；Worker 创建失败时自动退回主线程（结果一致，只是界面会稍卡）。Electron 里 `file://` 页面创建 Worker 的行为未在真机验证，测试里用 Chromium 的 `--allow-file-access-from-files` 模拟。
- 币安部分合约读取接口可能要求 Key 开启「允许合约」（同时允许合约交易），本应用不接受这类 Key，此时合约成交请用 CSV 导入。
- 升级到 Electron 44 / electron-builder 26 后未在真机上运行过，请先 `npm install && npm start` 试一遍。
