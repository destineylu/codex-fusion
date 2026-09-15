# Xkiro #2 独立账号本地补丁存档 — 2026-09-13

> 目的：在不覆盖现有 Xkiro 账号的前提下，为 Codex Router 增加第二个独立 Xkiro API 账号，并让其主要模型继承 Xkiro 已验证的 Opus 5 安全边界。

## 1. 身份

- Provider ID: `xkiro2`
- Display name: `Xkiro API #2`
- Provider owner/family: `xkiro`
- API base: `https://api.xkiro.com/v1`
- 独立环境变量: `XKIRO2_API_KEY`
- 独立 base-url 环境变量: `XKIRO2_API_BASE_URL`
- 独立 secret file: `xkiro2-api-key.secret`
- 独立 keychain service: `codex-router-xkiro2`

严禁把第二账号 Key 写入现有 `xkiro-api-key.secret`，也不要把两个账号做自动 fallback。

## 2. 预置模型

```text
xkiro2/openai/gpt-6-astra
xkiro2/openai/gpt-5.6-sol
xkiro2/anthropic/claude-fable-5-1
xkiro2/anthropic/claude-opus-5
xkiro2/x-ai/grok-4.6
xkiro2/moonshotai/kimi-k3
xkiro2/z-ai/glm-5.3
xkiro2/z-ai/glm-5.3-flash
```

真实 upstream IDs 与 Xkiro catalog 一致。Context window:
- Grok 4.6 = 500K
- 其余上述模型 = 1M

## 3. Xkiro family 共享行为

第二账号必须共享 Xkiro 的 provider-level兼容保护，但不共享凭据和用量归属。

已改为使用 `provider.ownedBy === "xkiro"` 识别 Xkiro 账号族的行为包括：

- Claude Opus 5 serialized-body safe limit = 1,150,000 bytes
- Claude Opus 5 payload safety auto-compact = 200K
- Context Economy 开启时 Opus 5 working compact = 160K
- Context Economy Opus 5 soft pressure ≈ 100K
- Xkiro Opus 5 / Grok 4.6 slow-first-token prelude window

因此：
```text
xkiro/anthropic/claude-opus-5
xkiro2/anthropic/claude-opus-5
```
都受相同 Xkiro Opus 安全边界保护。

## 4. 独立边界

以下内容绝不共享：

```text
API Key
credential file
环境变量
Provider ID
model slug
Router usage attribution
账号额度
手工选择状态
```

Cross-model / cross-account failover 仍必须保持 OFF。账号 1 用尽时，不允许 Router 自动切到账号 2。

## 5. 主要实现文件

新增：
```text
config/xkiro2/xkiro2.json
config/xkiro2/gpt-6-astra.json
config/xkiro2/gpt-5.6-sol.json
config/xkiro2/claude-fable-5-1.json
config/xkiro2/claude-opus-5.json
config/xkiro2/grok-4.6.json
config/xkiro2/kimi-k3.json
config/xkiro2/glm-5.3.json
config/xkiro2/glm-5.3-flash.json
```

修改：
```text
src/provider-payload-limits.mjs
src/context-economy.mjs
src/catalog.mjs
src/router.mjs
src/empty-completion-guard.mjs
test/provider-payload-limits.test.mjs
test/context-economy.test.mjs
test/empty-completion-guard.test.mjs
test/registry.test.mjs
```

## 6. 验证

已验证：
- registry 正确加载 `xkiro2` 与 8 个模型
- `xkiro2` 与 `xkiro` 在 Control probe 中为两个独立 Provider
- `provider-key xkiro2 status` 独立返回未配置，不读取账号 1 Key
- Xkiro #2 Opus 5 payload limit = 1.15 MB
- Xkiro #2 Opus 5 registry safety compact = 200K
- Context Economy ON 时 catalog compact = 160K
- 真实 context window 仍为 1M
- focused safety/context tests 43/43 PASS
- registry + provider selection tests 43/43 PASS
- root `npm run check` PASS

## 7. 尚需用户本机完成的唯一秘密步骤

不要在聊天中粘贴 API Key。

PowerShell：
```powershell
cd "$env:LOCALAPPDATA\codex-router"
.\codex-router.ps1 provider-key xkiro2 set
.\codex-router.ps1 providers enable xkiro2
```

也可以在 Control Center 的 Xkiro API #2 Provider 页面本机录入 Key 并启用。

启用后 Provider selection 会自动刷新 Codex picker。最后完整退出并重开 Codex Desktop，新建任务验证 `Xkiro #2` 模型。

## 8. 2026-09-14 日常编程 working compact 校准

对第二账号的真实 Codex 使用与低成本 live probe 做了校准。

Fable 5.1 长会话实测：
- 从约 143K input 增长到约 403K；
- 已知输入缓存命中约 98.56%；
- 最近典型请求约 400K input，其中 fresh 常见仅 0.6K～3K；
- xKiro 页面对应请求约 $0.11/次，主要成本来自约 400K cache read；
- Tool Result Aging 已把约 545KB 旧工具结果压到约 165KB，仍不足以阻止整个 conversation 增长到 400K。

因此将以下日常编码模型从 850K working compact 调整为 260K，同时保留真实 1M context window：

```text
xkiro2/openai/gpt-6-astra              260K
xkiro2/openai/gpt-5.6-sol              260K
xkiro2/anthropic/claude-fable-5-1      260K
xkiro2/z-ai/glm-5.3                    260K
```

Live compatibility probe：
- GPT-6 Astra: basic / streaming / tool calling / compaction 全部 PASS；
- GPT-5.6 Sol: 四项全部 PASS；
- GLM-5.3: 四项全部 PASS；
- Fable 5.1: 长任务真实运行正常；补充 probe 时基础与 tool calling 正常，但 compaction probe 遇到 xKiro 429 限流，因此不继续消耗额度重试。

Kimi K3 最终放弃：
- `xkiro2/moonshotai/kimi-k3` 的 probe 被 xKiro 以 403 拒绝；
- 该模型属于 PAYG premium，需要钱包真实充值余额；
- 用户最终决定不再使用，因此配置保留作恢复记录，但 `listed = false`，不再发布到 Codex Picker。

账号 1 与账号 2 的共同模型策略同步：
- `xkiro/openai/gpt-5.6-sol` 与 `xkiro2/openai/gpt-5.6-sol` 均为 1M / 260K；
- `xkiro/z-ai/glm-5.3` 与 `xkiro2/z-ai/glm-5.3` 均为 1M / 260K；
- 账号 1 没有 GPT-6 Astra 和 Fable 5.1 使用权，因此继续不注册这两个模型；
- Claude Opus 5 两账号继续统一为 1M / 160K Context Economy。

## 9. 升级规则

升级前必须检查：
```text
config/xkiro2/
xkiro2 credential policy
provider.ownedBy = xkiro
Xkiro Opus family payload protection
Context Economy Xkiro family matching
Failover remains OFF
```

如果 upstream 将多账号正式实现为 first-class provider accounts，可以 ADAPT/DROP 此本地 Provider，但必须保留两个账号的独立凭据、独立用量归属和禁止自动跨账号切换的边界。
