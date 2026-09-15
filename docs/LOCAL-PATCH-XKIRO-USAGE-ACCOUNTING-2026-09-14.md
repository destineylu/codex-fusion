# Xkiro Usage Accounting 本地补丁存档 — 2026-09-14

> 目的：把 Xkiro 官方账户 Usage API 与 Router 本地逐模型 ledger 集成到 Control Center，覆盖 xkiro / xkiro2 两个独立账号，同时保持“官方总额权威、本地归因不猜测”的会计边界。

## 1. 官方账户数据

官方接口：

```text
GET https://api.xkiro.com/v1/usage
GET https://api.xkiro.com/v1/usage/history?period=month
```

使用各账号现有 API Key，不读取浏览器 Cookie，不嵌入官网页面。

每个账号独立显示：
- plan
- 5-hour spend / cap / remaining / reset
- 7-day spend / cap / remaining / reset
- daily free token used / limit / remaining
- wallet balance / held
- 30-day requests / tokens / spend

账号边界：

```text
xkiro  -> XKIRO_API_KEY
xkiro2 -> XKIRO2_API_KEY
```

不得合并额度、钱包或官方历史。

## 2. 本地逐模型归因

新增：

```text
src/xkiro-billing.mjs
```

Router 完成 xkiro / xkiro2 请求时，在 `usage-events.jsonl` 保存 `xkiroBilling` 价格快照。

价格版本：

```text
models-2026-09-14
source = https://api.xkiro.com/v1/models
```

当前已验证价格包含 Fable 5.1、Opus 5、GPT-6 Astra、GPT-5.6 Sol、Grok 4.6、GLM-5.3、GLM-5.3 Flash 等当前路由模型。

费用分开计算：
- fresh input
- cache read
- cache write（只有 provider 真正报告 token 时）
- output

失败请求按 Xkiro 官方计费语义处理：普通 4xx/5xx 不计费；对无法证明的 cache-write 用量标记 incomplete，绝不猜测。

## 3. 历史数据边界

2026-09-14 该功能上线前的 Router 请求没有请求时价格快照。

这些历史请求：
- 保留 model / runs / input / cached input / output；
- 可显示 cache-hit；
- 标记为 unpriced；
- 不用“今天价格”反推历史美元；
- 不参与本地美元归因。

原因：真实验收曾出现 Xkiro #2 官方 30 天约 $65.07，而按当前价格回算历史 Router Token 得约 $79.40。该差异证明 retrospectively pricing 不能当账单。

官方 `/v1/usage/history` 仅提供 account-level bucket totals，没有公开逐请求费用 API，因此官方 30 天 spend 永远是权威值。

## 4. Control Center

Usage 页面新增：

```text
Xkiro account usage
```

支持：
- xkiro / xkiro2 账号切换；
- 5 hours / 7 days / 30 days / All tracked；
- 5-hour remaining；
- 7-day remaining；
- Daily free tokens；
- Wallet；
- Official 30-day spend + requests + tokens；
- Local attributed；
- Unattributed；
- per-model local value / runs / input / cache hit / coverage；
- Recent Xkiro requests。

`Unattributed` 只在官方窗口与本地 captured spend 可比较时计算；历史未定价请求不会被硬分配给某模型。

## 5. 主要实现文件

```text
src/xkiro-billing.mjs
src/usage-events.mjs
src/provider-account-usage.mjs
src/provider-usage.mjs

apps/control-center/src/types.ts
apps/control-center/src/pages/UsagePage.tsx
apps/control-center/src/pages/usage-status.css

test/xkiro-billing.test.mjs
test/provider-account-usage.test.mjs
apps/control-center/test/renderer.test.mjs
```

## 6. 真实 API 验证

2026-09-14 使用本机两个独立账号只读验证：

```text
xkiro:
  plan = pro-plus
  /v1/usage = 200
  /v1/usage/history?period=month = 200

xkiro2:
  plan = ultra
  /v1/usage = 200
  /v1/usage/history?period=month = 200
```

API Key 不输出到日志或 UI。

## 7. 验证

```text
xkiro/account/provider focused tests: 65/65 PASS
root npm run check: PASS
Control Center npm run check: PASS
Control Center production build: PASS
Control Center renderer: 8/8 PASS
```

本轮按用户要求没有：
- restart Router
- tray refresh / restart
- 替换当前运行中的 app.asar

因此源码与构建产物已经完成，但当前正在运行的 Router/Control Center 进程不会热加载本补丁。下一次用户允许的正常重启后，新请求才开始写入 xkiroBilling 快照。

## 8. 升级规则

升级时必须保留或用 upstream 等价实现替代：
- Xkiro 官方 usage/history API；
- xkiro / xkiro2 独立账户；
- request-time pricing snapshot；
- historical unpriced fail-honest；
- official totals authoritative；
- incomplete/cache-write 不猜测；
- Control Center Xkiro account usage 面板；
- no browser-cookie scraping；
- no automatic cross-account failover。
