# ETH Shenzhen 2026 · 现场演示流程（约 5 分钟）

10 月 24 日下午 Co-building Day 现场评审。评分：技术创新 30% · 实用价值 25% · 开源 20% · 完成度 15% · 现场展示 10%。
材料：`docs/warrant-ethsz.pdf`（7 页，双语）；演示脚本 `scripts/demo-pricecheck.mjs`。

## 出发前（前一晚）

- [ ] `npm install && npm run build` 后跑一遍 `node scripts/demo-pricecheck.mjs`，确认输出与 deck 第 6 页一致
- [ ] **在会场同类网络下测 Arc RPC**：脚本要 fork `https://rpc.mainnet.arc.io`。手机热点也试一次
- [ ] 浏览器预开四个标签：deck PDF、README 的 Chainlink 小节、两笔主网交易（下表）
- [ ] 终端字号 ≥ 18pt，提前 `cd ~/dev/mandate`

| 标签 | 链接 |
|---|---|
| Chainlink 复核（一致） | https://explorer.arc.io/tx/0xfcceb21ad86dbada766f40204c00eea4c83d82fa1a1b107879b850bc62a84117 |
| 说谎 agent 被判矛盾 | https://explorer.arc.io/tx/0xbde80bd4ef702fd7bb6ad3d3d7df63d22bcc7a92cfe90f8971dde4503bb98f4d |

## 流程

| 时间 | 画面 | 讲什么 |
|---|---|---|
| 0:00–0:40 | deck 第 1–2 页 | AI 代理替人交易，边界写在提示词里，没法核查。Warrant 把授权放上链、交易前打分、签名披露、写进 ERC-8004 信誉。前四步是之前做的，今天讲第五步。 |
| 0:40–1:20 | 第 3 页 | 缺口：打分卡上每个数字都是代理自己算的。插件被改、代理跳过打分、报价数据造假，链上都分不出来。 |
| 1:20–2:10 | 第 4 页 | `WarrantPriceCheck`：签名里的 quoteHash 锁定成交数量；合约读 Chainlink 两个价格源算公允产出；低于公允值超过授权的「价格冲击+费用」上限（加 100 bps 预言机容差），而代理报的是 PASS，就记为矛盾，ERC-8004 扣一分。价格源过期直接回滚，不记录。 |
| 2:10–3:30 | **终端现场跑** `node scripts/demo-pricecheck.mjs` | 本地 fork Arc 主网，用的是主网上已部署的合约和实时价格。同一笔比公允价低 5% 的报价：诚实代理报 FAIL → 一致；说谎代理报 PASS → 矛盾，信誉 −1。约 40 秒跑完，边跑边讲。 |
| 3:30–4:20 | 第 5 页 + 浏览器打开两笔主网交易 | 这不只是 fork：同样的流程在 Arc 主网真实跑过。真实 `mm swap quote`、真实 MetaMask 代理钱包签名，Chainlink 复核结果「一致」；说谎代理那笔是人为安排的，注册信息里写明了。 |
| 4:20–5:00 | 第 7 页 | 局限照实说（只复核有价格源的币；100 bps 内的小偏差不标记；有人调用才复核；未审计）。代码 MIT 开源，README 里每笔交易可点开。 |

## 评委可能问

- **为什么不直接拦截交易？** 钱包插件拦不住原生命令，假装能拦更危险。我们让「说谎」在链上可被发现、可被计入信誉。
- **Arc / Circle 自己就有 agent 钱包限额，和你有什么区别？** Circle Agent Wallets 的策略（Arc Portal 的 Agent 页）是钱包服务商在链下执行的「花多少、转给谁」闸门：单笔/日/周/月 USDC 上限、地址白名单黑名单，存在 Circle 服务端，只有钱包主人看得到。Warrant 管的是「这笔该不该这样成交」（滑点、价格冲击、费用、跨链、新授权，再加 Chainlink 公允价复核），结果在链上谁都能查，代理说谎会被记下来。它管花多少，我们证明合不合适、说没说实话，两者可以叠加；Warrant 不绑钱包，能签 EIP-712 的钱包都能用。
- **下一步？** ① Arc 主网已有 ERC-8004 ValidationRegistry，让价格复核同时作为 validator 给诚实代理发正面凭证；② ERC-8183（托管任务）：委托兑换任务里成交量就在链上，Warrant 当 evaluator，按 Chainlink 公允价决定放款还是退款，把「扣信誉」升级为「拿不到报酬」。
- **为什么是 Arc？** Arc 上 Chainlink 有 USDC/EURC 价格源，gas 用 USDC 计价，每份披露成本可预期；Arc 自带 ERC-8004 注册表。合约是标准 EVM，换到以太坊 L2 只需改价格源地址。
- **100 bps 容差怎么定的？** 两个价格源各自 0.5% 的偏差阈值相加：价格变动不到 0.5% 时 Chainlink 不更新，这段误差不能算代理撒谎。
- **谁来调用 checkAndRate？** 任何人。授权人、审计方、竞争对手都可以，合约不信任调用者，只信签名和预言机。
- **AI 用了多少？** 用 AI 编程工具开发，README 有披露；设计与取舍可以现场讲清楚。

## 兜底

- **会场连不上 Arc RPC**：改放 deck 第 6 页（就是脚本的真实输出），并打开 README 里的主网交易链接（只需普通网页）。
- **网页也打不开**：deck 第 5 页有完整交易哈希与数值，口头讲。
