# AI 接手必读：Codex Fusion / Router / Control Center 当前架构与禁区 — 2026-09-20

> 目的：给后续接手 AI 一个**单一、可执行的事实入口**。本文件不是宣传文档，而是运行与维护手册。修改 Router、Control Center、账号、ChatGPT Web、Multi-Agent、Context Economy、Provider、升级/重装前，先读本文件，再按文中链接读对应专项文档。

## 0. 当前公开基线

- 产品/发行名：**Codex Fusion**
- 路由核心与兼容标识：**Codex Router / codex-router**
- 本机仓库：`%LOCALAPPDATA%\codex-router`
- 当前分支：`release/reproducible-v1`
- 当前 HEAD：`94cd9ec`
- 公开发行：`destineylu/codex-fusion`
- `main` 与 `release/reproducible-v1` 当前都在 `94cd9ec`
- reference upstream：`duolahypercho/codex-router`
- 本机未跟踪内容：`benchmarks/`、`reports/`、`main.mjs`。**不要顺手 add / clean / 删除。**

命名规则：不要因为产品名是 Codex Fusion，就重命名既有 `codex-router` 安装目录、脚本、Provider ID、服务、Scheduled Task、sidecar 目录。

---

## 1. 一条最高优先级原则：模型身份必须真实

### 必须保持

```text
Picker 显示 OpenAI 原生 GPT
→ 实际必须走 OpenAI 原生模型

Picker 显示 DeepSeek / Claude / GLM / Grok / Xkiro / Command Code 等
→ 实际必须走自己的 Provider / model slug
```

### 绝对禁止

- 用 `gpt-5.6-sol`、Luna、Reserve 等原生名称代理第三方模型；
- 因额度不足、429、compact 失败、provider cooldown、长上下文而偷偷换模型；
- 让 Router 自己“智能选择”一个 fallback。

当前长期默认：

```text
Failover = OFF
chain = []
```

只有用户明确开启并指定 fallback chain 才允许跨模型切换。宁可失败，也不要“模型盲盒”。

Provider retry/cooldown 可以做，但只能对**同一个明确模型身份**做传输级恢复。

专项依据：
- `docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md`
- `docs/CODEX-FUSION-INDEPENDENT-FEATURES-2026-09-20.md`

---

## 2. Router 是共享平面，不是“每个客户端一套路由器”

一个安装服务多个 target：

```text
Codex
DeepSeek Harness
Gemini CLI
      ↓
同一个 Router plane
同一套 Provider credential
同一套 catalog / usage / policy
```

不要为了不同 target 新建第二套 state、第二个 credential store 或第二个 Router service。

Codex 的真实路由必须保持 Router ownership；不要把 Codex Desktop 改成直连 ChatGPT Web 17841 或某个 Provider。

---

## 3. 原生 GPT、Router 第三方模型、ChatGPT Web 是三条不同体系

这三者最容易被接手 AI 混淆。

### A. 原生 GPT / Codex Native

- Codex 自己的 OpenAI 登录；
- live 身份文件：`%USERPROFILE%\.codex\auth.json`；
- 原生 catalog 与原生模型身份保留；
- Router Native Session Sharing 会重新读取 live auth，不需要为了切换原生账号重启 Router。

### B. Router 第三方 Provider

- Xkiro、Command Code、DeepSeek、GLM、Claude 等；
- 各自 Provider ID、credential、protocol、usage 独立；
- 通过 Router managed catalog 进入 Picker；
- 不准冒充原生 GPT。

### C. ChatGPT Web Bridge

- 自己的 isolated browser / shadow `CODEX_HOME`；
- upstream bridge：`127.0.0.1:17841`；
- Router 入口仍是 4202/4203；
- 不等于 Native ChatGPT account profile；
- 原生 GPT 账号切换不得读取/修改 ChatGPT Web shadow `CODEX_HOME`。

---

## 4. 原生 GPT 多账号 Profile Manager（2026-09-20 已发布）

入口：

```text
Control Center
→ Settings
→ ChatGPT 原生账号
```

核心文件：
- `apps/control-center/electron/codex-account-profiles.mjs`
- IPC/preload/types/Settings UI
- Electron + renderer tests

Profile 根：

```text
%USERPROFILE%\.codex\codex-router\native-accounts
```

### 支持

- 添加账号；
- 昵称；
- 当前账号；
- 重命名；
- 删除非当前账号；
- 显式手动切换。

### 不支持

- 额度用完自动换号；
- 账号池自动轮换；
- 账号 fallback；
- 负载均衡。

### 添加账号

使用官方 `codex login`，在隔离 `CODEX_HOME` 中完成。Control Center 不接收密码，不自己实现 OpenAI token exchange。

常用 Chrome 已登录账号 A 时，可以把本次官方 OAuth URL 复制到无痕窗口登录账号 B。

若最后停在：

```text
http://localhost:<port>/auth/callback?code=...&state=...
```

且自动 localhost 回调失败，可把完整 URL 粘回 Control Center。它只负责严格校验 loopback host/path/port/code/state 后，把请求交给仍在等待的官方 Codex listener。

`codex login --device-auth` 保留为备用。

### 切换账号硬规则

切换前必须**退出 Codex Desktop**，Router 保持运行。

事务：

```text
同步当前 live auth → 当前 Profile
→ 保存 rollback
→ 原子替换 live auth.json
→ 验证目标 identity
→ 更新 active profile
```

失败必须恢复 live auth 和 active 指针；原来没有 live auth 时也不能误用旧 rollback。

**切换绝不能：**
- stop/restart Router；
- 改 `config.toml`；
- 改 `model_provider`；
- 改 catalog/picker；
- 改第三方 Provider；
- 改 ChatGPT Web shadow `CODEX_HOME`。

### Windows Codex.exe 误判

Codex Desktop、npm Codex CLI、`codex app-server`、AppX resources CLI 都可能叫 `Codex.exe`。

因此不能用 `tasklist / IMAGENAME Codex.exe` 判断 Desktop 是否退出。当前实现按**真实 executable path**判断 AppX/Desktop 安装根，并 fail-closed：探针失败或路径无法确认时宁可拒绝切换。

专项文档：
`docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-ACCOUNT-SWITCHER-2026-09-20.md`

---

## 5. ChatGPT Web Bridge：不要和 Native 账号切换混在一起

入口：

```text
Control Center → Settings → ChatGPT Web Bridge
```

生产链：

```text
Codex Desktop
→ Router 4202
→ 4203 api-forwarder
→ 17841 ChatGPT Web bridge
→ managed browser / ChatGPT Web
→ Codex Native2 Full Harness
```

关键边界：
- 真实 Codex route 必须仍由 Router ownership；
- 17841 是 sidecar，不是 Codex 的直接 base URL；
- nativeSessionAuth + openai-responses 必须绕过 LiteLLM 保留 turn/client metadata；
- ChatGPT Web 使用自己的 isolated `CODEX_HOME`；
- upstream launcher 不要设置任意自启动链；受控恢复由 Control Center Tray 管理；
- sidecar proxy 只允许 loopback proxy，不把任意远端代理写进发行配置。

### 已知故障模式

曾出现：

```text
HTTP 200
status = failed
output = []
error = Launcher browser control channel failed...
```

Router 会把这种响应进一步表现成 empty completion / 502。根因属于 Web Bridge browser surface / launcher lifecycle，不是原生 GPT 账号切换。

还出现过：
- `browser_surface_bootstrap_timeout`；
- 孤立的 `Codex Web GPT.exe`；
- stale launcher lockfile；
- managed launcher 启动后 17841 daemon 未自动恢复。

恢复时只处理 ChatGPT Web sidecar/launcher，**不要因此重启 Router 或改 Native auth**。

专项文档：
- `docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-CHATGPT-WEB-2026-09-17.md`
- `docs/LOCAL-UPGRADE-PRESERVATION-2026-09-18.md`

---

## 6. Context Economy v1：只治理第三方工作上下文

不要把 `context_window` 与 working compact 混为一谈。

原则：

```text
真实 Context Window
保持 1M / 500K 等真实能力

Working Context
单独控制 compact 阈值
```

三层：
1. Context Pressure：约 100K 后减少无意义增长；
2. Tool Result Aging：优先压缩旧 shell / 测试 / 大型工具结果；
3. Lean Deferred Tool Surface：第三方不再每轮带全量 App tool schema。

典型 working compact：
- Opus / DeepSeek：160K；
- Muse：180K；
-部分 Xkiro/Xkiro2 1M 模型：260K。

原生 GPT 默认不受 Context Economy 影响。

不要为了省 token 粗暴降低模型真实 context window，也不要让 Context Economy 自动换模型。

专项文档：
`docs/LOCAL-PATCH-CONTEXT-ECONOMY-V1-2026-09-12.md`

---

## 7. Xkiro / Xkiro2 是第三方双账号，不是 Native GPT Profiles

```text
xkiro
xkiro2
```

必须保持：
- Provider ID 独立；
- API Key / secret file / env 独立；
- usage / quota 独立；
- 不自动跨账号切换。

但两者共享：

```text
ownedBy = xkiro
```

因此共享 family-level 协议兼容。

### Opus 5 payload guard

```text
真实 context               1M
serialized body guard      ~1.15 MB
payload safety compact     200K
Context Economy compact    160K
soft pressure              ~100K
```

不要把 1.19 MB 限制错误解释成模型只有 160K context；160K 是工作 compact，不是模型真实能力。

xkiro2 主要模型包括 Astra、Sol、Fable、Opus、Grok、GLM；Kimi K3 已停止发布。账号 1 没有 Astra/Fable 权限，不要替它注册。

专项文档：
`docs/LOCAL-PATCH-XKIRO2-ACCOUNT-2026-09-13.md`

---

## 8. 第三方 Multi-Agent / Subagent 是独立兼容层

目标：

```text
第三方 Parent
→ Codex Native Multi-Agent V2
→ 第三方 Child
```

当前关键实现：
- Parent eligibility 与 Child eligibility 分开；
- `multi_agent_v2.enabled=true` feature gate；
- collaboration namespace 恢复；
- 扁平化工具名恢复成 Codex 原生 namespace；
- LiteLLM 大 SSE 首帧上限扩展到有界 2 MiB；
- routed third-party Parent 使用 `DirectPlaintextMessage`；
- native OpenAI Parent 继续原生 encrypted handoff；
- 两条路径严格隔离。

不要为了第三方 Parent 能工作而把原生 OpenAI handoff 也改成 plaintext。

### Native Agent Mode ≠ Router subagent mode

Control Center：
```text
Single / Team
→ 只开关 Codex Native Multi-Agent 能力
```

Router：
```text
subagent model/mode
→ 决定哪些 routed models 可作为 child
```

两者不能合并。

Team 只提供能力，不自动组队，也不锁定主模型。要精确 Sol + Luna 编排，用户显式选择 Sol 并调用对应 orchestration skill。

专项文档：
`docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md`

---

## 9. Control Center 当前不是“附属 UI”，而是主要管理面

### Models

- Provider-first 分组；
- canonical Provider 合并 protocol variants；
- Provider-scoped Add Models；
- Fetch/Refresh 只查当前 Provider；
- Add；
- Verify & add；
- provenance；
- Provider 折叠/展开；
- Collapse all / Expand all；
- 折叠状态持久化；
- 搜索 / filter 自动展开匹配组。

不要恢复成“所有模型混在一个平铺列表”或跨 Provider 共用模型选择。

### Settings

当前重要入口：
- Context Economy v1；
- ChatGPT 原生账号；
- ChatGPT Web Bridge；
- Codex Auto Resume；
- Codex Native Agent Mode；
- UI Scale 等。

### Skills / Harness

Light v2：
- 只减少专业 Skills；
- 不削弱 Memory、Apps、Node、PDF/PPT/Excel、Browser、Computer Use 等基础能力。

分类：
- Core；
- Specialized；
- Invalid；
- Plugin Cache。

支持 Specialized Skill 临时启停与固定 Prompt 贡献估算。

### UI 兼容性

- UI Scale 持久化；
- Renderer 测试固定 en-US，避免 zh-CN 文案/locator 造成假失败；
- Provider usage timeout 有容错。

---

## 10. verify-model / onboarding 是正式能力

不要看到 Provider catalog 有某个模型就直接发布。

`verify-model` 用于验证：
- Basic response；
- Streaming；
- Tool Calling；
- Reasoning；
- Compact；
- Protocol compatibility。

Control Center 的 Verify & add 建立在这套能力上。

### Command Code 长工具名

Provider 有 function name 长度限制时，使用 request-local deterministic alias：

```text
原长工具名
→ 本次请求局部 hash alias
→ Provider
→ 回来后恢复原工具 identity
```

禁止全局截断工具名。

### PR #523 custom-tool SSE

这是与 Multi-Agent namespace 不同的另一套修复：

```text
native custom_tool_call
LiteLLM 后续 content/input 字段差异
→ namespace-relay 恢复
→ 不再 stream disconnected / Reconnecting 1/5...5/5
```

升级时两类补丁要分别核对。

---

## 11. Usage Accounting：可证明才计费

Command Code 本地归因包含：
- input；
- cache read；
- cache write；
- output；
- pricing snapshot；
- provider/model。

Control Center Usage 分层显示官方计划、5h/weekly、local usage value、GOAT equivalent、runs/cache/coverage、Unattributed。

原则：**无法证明的 token 不硬算成精确账单。**

---

## 12. Codex Auto Resume：只负责 quota 恢复续跑

Auto Resume 的职责：

```text
原生 Codex quota 恢复
→ 继续原 thread
```

它不参与：
- model fallback；
- compact；
- picker；
- subagent；
- Single/Team。

安全默认：
`auto_redeem_weekly_reset=false`

升级后必须确认没有因 upstream 默认值恢复成自动消耗 reset credit。

---

## 13. Windows lifecycle / recovery 是核心能力，不能随便“重装试试”

已保留的重要 Windows 修复：
- limited-token / Integrity Level 打开 Control Center；
- PID reuse 防误判；
- Scheduled Task 生命周期；
- Tray recovery；
- ACL structural comparison；
- release transaction / rollback；
- rebuild 安全替换；
- proxy 环境继承；
- split-package recovery；
- AppX/Desktop 路径识别。

### Control Center rebuild 硬规则

不要在运行中的 canonical package 上直接覆盖。

正确方式使用 repository 的 official tray rebuild / transaction 流程。

如果外层工具 timeout：
1. **不要立即重跑**；
2. 先看 transaction journal；
3. 看 canonical / rollback / staging；
4. 看是否已有 rebuild 进程；
5. 只有确认当前阶段后再恢复。

曾经出现过 timeout 后两个 rebuild 并发。以后必须加锁或确认只有一个事务。

`app.asar` 不能手工单独替换：Embedded ASAR integrity validation 要求 exe 与 asar 来自同一套 electron-builder 输出。

---

## 14. 一键复刻 / Git / 升级模型

公开发行：

```text
origin   destineylu/codex-fusion
branch   main
upstream duolahypercho/codex-router
```

普通用户更新只 fast-forward `origin/main`，不会自动 merge upstream。

一键安装复刻的是：
- 代码；
- UI；
- Provider/协议规则；
- Context Economy；
- Multi-Agent 兼容；
- Profile Manager；
- verify-model；
- Usage；
- lifecycle/recovery；
- Sidecar 安装逻辑。

不会复制：
- API Key；
- OAuth token；
- `auth.json`；
- ChatGPT Cookie/browser profile；
- Tunnel key/ID；
- 私人路径/IP。

所以“一键复刻”= 复刻**代码与安全边界**，每个用户自己登录自己的账号。

发行前至少：
- Control Center tests；
- `npm run release:verify`；
- `npm run check`；
- staged diff/privacy/credential scan；
- 风险与改动面匹配的 live gate。

当前原生 GPT 多账号发布时的证据：
- Control Center：82 total / 80 pass / 2 platform skip / 0 fail；
- reproducibility：16/16；
- release-related：117 total / 112 pass / 5 platform skip / 0 fail；
- `npm run check`：PASS。

`npm test` 全仓在 DevSpace 单次 300 秒限制下曾超时；不要把“工具超时”写成测试 PASS。

---

## 15. 接手 AI 最容易犯的 20 个错误

1. 看到 GPT 额度没了就把 GPT alias 指到第三方；
2. 自动开启 failover；
3. compact 失败就偷偷换模型；
4. 把 Context Economy 的 160K 当成模型真实 context；
5. 把 xkiro/xkiro2 账号做自动轮换；
6. 把 Native GPT Profiles 与 xkiro 双账号混为一谈；
7. 切 Native 账号时重启 Router；
8. 切 Native 账号时同时改 config/catalog/provider；
9. 用“进程名 Codex.exe”判断 Desktop 是否退出；
10. 认为 access token 过期就必须重新登录，忽略 refresh token；
11. 把 ChatGPT Web 17841 当成 Codex 直接 base URL；
12. ChatGPT Web 出错就去改 Native auth；
13. 为第三方 Multi-Agent 修改原生 OpenAI handoff 语义；
14. 把 Native Agent Mode 与 Router subagent mode 合并；
15. 把 Team 理解成“自动组队”；
16. 随手全局截断长 tool name；
17. 把 PR #523 SSE 修复与 Multi-Agent namespace 修复当成同一件事；
18. Control Center rebuild timeout 后立即再跑一次，造成并发 transaction；
19. 手工替换 app.asar；
20. 升级前 `git reset --hard` / `git clean`，把本地恢复资产或未跟踪工作删掉。

---

## 16. 修改前最小检查清单

### 改 Router / Provider / catalog

先看：
- 当前 selected providers；
- failover status；
- model identity；
- Context Economy；
- user-models / picker；
- provider credential scope。

### 改原生账号

先看：
- Codex Desktop 是否真的退出；
- live auth 与 active Profile 是否一致；
- Router 不要动；
- ChatGPT Web shadow home 不要动。

### 改 ChatGPT Web

先看：
- Router route ownership；
- managed launcher；
- browser ready/smoke；
- 17841；
- 9139 control；
- stale launcher process/lockfile；
- 不要误改 Native auth。

### 改 Multi-Agent

先区分：
- Native Agent Mode；
- Router subagent eligibility；
- third-party Parent plaintext handoff；
- native OpenAI encrypted handoff。

### 升级 / rebuild

必须先读：
1. 本文件；
2. `docs/LOCAL-UPGRADE-PRESERVATION-2026-09-18.md`；
3. 对应 LOCAL-PATCH；
4. `docs/REPRODUCIBLE-V1.md`。

然后 classify：
```text
upstream solved
keep
adapt
drop
```

禁止“新版本来了就整体覆盖”。

---

## 17. 权威文档入口

总览：
- `docs/CODEX-FUSION-INDEPENDENT-FEATURES-2026-09-20.md`

升级：
- `docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md`
- `docs/LOCAL-UPGRADE-PRESERVATION-2026-09-18.md`
- `docs/REPRODUCIBLE-V1.md`

专项：
- `docs/LOCAL-PATCH-CONTEXT-ECONOMY-V1-2026-09-12.md`
- `docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md`
- `docs/LOCAL-PATCH-XKIRO2-ACCOUNT-2026-09-13.md`
- `docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-ACCOUNT-SWITCHER-2026-09-20.md`
- `docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-CHATGPT-WEB-2026-09-17.md`
- Auto Resume 对应 LOCAL-PATCH 文档。

---

## 18. 一句话接手原则

> **先保护模型真实身份和用户现有状态，再做功能；Router、Native GPT、第三方 Provider、ChatGPT Web、Multi-Agent、Context Economy 都是相互关联但必须保持边界的系统。任何“为了方便”而自动换模型、自动换账号、重启 Router、覆盖 auth/config/catalog、合并不同控制面，默认都视为错误。**
