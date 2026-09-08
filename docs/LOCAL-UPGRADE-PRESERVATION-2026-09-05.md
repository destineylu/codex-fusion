# Codex Router 本地升级保留备忘 — 2026-09-05

> 目的：防止后续 Codex Router 升级、重装、catalog 重发或 Control Center rebuild 时，覆盖 2026-09-03～2026-09-05 已验证的本地修复和运行约束。
>
> 本文件是升级现场备忘，不代表这些补丁永远都要保留。每次升级都应先比较目标 upstream；如果 upstream 已经提供等价或更好的实现，则 DROP 本地补丁；否则只 PORT 最小缺失行为。

## 1. 当前基线

仓库：

```text
C:\Users\73428\AppData\Local\codex-router
```

当前分支 / HEAD：

```text
branch = upgrade-v0.5.1-20260903-083902
HEAD   = 81cb030
base   = v0.5.1 / 97ec9a7
```

已提交本地链：

```text
97ec9a7  official v0.5.1 base
d2ef9fe  renderer locale fix
2661b26  Windows tray recovery + ACL structural comparison
9418d68  Control Center Limited-token open fix
040244b  persisted Control Center interface scale
dd24804  Control Center Skill profile controls
501b5fe  Control Center Codex mode controls
81cb030  tolerate provider account-usage timeouts
```

当前工作树仍包含大量未提交本地补丁族。升级前必须先 `git status --short` 和保存完整 diff，禁止把当前 dirty working tree 当作可直接覆盖的普通 checkout。

## 2. 模型身份硬规则：绝不冒充

这是 2026-09-05 明确确立的长期规则。

```text
Codex Picker 显示 GPT-6 Astra / GPT-5.6 Sol / Terra / Luna / GPT-5.5 / GPT-5.4 Mini / GPT-5.2
→ 必须实际走 OpenAI 原生模型

Picker 显示 DeepSeek / Claude / Kimi / GLM / Grok 等第三方
→ 必须以自己的真实 Provider / model slug 路由
```

禁止恢复任何这种方案：

```text
gpt-5.6-sol → DeepSeek
gpt-5.6-luna → Gemini
gpt-reserve  → Claude / DeepSeek / 其他第三方
```

即使这样可以绕过额度、Reserve 或 Picker 限制，也属于模型身份冒充，不能作为正式方案。

当前验收状态：

```text
native-aliases.json:
{
  "version": 1,
  "aliases": {}
}
```

下次升级后必须再次确认 native aliases 为空，除非用户以后明确改变这条身份政策。

## 3. Picker 遮挡 / Luna Reserve 的最终修复结论

2026-09-05 Codex Desktop 升级后出现：

```text
Luna Reserve / gpt-reserve 进入新的 native catalog / UI 行为
→ Picker 一度表现为原生 Reserve 优先、第三方难以选择
```

调查确认第三方模型实际没有从 Router 消失：

```text
Router health 正常
4200/4201/4202/4203/4208 正常
merged-models.json 仍包含第三方 route
model-picker 状态仍存在
```

最终正确方案不是 native alias，而是恢复真正的 Hybrid：

```text
login_free = false
model_provider = openai
openai_base_url = local Router caller URL
model_catalog_json = %USERPROFILE%\.codex\codex-router\merged-models.json
```

`model_provider = openai` 在当前 v0.5.1 Router 设计中是正常的；Router 集成由 `openai_base_url` + `model_catalog_json` 承担。

最终 Picker 应同时呈现：

```text
OpenAI 原生 GPT 模型（真实身份）
+
Router 第三方模型（真实 Provider 名称）
```

如果后续 Codex 更新再次导致“第三方 Picker 全部消失 / 被 Reserve 挤掉”，优先检查：

```text
1. node .\src\config-manager.mjs status
2. openai_base_url 是否存在且仍指向 Router
3. model_catalog_json 是否存在
4. merged-models.json 是否仍包含 routed models
5. model-picker.json 可见/隐藏状态
6. native-aliases.json 是否意外出现 GPT → 第三方映射
7. 重新发布 catalog
8. 完整退出并重新打开 Codex Desktop
```

不要先删 Provider、重录 Key、重做 verify-model，也不要先开启 `auth-mode on`。

## 4. `auth-mode on` / login-free 的使用限制

当前 upstream v0.5.1 的 login-free 设计会借 native GPT allowlist slug 发布第三方模型，因此它与“绝不冒充模型身份”的长期规则冲突。

默认不要开启：

```powershell
node .\src\control.mjs auth-mode on
```

正常 Hybrid 应保持：

```text
login_free = false
model_provider = openai
```

OpenAI 原生额度耗尽时，正确行为是：

```text
原生 GPT 明确报额度/Reserve 限制
→ 用户手工选择一个真实命名的第三方模型
→ 第三方以自己的身份运行
```

不要让 Router 偷偷把 GPT / Reserve 请求改成第三方模型。

## 5. Cross-model failover：必须显式授权

当前长期政策：

```text
failover.enabled = false
failover.chain = []
```

或仅在用户明确授权时：

```text
failover.enabled = true
AND
failover.chain = [明确命名的 fallback slug ...]
```

绝不能把：

```text
enabled=true + chain=[]
```

解释成“Router 可以自己挑一个替代模型”。

普通 turn、quota/cooldown、payload failure、compaction 都必须遵守同一身份边界。宁可明确失败，也不要隐藏替换模型。

升级验收必须运行：

```powershell
node .\src\control.mjs failover status
```

并确认没有 upstream 新逻辑重新启用自动排名 / 自动切模型。

## 6. Issue #522 / PR #523：custom-tool SSE 断流修复

### 症状

第三方模型已经正常工作并执行工具后出现：

```text
stream disconnected before completion
stream closed before response.completed
Reconnecting 1/5 ... 5/5
```

Router 日志典型标记：

```text
ERR_NAMESPACE_RELAY_COMMITTED_STREAM
invalid custom tool arguments done
```

### 根因

LiteLLM 已经把 opening 转成 native：

```text
response.output_item.added
item.type = custom_tool_call
```

但后续 legacy argument event 仍使用：

```json
{"content":"..."}
```

旧 Router 对所有 bridged custom tool 都按：

```json
{"input":"..."}
```

解析，导致工具调用结束阶段失败；这时 stream 已经 committed，Router 无法安全 retry，于是 Codex 收不到 `response.completed`。

### upstream 修复

Issue / PR：

```text
#522  reported failure
#523  fix: preserve native custom tool streams
feature commit: 08616728b56f6ac6e6c09631296cf47db7397d99
merge commit:   102f0087bb66699e9a93fef4fa3f079d55523960
```

2026-09-05 已对当前 dirty v0.5.1 工作树执行**最小化 backport**，没有整体 update、没有 cherry-pick merge commit。

实际保留的功能行为：

```text
Router 自己 bridge 的 custom tool
→ 参数继续读取 property "input"

LiteLLM opening 已经是 native custom_tool_call
→ 后续 legacy arguments delta/done 读取 property "content"
```

关键文件：

```text
src/namespace-relay.mjs
test/namespace-relay.test.mjs
test/routing.test.mjs
```

没有因为 #523 去改 `AGENTS.md`。

### #523 离线回归

已加入并通过：

```text
native custom-tool streams accept LiteLLM content-wrapped legacy argument events
native custom-tool legacy arguments still fail closed when streamed input changes
router repairs LiteLLM legacy argument events for native Z.ai custom tools
```

2026-09-05 验收：

```text
namespace relay focused tests: PASS
router integration focused test: PASS
npm run check: PASS
syntax checks passed
```

下次升级到包含 #523 或更高版本时，不要机械重复 backport；先检查目标 upstream 的 `src/namespace-relay.mjs` 是否已经包含等价逻辑。若已包含，则 DROP 当前本地 #523 patch，但保留/运行回归测试确认行为仍在。

## 7. `test/routing.test.mjs` 有多个本地来源，禁止整文件覆盖

当前 `test/routing.test.mjs` 同时至少包含：

```text
A. Xkiro Claude Opus 5 payload-size protection regression
B. #523 native custom-tool stream Router integration regression
```

因此后续升级禁止：

```text
checkout 整个 test/routing.test.mjs
restore 整个 test/routing.test.mjs
直接用 upstream 文件覆盖本地版本
```

必须按测试块 / patch family 逐项 merge。

## 8. Xkiro Claude Opus 5 payload 保护不能被 #523 或升级覆盖

当前本地证据：

```text
route = xkiro/anthropic/claude-opus-5
context_window = 1,000,000
auto_compact_token_limit = 230,000
serialized request safety limit = 1,150,000 bytes
measured provider failure edge ≈ 1.19 MB
```

相关本地文件包括：

```text
src/provider-payload-limits.mjs
src/api-forwarder.mjs
src/model-registry.mjs
src/router.mjs
test/provider-payload-limits.test.mjs
test/routing.test.mjs
```

这是一条 exact-route payload workaround，不是把 Opus 5 context window 改成 230K，也不能无证据推广到其他 Xkiro 模型。

## 9. 其他当前未提交 patch family，升级前必须逐项审计

截至 2026-09-05，除 #523 外还要保护：

```text
verify-model + CLI/UI integration
Command Code >64-character tool-name aliasing
Control Center Provider-first Picker
Control Center Provider-scoped Add Models
Blocked model Verify & add
Control Center Codex Native Agent Mode（Single / Sol + Luna Team）
curated default display name → Provider display name
Windows Control Center PID-reuse lifecycle fix
Xkiro Opus 5 payload-aware context protection
explicit-consent-only cross-model failover
Antigravity provider/client-secret related local work
相关 focused regression tests
```

这些 patch 不是“全部必须永久保留”；目标 release 如果已吸收，应 DROP 本地 patch，并以 focused tests 证明 upstream 行为等价。

## 10. 旧补丁仍然只作为历史资料

除非新的证据证明 upstream 回归，否则不要恢复：

```text
windows-router-proxy-fix.patch
windows-service-orphan-fix.patch
old apps/desktop / Tauri GUI patches
```

当前代理应继续由 Router 原生状态维护：

```text
install-manifest.json
→ serviceProxyEnvironment()
→ generated Windows launcher
→ NODE_USE_ENV_PROXY=1
→ EnvHttpProxyAgent
→ 127.0.0.1:7890
```

## 11. Control Center 本地功能必须保留/比较

升级前后核对：

```text
renderer test locale = en-US（测试层，不破坏生产中文）
Windows Limited-token / Integrity Level 打开窗口机制
Tray recovery + ACL structural comparison
UI scale 持久化（本机 120%，默认仍 100%）
Skill profile controls
Codex mode controls
Codex Native Agent Mode：Single / Sol + Luna Team（独立于 Router setSubagentMode）
Provider account-usage timeout 容错
Provider-first Picker
Provider-scoped Add Models
Verify & add
curated Provider provenance display
Windows PID-reuse lifecycle fix
release-recovery 保护
```

不要恢复旧 `apps/desktop` / Tauri GUI。

## 12. 下次升级的强制流程

### Stage 0 — 只读 inventory

```powershell
cd "$env:LOCALAPPDATA\codex-router"

git status --short
git branch --show-current
git rev-parse HEAD
git log -10 --oneline --decorate
node -p "require('./package.json').version"

node .\src\config-manager.mjs status
node .\src\control.mjs failover status
node .\src\service.mjs status
node .\src\tray-service.mjs lifecycle
.\codex-router.ps1 tray status
Invoke-RestMethod http://127.0.0.1:4202/health
```

另存：

```text
完整 git diff
untracked file list
config.toml
install-manifest.json
user-models.json
model-picker.json
multi-agent-settings.json
failover.json（如存在）
provider credentials（只备份，不输出内容）
.codex\agents
release-recovery
Control Center transaction journal
```

### Stage 1 — 选择明确 upgrade target

只使用：

```text
official release tag
or exact commit
```

禁止：

```text
git pull origin main
git reset --hard
git clean -fd / -fdx
whole stash pop/apply
blind cherry-pick of large version jump
```

### Stage 2 — patch family 对比

每一族：

```text
1. inspect upstream
2. upstream 已解决 → DROP local patch
3. upstream 未解决 → PORT minimum missing behavior
4. run focused tests
5. 保留用户状态和 Provider credentials
```

### Stage 3 — 身份 / Picker 验收

必须确认：

```text
login_free = false
model_provider = openai
openai_base_url present
model_catalog_json present
native-aliases.json aliases = {}
原生 GPT 显示真实 GPT 名称并真实走 OpenAI
第三方显示真实 Provider/model 名称
failover 不得自动跨模型
```

### Stage 4 — #523 验收

至少运行：

```text
native custom-tool content-wrapper focused tests
Router native custom-tool integration test
npm run check
```

若目标 upstream 已包含 #523，不再重复移植，但必须证明上述测试仍通过。

### Stage 5 — 最终 Desktop 验收

完整退出并重新打开 Codex Desktop 后确认。注意：Picker 显示正常只是第一层验收，必须实际确认第三方 turn 能进入 Router；不能再把“能看到第三方模型”当作修复完成。

```text
原生 GPT + 第三方真实模型同时存在
Picker 中没有 GPT slug 冒充第三方
选择第三方后，Desktop 必须产生 turn/start
Router 必须收到该第三方真实 slug 的 POST /responses
第三方 custom_tool_call 不再触发 #522 reconnect loop
routed subagent 仍可用
Router health ok=true / degraded=[]
```

真实 provider probe / Codex turn 可能消耗额度；没有用户明确批准时，只做离线测试和只读健康检查。

## 13. 2026-09-05 当前已验证运行快照

在撤销 Reserve 冒充方案、保留 #523 后：

```text
mode = router
model = commandcode/deepseek-v4-flash
model_provider = openai
login_free = false
openai_base_url = local Router caller URL
model_catalog_json = C:\Users\73428\.codex\codex-router\merged-models.json
native aliases = {}
failover.enabled = false
failover.chain = []
Router service = running
health.ok = true
health.degraded = []
```

### 13.1 追加发现：Picker 恢复不等于发送链路恢复

2026-09-05 实机测试证明，上述快照只能说明 Hybrid catalog 和 Picker 展示层正常，**不能说明 quota exhausted 状态下第三方模型已经可以发送**。

本机 Codex Desktop `26.901.5280.0` 在 OpenAI 原生额度耗尽时记录到：

```text
2026-09-05T13:38:33.134Z
model=gpt-5.6-terra provider=openai status=429
```

Desktop 同时明确报告：

```text
You've hit your usage limit ... try again at Sep 6th, 2026 7:31 PM.
```

随后在 `13:50:00` 新建 thread 成功，但没有 `turn/start`，Router 也没有任何新的 `POST /responses`。这证明后续“点击发送无反应”发生在 Codex Desktop / App Server 内部，尚未进入 Router，因此不是 #523、provider transport 或 SSE 故障。

只读检查当前 Desktop `app.asar` 后确认 Luna Reserve 存在第二层独立逻辑：当 `isLunaReserveActive=true` 时，Composer 无条件执行等价于：

```js
modelSettings = { ...modelSettings, model: "gpt-reserve" }
```

该条件目前没有区分 OpenAI native model 和 `commandcode/...`、`xkiro/...` 等 routed external model。因此即使 Router 已经让 Picker 同时显示真实 GPT 和真实第三方模型，Reserve 状态仍可能在 Composer 层覆盖/阻止第三方 turn。

强制规则：

```text
Picker / merged catalog 中禁止用任何 GPT slug 冒充第三方模型，避免误导使用者。
允许在发送链路内部仅对 Desktop 强制产生的 gpt-reserve 做 identity-recovery，恢复到用户明确选择的第三方真实 route。
真正的 gpt-5.6-sol / terra / luna / astra 等请求绝不能进入这条恢复逻辑。
这种 reserve-only 恢复不是 failover：目标必须来自用户持久化的明确模型选择，Router 不得自行挑模型。
在没有验证 turn/start + Router POST 前，不得宣称 Picker/Reserve 问题已经完全解决。
```

### 13.2 Reserve-only transport redirect（2026-09-05，第一阶段）

优先采用 Router 侧发送层兼容，暂不修改 WindowsApps / `app.asar`。第一阶段实现：

```text
Picker 显示：commandcode/deepseek-v4-flash
Codex config 根 model：commandcode/deepseek-v4-flash
Desktop Luna Reserve 覆盖发送 model：gpt-reserve
Router 收到 gpt-reserve
  -> 读取 config.toml 根 model
  -> 仅当它是当前已启用、已注册的 routed model 时恢复该 route
  -> 真正发送到 commandcode/deepseek-v4-flash
```

边界必须保持：

```text
gpt-reserve + persisted external selection -> 可恢复第三方 route
gpt-5.6-terra + persisted external selection -> 仍走真 OpenAI Terra
gpt-5.6-sol / luna / astra 等 -> 仍走各自真 OpenAI native route
native-aliases.json -> 不需要为此写 alias，正常 Hybrid 保持 {}
native-redirect.json -> 不使用全 native redirect；它会把真 GPT 一并改道，不符合当前身份规则
failover.enabled=false / chain=[] -> 不变
```

实现位置：

```text
src/native-redirect.mjs
  RESERVE_NATIVE_SLUG
  readReserveRedirectTarget()

src/router.mjs
  仅 requestedModel === gpt-reserve 时调用 reserve-only restore

test/native-redirect.test.mjs
  验证只读取 config.toml 根部持久化 model

test/routing.test.mjs
  验证 gpt-reserve 恢复 routed model，同时真 gpt-5.6-terra 仍走 native
```

离线验收：`test/native-redirect.test.mjs` 5/5 PASS；focused routing reserve test 1/1 PASS；`npm run check` PASS。随后真实 Router 与 bundled App Server 测试均证明 `gpt-reserve -> commandcode/deepseek-v4-flash` 可完成 HTTP 200 / `turn/completed`，但 Desktop Renderer 仍没有产生 `turn/start`，发送按钮和回车均无效。因此第一阶段只能修复“请求到达 Router 后如何恢复真实 route”，不能绕过 Renderer 的发送前 gate。

进一步只读检查 `app.asar` 确认：Renderer 从 ChatGPT `/conversation/init` 读取 `blocked_features / limits_progress`，`sendBlocked` 被直接并入 `submitDisabled`。`/conversation/init` 的 `requested_default_model` 使用当前 Picker slug。因此 canonical 第三方 slug 在原生额度耗尽时会先被 ChatGPT quota gate 禁用，根本没有机会进入 Router。

### 13.3 Truthful Reserve Bridge（2026-09-05，已被 Desktop 实机否定）

不修改 Codex Desktop。用户允许内部传输层借用 Reserve slug，但要求 Picker 绝不能把第三方伪装成 GPT。该实验方案把 `gpt-reserve` 当作**仅在额度耗尽期间使用的协议槽位**，同时把该条目的显示名称和能力元数据改成用户明确选择的真实第三方模型。随后 Desktop 实机测试证明：周额度 100% 耗尽时 Renderer 仍会把 Composer 全局 `sendBlocked`，即便 Picker 已选中 `gpt-reserve` 也没有 `turn/start`。因此此 bridge 仅保留为诊断/兼容代码，日常应急方案改为 `auth-mode on` / login-free；当前 bridge 必须保持关闭。

当前开启状态：

```text
reserve-bridge.enabled = true
reserve-bridge.model = commandcode/deepseek-v4-flash
internal/native slot = gpt-reserve
Picker display = DeepSeek V4 Flash (Command Code) (Reserve bridge)
Router alias = gpt-reserve -> commandcode/deepseek-v4-flash
failover.enabled = false
failover.chain = []
```

关键身份边界：

```text
gpt-reserve
  -> 可以作为 Reserve bridge 的内部传输 slug
  -> Picker 必须显示真实第三方名称，并明确标注 Reserve bridge

gpt-6-astra
 gpt-5.6-sol
 gpt-5.6-terra
 gpt-5.6-luna
  -> 永远保持 OpenAI 原生 slug、原生名称、原生路由
  -> reserve bridge 绝不能为这些 slug 创建 alias
```

当前磁盘发布结果已核对：

```json
{
  "version": 1,
  "aliases": {
    "gpt-reserve": "commandcode/deepseek-v4-flash"
  }
}
```

`merged-models.json` 中：

```text
gpt-reserve
  display_name = DeepSeek V4 Flash (Command Code) (Reserve bridge)
  visibility = list

commandcode/deepseek-v4-flash
  visibility = hide
  # 避免同一个真实模型出现两个 Picker 行

gpt-6-astra / gpt-5.6-sol / terra / luna
  display_name / slug 均保持原生
```

实现文件：

```text
src/paths.mjs
  RESERVE_BRIDGE_PATH

src/reserve-bridge.mjs
  readReserveBridge()
  reserveBridgeSnapshot()
  setReserveBridge()
  clearReserveBridge()

src/catalog.mjs
  buildReserveBridgeCatalog()
  只替换 gpt-reserve 条目的显示/行为元数据
  只写 gpt-reserve -> routed target 的 alias

src/control.mjs
  reserve-bridge status
  reserve-bridge on [routed-model-slug]
  reserve-bridge set <routed-model-slug>
  reserve-bridge off
  catalog 发布失败时回滚 bridge 状态
```

验证结果：

```text
test/reserve-bridge.test.mjs                    3/3 PASS
catalog reserve bridge focused test             1/1 PASS
routing real-GPT isolation focused test          1/1 PASS
npm run check                                    PASS
bundled App Server model/list                    PASS
bundled App Server gpt-reserve turn              completed
Router timing                                    commandcode/deepseek-v4-flash / commandcode / 200
Router health                                    ok=true / degraded=[]
```

最终 Renderer 验收仍必须在**完整退出并重开 Codex Desktop 后**人工点击该 Reserve bridge 行并发送一条最小消息。成功标准：按钮/回车恢复可用、Desktop 产生 `turn/start`、Router timing 显示 `provider=commandcode model=commandcode/deepseek-v4-flash status=200`。如果 Truthful Reserve Bridge 仍无法越过 Renderer gate，才进入 Desktop 侧补丁路线；在此之前禁止修改 WindowsApps / `app.asar`。

升级时这是一项必须显式比较的 patch family。若 upstream 后续修复 Luna Reserve 对 routed/custom models 的 quota gate，则优先 DROP 本地 bridge；否则 KEEP/PORT。绝不能把它退化成“GPT-5.6 Sol/Terra/Luna 显示名不变但内部偷偷跑第三方”的实现。

### 13.4 Xkiro Opus 5 父 Agent v2 兼容（2026-09-05）

周额度耗尽后使用 `auth-mode on` / login-free 可以继续让第三方主模型工作，但实机发现 `xkiro/anthropic/claude-opus-5` 在 catalog 中默认为 `multi_agent_version=v1`。Codex 因此给它暴露 legacy multi-agent surface；Opus 5 实际连续生成了：

```text
multi_agent_v1__spawn_agent
```

Codex 当前工具执行器随后直接返回：

```text
unsupported call: multi_agent_v1__spawn_agent
```

这证明问题不是 Opus 5 不会规划或不会调用工具，而是父模型落在已失效的 v1 collaboration surface。修复采用**父 Agent 专用 v2 opt-in**，不把 Opus 5 伪装成已认证子 Agent：

```text
node .\src\control.mjs subagents parent xkiro/anthropic/claude-opus-5 on
```

关闭：

```text
node .\src\control.mjs subagents parent xkiro/anthropic/claude-opus-5 off
```

持久状态写入现有 `multi-agent-settings.json`：

```json
{
  "parentEnabled": ["xkiro/anthropic/claude-opus-5"]
}
```

实现边界：

```text
src/multi-agent-state.mjs
  parentEnabled 独立于 enabled/disabled 子 Agent 选择
  applyMultiAgentParentCapabilities() 只用于发布给 Codex 的 model catalog

src/catalog.mjs
  parent v2 overlay 只进入 merged catalog
  managed child-agent definitions 仍由未加 parent overlay 的 routedModels 决定

src/control.mjs
  subagents parent <model-slug> on|off
  不启动 provider compatibility probe，不消耗 Provider 额度
```

当前实机状态：

```text
xkiro/anthropic/claude-opus-5
  Picker = visible
  multiAgentVersion = v2  # parent-side catalog only
  managed Opus child agent definition = absent

commandcode/deepseek-v4-flash
  child subagent selection = On
  multiAgentVersion = v2
```

bundled Codex App Server `model/list` 已确认 Opus 5 实际读取为 `multiAgentVersion=v2`。离线回归：`test/multi-agent-state.test.mjs` 10/10 PASS；catalog/control focused suite 124 PASS、2 SKIP、0 FAIL；`npm run check` PASS；`git diff --check` PASS。真实 `spawn_agent` 派发仍必须由用户在重启 Desktop 后发起，因为它会消耗 Xkiro/Command Code 实际额度。成功标准是日志中不再出现 `multi_agent_v1__spawn_agent`，而是进入当前 v2 collaboration 路径，并产生真实 child turn。

### 13.5 Xkiro Opus 5 作为 v2 Parent 的 already-flat collaboration 回程修复

2026-09-05 在 `xkiro/anthropic/claude-opus-5` 开启 parent-only v2 后，新建 thread 已证明父模型 capability 切换成功：旧 thread 的 `multi_agent_v1__spawn_agent` 消失，新 thread 改为调用 `collaboration__spawn_agent` / `collaboration__list_agents`。但 Codex Tool Router 仍返回：

```text
unsupported call: collaboration__spawn_agent
unsupported call: collaboration__list_agents
```

最新失败 thread：

```text
01a072c4-d787-7dc2-a27d-e8036cabee69
```

首轮定位认为 namespace response restore 仍有兼容缺口：Codex 26.901 在当前 routed v2 parent surface 中可能把部分内建 collaboration 工具以**已经扁平化的 ordinary function** 形式交给 Router。旧 `flattenNamespaceTools()` 只把真正的 `type=namespace` 记录进 namespace lookup，因此补上 already-flat built-in 的 request-local native identity restore 是合理的防护。**但 13.6 的服务重启后实测证明，这不是当次 `unsupported call` 的最终主因**：App Server 的 `multi_agent_v2` feature gate 实际仍为 false。保留本节补丁作为 namespace 兼容层，但不能再把它单独视为此次故障闭环。

修复位置：

```text
src/namespace-relay.mjs
```

规则：

```text
仅识别 Codex 内建 collaboration 名称：
  spawn_agent
  list_agents
  wait_agent
  interrupt_agent

incoming plain function collaboration__<built-in>
  -> provider-visible name 保持不变
  -> request-local namespace lookup 记录为
       namespace=collaboration / name=<built-in>
  -> 标记 semantic flattening，使后续 native history 同样写回 provider wire name
  -> response restore 回 Codex native namespace shape

任意未知 collaboration__foo
任意其他 foo__bar
  -> 保持普通函数，不做字符串猜测
```

同时 `initialFunctionIdentities()` 也按同一白名单登记 native identity，保证 Command Code 的 64 字符 alias/collision 机制不会把内建 collaboration 工具误认成普通同名函数。

新增回归覆盖：

```text
test/namespace-relay.test.mjs
  already-flat Codex collaboration functions retain native restore identity
```

验证：

```text
namespace-relay + subagent completion + multi-agent state: 131/131 PASS
npm run check: PASS
git diff --check: PASS
```

该 patch family 与 #523 不同：#523 修 native custom-tool stream；这里补 Codex 26.901 routed v2 parent 的 already-flat collaboration identity restore。升级时若 upstream 已覆盖此行为，DROP；否则最小 PORT，并保留未知 `__` 普通函数不被误拆的负向测试。

### 13.6 最终主因：managed `multi_agent_v2` 配置可解析但实际上未启用

在 13.5 补丁生效并执行 `service restart` 后，同一新 thread 仍然立即返回：

```text
unsupported call: collaboration__spawn_agent
```

此时进一步只读核对实际运行环境：

```text
Desktop = OpenAI.Codex_26.901.5280.0
bundled app-server binary = C:\Users\73428\AppData\Local\OpenAI\Codex\bin\27d6a192e9c98618\codex.exe
bundled codex-cli = 0.153.4
PATH npm codex-cli = 0.144.1
running app-server = bundled 0.153.4（不是旧 PATH CLI）
```

因此排除了“Desktop 启动了旧 npm Codex”的假设。真正决定性证据来自 bundled CLI：

```text
codex features list

multi_agent     stable  true
multi_agent_v2  stable  false
```

而 Router 当时写入的是：

```toml
[features]
multi_agent_v2 = { max_concurrent_threads_per_session = 6, usage_hint_enabled = true, ... }
```

Codex 0.153.4 **允许该 map 通过配置解析，但 map 的存在本身不会启用 feature**。所以形成了不一致状态：

```text
Opus catalog multi_agent_version = v2
  -> 模型看到了 collaboration/spawn_agent

App Server feature multi_agent_v2 = false
  -> v2 runtime handler 没有启用

模型返回 collaboration__spawn_agent
  -> Codex Tool Router: unsupported call
```

OpenAI 当前 `MultiAgentV2ConfigToml` 也把 `enabled` 定义为独立字段；实机无网络推理测试进一步确认：

```text
codex -c features.multi_agent_v2.enabled=true features list
-> multi_agent_v2 stable true

再加：
-c features.multi_agent_v2.expose_spawn_agent_model_overrides=true
-> 配置仍正常，multi_agent_v2 = true
```

因此修复 `src/config-manager.mjs`：

```text
managed multi_agent_v2 行必须包含 enabled = true
优先探测并发布 expose_spawn_agent_model_overrides = true
候选配置不能只验证“能解析”；优先用 `codex features list` 验证 effective gate=true
只有不支持 `features list` 的旧构建才退回 parse-only 探测
```

当前本机已通过幂等：

```text
node .\src\control.mjs auth-mode on
```

重新发布为：

```toml
multi_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 6, expose_spawn_agent_model_overrides = true, usage_hint_enabled = true, ... }
```

随后实机确认：

```text
multi_agent     stable  true
multi_agent_v2  stable  true
```

当前 thread `01a072c4-d787-7dc2-a27d-e8036cabee69` 的 rollout 本身已记录：

```text
cli_version = 0.153.4
model = xkiro/anthropic/claude-opus-5
model_provider = codex-router
multi_agent_version = v2
```

所以该 thread 不因 v1/v2 身份需要废弃；但它创建/运行时的 App Server 是在 feature 修复前启动的。**最终实机验收必须完整退出并重新打开 Codex Desktop，使 app-server 重新读取 `multi_agent_v2=true`，然后优先在该 v2 thread 中重试一次 spawn。** 若仍失败，再新建 fresh thread 区分 resume-time session config；在这一步之前不得继续给 namespace relay 叠加猜测补丁。

回归：

```text
config-manager focused tests: PASS
multi-agent-state: 10/10 PASS
namespace focused restore tests: 2/2 PASS
npm run check: PASS
git diff --check: PASS
```

升级验收新增硬门槛：只检查 `config.toml` 中存在 `multi_agent_v2` 不够，必须对目标 bundled Codex 执行 `features list` 并得到 `multi_agent_v2 ... true`；否则任何 v2 parent/subagent catalog 发布都属于“工具可见、执行器不可用”的假成功。

## 2026-09-05 Desktop routed-parent namespace 大首帧回归

后续实机排除旧 thread、Desktop/App Server 未重启、`multi_agent_v2=false`、模型 override 参数和 request-local namespace lookup 后，Xkiro Opus 5 仍出现：

```text
collaboration__spawn_agent
-> unsupported call
```

Router trace 已确认请求侧含完整 `collaboration` namespace，响应也明确为 `text/event-stream`。真正的本地可复现断点是 `NamespaceToolCallTransform` 在首次 semantic mutation 之前只允许单个 SSE frame 为 256 KiB，而 LiteLLM 1.96.0 的 Responses <- Chat bridge 会把 `instructions` 与完整 `tools` catalog 回显到 `response.created` / `response.in_progress`。Desktop 的 collaboration、apps、computer use、MCP 等完整工具目录可以超过旧上限，于是首帧触发 raw fail-open 并永久关闭本次 response 的 namespace restore；后续扁平名因此原样泄漏给 Desktop。

离线回归在 300 KiB `response.created` 后追加 `collaboration__spawn_agent`，旧行为稳定复现：

```text
leaked=true
restored=false
```

本地修复把初始 `MAX_SSE_FRAME_BYTES` 提升为严格有界的 2 MiB；Xkiro Opus 5 自身已有约 1.15 MB serialized-request safety boundary，因此足以容纳该 route 的回显工具目录，同时保留显式测试传入较小 `maxSseFrameBytes` 时的原 fail-open 安全行为。修复后同一离线夹具为：

```text
leaked=false
restored=true
```

新增正式回归：`large LiteLLM response prelude does not disable later namespace restoration`。当前结果：

```text
namespace + multi-agent focused: 123/123 PASS
routing + native-redirect:       101/101 PASS
npm run check:                   PASS
git diff --check:                PASS
```

当前项目仍固定 LiteLLM 1.96.0。LiteLLM 上游 PR #32536 / v1.98.0 已加入原生 Codex namespace bridge（请求 flatten、stream/non-stream restore、history requalification），但 Router 当前自己先做 namespace flatten；因此不得把“升级到 1.98+”当作无条件替代补丁。未来升级 LiteLLM 时必须重新决定 namespace 所有权并做 Desktop E2E，而不是同时保留两层未经审计的 flatten/restore。

**状态更新：该 namespace 修复已经通过 Codex Desktop 真实 E2E。Opus 5 成功调用 `spawn_agent`，Desktop 创建 `/root/ai1_pdf_filename_finish` child，role=`router_commandcode_deepseek_v4_flash`，child turn 的实际 model=`commandcode/deepseek-v4-flash`。随后暴露的是独立的 encrypted handoff 401，见下一节。**

## 2026-09-05 routed parent -> third-party child encrypted handoff

Desktop 真实 child 创建成功后，AI 1 仍在首次执行阶段被中断。Router 日志证明这不再是 spawn/namespace 故障：child 已进入 `commandcode/deepseek-v4-flash`，但其 `NEW_TASK` handoff 包含原生 Fernet 形态 `encrypted_content`。Router 的既有兼容会调用 native OpenAI `/responses` 作为 transport relay 解包；当前 login-free / `auth-mode on` 请求只有 Router caller capability，而 ChatGPT native-session sharing 明确处于关闭状态，因此该 relay 连续得到 HTTP 401：

```text
spawn_agent restored / executed                 PASS
child thread created                            PASS
child model = commandcode/deepseek-v4-flash     PASS
Native collaboration payload relay              HTTP 401
child execution                                 interrupted
```

只读状态检查仅报告凭据元数据：本机 Codex session `present=true / usable=true / expired=false`，但 `sharingEnabled=false / fallbackEnabled=false`。**不得为了修复第三方 subagent 自动开启 session sharing**：这是显式用户授权边界，而且在周额度耗尽的 login-free 场景里，让每个 third-party child 依赖一次原生 GPT relay 会违背第三方应急模式的目标。

因此增加无原生额度的 routed-parent handoff cache：

```text
routed Parent 的 collaboration.spawn_agent 回程
  -> 若 args.message 是明文
  -> 以 hash(parent_thread_id + canonical task_name) 暂存，TTL 15 分钟、容量有界

Desktop 创建 child 并把任务封成 gAAAA... encrypted_content
  -> child 请求携带 x-codex-parent-thread-id + Task name
  -> Router 优先命中 parent task cache
  -> 明文直接变成 input_text 发给 third-party child
  -> 不调用 native OpenAI payload relay

cache miss / parent message 本身已是 native token
  -> 保持现有 native relay fallback，不猜测、不伪解密密文
```

实现涉及：

```text
src/namespace-relay.mjs
  NamespaceToolCallTransform 增加完成态 spawn_agent observer
  观察失败不得改变 provider wire 或 Codex dispatch

src/router.mjs
  bounded spawnTaskCache
  parent thread + task name 隔离
  child handoff cache hit 优先于 native relay
  health 仅暴露计数/字节/TTL，不暴露任务正文或 thread id
```

新增 Router E2E 将 native endpoint 固定为 401，同时模拟 routed Parent 返回明文 `spawn_agent.message` 和 child 收到 `gAAAA...`；结果 child 仍为 HTTP 200、native relay 调用次数严格为 0、第三方 child 实际收到明文任务。

当前离线验收：

```text
namespace + multi-agent + routing: 220/220 PASS
npm run check:                    PASS
git diff --check:                 PASS
```

真实 Desktop 随后证明 Parent 回程实际是 `message=native-token`，所以该 cache 设计作为安全 fallback 保留，但**不能作为 routed Parent -> third-party child 的主解决方案**。五次 AI 1 spawn 的 `message` 都是 Fernet 形态且 SHA-256 不同，历史上真正成功的原生 GPT / routed Luna spawn 记录也同样使用 native ciphertext；因此这不是 Opus 简单复制一次旧 token，而是 Codex MultiAgent V2 的加密 message contract。开启用户明确授权的 ChatGPT session sharing 后，relay 从 HTTP 401 变为 HTTP 429，进一步证明原生 relay 会消耗/受制于当前 ChatGPT/Codex 周额度，不能承担“额度耗尽时第三方 subagent 仍可工作”的主路径。

### 官方 DirectPlaintextMessage 兼容层

OpenAI Codex 当前 V2 已有正式的跨-provider plaintext handoff 分支：`collaboration.spawn_agent`、`send_message`、`followup_task` 的完成态 function call 若携带 `encrypted_function_args: []`，Tool Router 会选择 `DirectPlaintextMessage`，随后以普通 `input_text` 给 child，而不是构造 `encrypted_content`。对应 tool schema 的 `message` 本意也是 plain-text task，只是 native OpenAI parent 定义会用 `encrypted: true` 要求 Responses 层保护该参数。

因此 routed third-party Parent 的 Router 兼容改为复用这一官方协议，而不是解密 `gAAAAA...`：

```text
Codex Desktop native collaboration schema
  -> Router provider-facing copy only
  -> 对 spawn_agent/send_message/followup_task 的 message 去掉 encrypted:true
  -> 增加明确描述：第三方 routed Parent 必须生成当前任务的 literal plaintext，不能复用历史 gAAAAA token

stored collaboration history
  -> 若 message 是 native gAAAAA ciphertext
  -> 只替换 message 为“历史 encrypted payload 不可复用”的 routed-provider placeholder
  -> 保留 task_name / agent_type / target / fork_turns / model 等其余元数据
  -> 不修改 Codex 自己保存的原始 rollout/history

third-party Parent response
  -> Router 恢复 {name, namespace}
  -> 若 message 确实是 plaintext，补 encrypted_function_args: []
  -> Codex Desktop 进入官方 DirectPlaintextMessage 分支
  -> child 收普通 input_text，不需要 native OpenAI relay

若 provider 仍返回 gAAAAA ciphertext
  -> 绝不伪标 encrypted_function_args: []
  -> 保持 fail-safe，继续诊断 provider-facing schema/history
```

`src/namespace-relay.mjs` 当前实现覆盖 native namespace、Desktop 显式 `{type:function, namespace:collaboration}` 与 already-flat `collaboration__*` 三种工具定义。新增 focused 回归覆盖：

```text
provider-facing spawn message encrypted marker stripped without mutating client schema
already-flat send_message encrypted marker stripped
native ciphertext history replaced while task metadata survives
plaintext spawn/send/followup restore with encrypted_function_args=[]
native ciphertext never mislabeled as plaintext
streaming added -> done -> completed lifecycle carries marker only after complete plaintext args
```

当前验证：

```text
namespace-relay: 119/119 PASS
routing:          97/97 PASS
npm run check:    PASS
git diff --check: PASS
```

### 2026-09-05 最终真实 Desktop E2E：retry_4 已成功闭环

上述成功标准已经由真实 Codex Desktop 任务 `/root/ai1_pdf_filename_retry_4` 达成，不再是“等待下一次验证”的假设状态。

Parent rollout 的完成态 collaboration call 已观察到：

```text
name = spawn_agent
namespace = collaboration
message = literal plaintext AI 1 task
encrypted_function_args = []
```

这证明 routed Parent 不再返回 `gAAAAA...` 作为本次 delegation message，而是进入 Codex 官方 `DirectPlaintextMessage` 分支。Desktop 随后真实创建 child，child route / provider 精确为：

```text
agent_thread_id = 01a074ce-3e65-7813-8566-a8013cfc050b
agent_path      = /root/ai1_pdf_filename_retry_4
model           = commandcode/deepseek-v4-flash
provider        = commandcode
```

Router 日志随后连续记录 `commandcode/deepseek-v4-flash` HTTP 200，而不是仅停留在 `agent_status=running`。同时 PDF/图像验收路径也实际触发并成功：

```text
vision-bridge
engine=commandcode/deepseek/deepseek-v4-flash-vision-exp
images=1
described=1
failed=0
```

因此本次真实 E2E 已证明完整链路：

```text
Xkiro Claude Opus 5 routed Parent
  -> provider-facing plaintext collaboration schema/history
  -> literal plaintext spawn_agent.message
  -> Router restore native collaboration namespace
  -> encrypted_function_args=[]
  -> Codex DirectPlaintextMessage
  -> child receives input_text
  -> commandcode/deepseek-v4-flash executes real work
  -> provider HTTP 200 + vision bridge success
```

在这条成功的 `retry_4` 执行中，不再出现此前阻塞 child 的 `Native collaboration payload relay failed with HTTP 401` / `HTTP 429`，也不再出现由该 handoff 链路触发的 Router 502。旧 401/429/502 记录属于早期失败尝试，不得在后续验收中误判为当前故障。

### 原生会员额度恢复后的兼容保护

最终 routed plaintext 修复不得破坏会员额度恢复后的正常 native OpenAI subagent。当前代码路径已经确认存在明确隔离：

```text
selected model has Router route
  -> routed third-party path
  -> namespace/plaintext compatibility may apply

selected model has no Router route
  -> route = undefined
  -> native OpenAI passthrough
  -> original native collaboration schema/handoff
```

native turn 的 `NamespaceToolCallTransform` 使用：

```text
injectOnly = true
```

因此 native response stream 只承担必要的 finished-child close/injection 行为，不执行 routed path 的 namespace response rewrite、plaintext collaboration rewrite 或 `encrypted_function_args=[]` 标记。会员额度恢复后应保留：

```text
Native OpenAI Parent
  -> route = undefined
  -> native passthrough
  -> native encrypted subagent handoff
  -> 不受 third-party DirectPlaintextMessage 补丁影响

Routed third-party Parent
  -> DirectPlaintextMessage
  -> third-party child
  -> 不依赖 native GPT decrypt relay / native weekly quota
```

因此额度恢复后不应回滚本补丁，也不应把 native GPT Picker slug alias 到第三方模型。正常 quota 状态可恢复 `auth-mode off`；第三方 routed Parent 的 plaintext handoff 与 native OpenAI 的 encrypted handoff 应长期并存。

临时 namespace/handoff trace 只用于本次定位，不是下一次升级必须保留的语义补丁；真正必须保留的是 request-local namespace restore、2 MiB bounded SSE prelude、DirectPlaintextMessage compatibility、ciphertext fail-safe，以及 native `injectOnly=true` 隔离。

## Command Code 每模型计费 / Control Center Usage Accounting（2026-09-06）

已实现 Router 本地每请求计费快照，并与 Command Code 官方账户总额度分层展示。原则是：**官方账户 API 负责总账户余额/窗口，Router ledger 负责每模型归因，不伪造官网没有提供的历史模型账单。**

实现链路：

```text
Command Code response usage
  -> normalizeTokenUsage
     input / cache read / cache write / output
  -> usage-events.jsonl
     commandCodeBilling snapshot at request time
  -> aggregateCommandCodeSpend
     5h / weekly / 30d / all tracked
  -> provider-usage
     official account metrics + local model attribution
  -> Control Center / Usage
```

关键文件：

```text
src/commandcode-billing.mjs
src/usage-events.mjs
src/response-usage.mjs
src/commandcode-stream.mjs
src/provider-account-usage.mjs
src/provider-usage.mjs
apps/control-center/src/pages/UsagePage.tsx
apps/control-center/src/pages/usage-status.css
apps/control-center/src/types.ts
```

计费规则以请求发生时的价格快照为准。当前 pricing snapshot 标记为：

```text
goat-2026-09-06
source: https://commandcode.ai/docs/plans/goat
```

GOAT credit equivalent 使用官方规则：full-allowance 模型 1 credit 对应 $1 usage value；低 allowance 模型按 `70 / model_monthly_allowance` 放大。DeepSeek V4 Flash 的 UTC peak/off-peak 价格在请求时确定并写入快照。cache read 与 fresh input 分开计费；若模型存在 cache-write 单价，则只有 provider 真正报告 cache-write tokens 时才计入，缺失时标记为 incomplete，禁止猜测。

历史数据处理是 fail-honest：2026-09-06T00:00:00Z 之后、但在该功能上线前的 Command Code usage 可按当天公开费率做 retrospective reconstruction，并明确标记 `retrospective=true`；更早历史不反推。若 provider 报 `inputTokens=0` 但 Router 有大额 `estimatedInputTokens`（当前 DeepSeek V4 Flash 已真实出现），不得把估算 input 当成精确账单，只计算可证明的部分并在 UI 显示 `≥` / incomplete。

Control Center 新面板同时显示：

```text
Official plan used / remaining
5-hour remaining
Weekly remaining
Local usage value ($)
GOAT credit equivalent
Unattributed = official used - locally attributable credits
per-model usage value / GOAT credits / runs / cache hit / coverage
```

`Unattributed` 必须保留，因为它承接 pre-tracking 历史、provider usage 缺字段、未定价模型，以及可能不经过本 Router 的 Command Code 流量；不得为了让两边数字相等而把差额硬分配给某个模型。

2026-09-06 真实账户验收时，Command Code 官方 API 返回 GOAT：月计划已用约 16.8783 / 70 credits、剩余约 53.1217；5-hour 剩余约 13.9905 / 14；weekly 剩余约 18.1217 / 35。该数字只作为当时 E2E 证据，不是固定测试常量。

验证：

```text
Command Code billing/stream/response/provider/usage focused tests: 119 PASS
Control Center full tests: 63 PASS / 2 SKIP / 0 FAIL
npm run check: PASS
Control Center TypeScript check: PASS
Vite production build: PASS
git diff --check: PASS
Router restart health: ready / degraded=[] / activeCount=0
tray rebuild: staged replacement verified, installed, started
```

升级时不要机械保留 `goat-2026-09-06` 的费率常量。先重新读取 Command Code 官方 Pricing/GOAT 页面：若价格、allowance、峰谷时段或计划 caps 改变，更新 pricing version 和对应 regression tests；必须保留的是“请求时固化费率 + 官方总表与本地归因分离 + incomplete 不猜测 + unattributed 可见”的语义。

这个快照是升级验收参考，不是要求未来版本必须保留相同内部实现。真正不可违反的是：

```text
1. 用户/provider 状态不可丢
2. 原生 GPT 不得冒充第三方，第三方不得冒充 GPT
3. cross-model failover 必须显式授权
4. #522/#523 custom-tool stream regression 不得回归
5. Xkiro payload protection 等已验证本地行为不能被无审计覆盖
6. Control Center / Picker / subagent 本地功能必须逐项比较后再 DROP 或 PORT
7. Control Center 的 Codex Native Agent Mode（Single / Team）必须与 Router setSubagentMode 保持独立；升级前后保留用户当前选择，Team 也不得自动触发组队
8. routed third-party plaintext subagent 修复不得污染 native OpenAI encrypted subagent 路径；未来升级必须同时验证两条路径
```
