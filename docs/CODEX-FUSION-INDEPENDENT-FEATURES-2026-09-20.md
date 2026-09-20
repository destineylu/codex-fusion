# Codex Fusion / codex-router 独立开发功能总览 — 2026-09-20

目前这套 codex-router 已经不只是上游 Router 本身，而是在本机长期迭代出一批独立开发、验证和升级保护的能力。对外发行名称已经统一为 **Codex Fusion**，但为了兼容既有安装，Router 服务、目录、Provider ID、脚本名等底层标识仍保留 codex-router。

这份文档继续按 7 大类整理，并补充 2026-09-20 已完成的 **原生 GPT / ChatGPT 多账号切换**，以及说明这些能力为什么现在可以通过 destineylu/codex-fusion 让其他用户一键复刻，而不是继续依赖维护者这台电脑上的手工状态。

---

## 1. 模型路由与安全边界

这是整个系统最核心的一层。

### 模型身份真实性保护

Codex Picker 显示什么模型，实际就必须调用什么模型。第三方模型不得借用 GPT 名称、Reserve 名称或原生 GPT alias 冒充 OpenAI 原生模型。

长期规则是：

~~~text
Codex Picker 显示 GPT / OpenAI 原生模型
→ 必须实际走 OpenAI 原生模型

Codex Picker 显示 DeepSeek / Claude / Kimi / GLM / Grok 等第三方
→ 必须实际走对应 Provider / model slug
~~~

因此禁止恢复这类映射：

~~~text
gpt-5.6-sol  → DeepSeek
gpt-reserve  → Claude
gpt-5.6-luna → Gemini
~~~

### 禁止盲目自动切换模型

Cross-model failover 默认保持关闭：

~~~text
Failover = OFF
chain = []
~~~

只有用户明确开启，并显式配置 fallback chain 时才允许切换模型。普通 turn、quota/cooldown、payload failure、compaction failure 都必须遵守同一条边界：**宁可失败，也不能偷偷换模型。**

### Provider-scoped 模型选择

模型、Provider、Credential、Protocol 继续保持独立，不把多个 Provider 混成一个模糊的“模型池”。

例如：

~~~text
xkiro/openai/gpt-5.6-sol
xkiro2/openai/gpt-5.6-sol
commandcode/deepseek-v4-flash
~~~

即使模型名称接近，也仍然保留各自 Provider 身份、凭据、额度和 usage 归属。

### managed catalog 恢复机制

为应对 Codex Desktop 升级、Luna Reserve、额度耗尽和 catalog 变化，当前 Hybrid 架构保持：

~~~text
OpenAI 原生 GPT catalog
+
Router managed third-party catalog
~~~

第三方模型通过 Router 的 managed catalog 发布到 Codex Picker，而不是通过 GPT alias 伪装成原生模型。升级后若第三方 Picker 消失，优先修复 catalog / config / picker 发布链，而不是重新录 Key 或启用身份冒充模式。

### Provider cooldown / retry 与模型身份分离

可以对同一个 Provider / 同一个模型进行 bounded retry、cooldown、协议兼容修复，但这些传输级措施不能借机切换到另一个模型。

---

## 2. 第三方长上下文治理

这是后来为解决 20～50 万 Token 长任务持续重复提交而开发的 **Context Economy v1**。

它不是缩小模型真实上下文，而是把：

~~~text
真实 Context Window
与
日常 Working Context / compact budget
~~~

拆成两个概念。

例如模型仍可保持 1M context，但日常工作线程可以在 160K、180K 或 260K 左右进行 compact，以控制长期 Codex 编程成本。

### 当前三层机制

**Context Pressure**

约 100K 后开始限制无意义上下文增长，但这一阶段不直接删除聊天历史，而是要求减少重复全文读取、控制工具输出和重复 schema。

**Tool Result Aging**

优先压缩旧 shell 输出、测试日志和大型工具返回，避免几十万 Token 长任务不断携带早已失去时效的工具结果。

**Lean Deferred Tool Surface**

第三方模型不再每一轮都无条件携带所有 Codex App tool schema，只保留 live tools，并在历史真实调用或 forced tool choice 需要时补回必要定义。

### 典型策略

当前归档中的典型 working compact：

~~~text
Xkiro Opus 5             1M / 160K
CommandCode Opus 5       1M / 160K
DeepSeek V4 Flash/Pro    1M / 160K
Muse                     ~1M / 180K

Xkiro GPT-5.6 Sol        1M / 260K
Xkiro2 GPT-5.6 Sol       1M / 260K
Xkiro GLM-5.3            1M / 260K
Xkiro2 GLM-5.3           1M / 260K
Xkiro2 GPT-6 Astra       1M / 260K
Xkiro2 Fable 5.1         1M / 260K
~~~

原生 GPT 不受这套第三方 Context Economy 干扰。

Context Economy 与 Light v2、Native Agent Mode、Router subagent selection、Vision Bridge、Failover 彼此独立。

---

## 3. Xkiro 专门增强

这一块已经形成独立的 Provider family 兼容层。

### 双账号支持

当前保留两个独立 Provider：

~~~text
xkiro
xkiro2
~~~

两个账号分别拥有：

- 独立 API Key；
- 独立 secret file；
- 独立环境变量；
- 独立 Provider ID；
- 独立 usage / quota 归属；
- 不允许自动跨账号 fallback。

但它们共享：

~~~text
ownedBy = xkiro
~~~

因此可以复用 Xkiro family 的协议和 payload 兼容规则，而不会共享凭据。

### Opus 5 请求体保护

实测 Xkiro Opus 5 除了模型 context window 外，还存在 serialized body 限制，因此增加了独立保护：

~~~text
真实 context                  = 1M
serialized body hard guard    = 1.15 MB
payload safety compact        = 200K
Context Economy compact       = 160K
soft pressure                 ≈ 100K
~~~

两个 Xkiro 账号都共享这一 family-level 保护。

### xkiro2 独立模型集

第二账号主要保留：

~~~text
GPT-6 Astra
GPT-5.6 Sol
Fable 5.1
Claude Opus 5
Grok 4.6
GLM-5.3
GLM-5.3 Flash
~~~

Kimi K3 已停止发布到 Picker；账号 1 没有 Astra 6、Fable 5.1 权限，因此不注册这两个模型。

---

## 4. 第三方 Multi-Agent / Subagent 兼容

这是技术改动最大的一块之一，目标是让：

~~~text
第三方 Parent
→ Codex Native Multi-Agent V2
→ 第三方 Child
~~~

真正可用，而不是只能由原生 GPT 作为 Parent。

当前兼容层包括：

- Parent eligibility 与 Child eligibility 分离；
- multi_agent_v2.enabled=true feature gate 检查；
- collaboration.spawn_agent / list_agents / wait_agent / interrupt_agent namespace 恢复；
- 已扁平化的 collaboration__spawn_agent 等重新映射回 Codex 原生 namespace；
- LiteLLM 大 SSE 首帧由旧 256 KiB 扩展为有界 2 MiB；
- routed Parent 使用 DirectPlaintextMessage；
- 第三方 Parent → 第三方 Child 不再依赖 native GPT encrypted handoff 额度；
- native OpenAI Parent 继续走原生 encrypted handoff；
- 两条路径保持隔离，第三方 patch 不污染原生 GPT subagent。

真实 Desktop E2E 已经跑通过类似：

~~~text
Xkiro Opus 5 Parent
→ spawn_agent
→ DirectPlaintextMessage
→ CommandCode DeepSeek V4 Flash child
→ HTTP 200
→ 实际完成工作
~~~

### 与 Native Agent Mode 的边界

Control Center 的：

~~~text
Single
Team
~~~

只控制 Codex Native Multi-Agent 能力是否打开，不负责自动组队，也不锁定主模型。

~~~text
getCodexAgentMode / setCodexAgentMode
→ Codex Native Multi-Agent Single / Team

Router subagent selection
→ 哪些 routed models 可以作为 child
~~~

两者必须继续分离。

---

## 5. Control Center 独立增强

Control Center 已经从普通 Router 面板扩展成整个 Codex Fusion 的主要管理面。

### Models 页面

已经包含：

- Provider-first Picker；
- 按 Provider 分组模型；
- protocol variants 合并到 canonical Provider；
- Provider-scoped Add Models；
- Fetch / Refresh 只查询当前 Provider；
- 直接 Add；
- 未验证模型使用 **Verify & add**；
- Provider provenance；
- Provider 折叠 / 展开；
- Collapse all / Expand all；
- 折叠状态持久化；
- 搜索或 Provider Filter 时自动展开匹配组。

### Settings：Context Economy

提供 Context Economy v1 开关，用来控制第三方长上下文治理策略；不会影响原生 GPT。

### Settings：Codex Native Agent Mode

提供：

~~~text
Single
Team
~~~

Team 只开启 Native Multi-Agent 能力，不会自动组队，也不会锁定主模型。

### Settings：原生 GPT / ChatGPT 多账号切换

这是 2026-09-20 新增并已经提交到公开 main 的功能。

入口：

~~~text
Control Center
→ Settings
→ ChatGPT 原生账号
~~~

支持：

- 添加多个 Native ChatGPT / Codex 登录账号；
- 账号昵称；
- 当前账号标记；
- 重命名；
- 删除非当前账号；
- 显式手动切换。

每个账号保存为独立 owner-only Profile：

~~~text
%USERPROFILE%\.codex\codex-router\native-accounts
├─ accounts.json
├─ active-account.json
├─ last-switch-backup.json
└─ profiles/
   ├─ <uuid-A>/auth.json
   └─ <uuid-B>/auth.json
~~~

添加账号仍使用官方 Codex OAuth，不要求用户把密码或 token 交给 Control Center。

如果常用 Chrome 已登录账号 A，而第二账号 B 在无痕窗口登录，可以把官方授权 URL 复制到无痕窗口。若最终跳转到：

~~~text
http://localhost:<port>/auth/callback?code=...&state=...
~~~

但 localhost 无法自动返回，Control Center 支持手工提交完整 callback URL。它会严格校验：

- host 只能是 localhost / 127.0.0.1；
- path 必须是 /auth/callback；
- port 必须与当前登录会话一致；
- 必须包含 code / state；
- state 必须与当前 OAuth 会话一致。

Control Center 不自行交换 token，而是把 callback 转交给仍在等待的官方 codex login。官方 codex login --device-auth 仍保留为备用。

真正切换账号前要求先退出 Codex Desktop。切换事务会：

~~~text
同步当前 live auth 到当前 Profile
→ 保存 rollback
→ 原子替换 ~/.codex/auth.json
→ 验证目标身份
→ 更新 active profile
~~~

并且：

~~~text
Router 4202 / 4203            不重启
config.toml                   不修改
model catalog                 不修改
第三方 Provider              不修改
ChatGPT Web shadow CODEX_HOME 不修改
~~~

Windows 下 Codex Desktop、npm CLI、app-server 都可能出现 Codex.exe，因此新版按真实 executable path 判断 Desktop 是否仍在运行，不再用进程名粗略判断；如果无法确认进程身份，则 fail-closed，拒绝切换。

当前版本刻意不做额度耗尽自动换号、账号池轮换和账号 fallback。

### Skills / Harness

包含：

- Light v2；
- Core / Specialized / Invalid / Plugin Cache 四类 Skill；
- Skill 固定 Prompt 贡献估算；
- Specialized Skill 临时启用 / 关闭；
- Light v2 只削减专业 Skill，不削弱 Memory、Apps、Node、PDF/PPT/Excel、Browser、Computer Use 等基础能力。

### 界面与稳定性增强

包含：

- UI Scale 持久化；
- 默认 100%，可在本机设置其他比例；
- Provider account usage timeout 容错；
- Provider 折叠状态持久化。

---

## 6. 模型验证与协议兼容

Router 增加了一套模型 onboarding / certification 工具，避免“catalog 里有模型名就直接发布”。

### verify-model

可在正式加入模型前检查：

~~~text
Basic response
Streaming
Tool Calling
Reasoning
Compact
Protocol compatibility
~~~

并且：

- 支持多种 route / protocol；
- 只有验证通过才允许应用；
- 最终失败可以回滚 user-models / model-picker；
- Control Center 的 Verify & add 建立在这套能力上。

### Command Code 长工具名兼容

Command Code Chat 对 function name 存在 64 字符限制，因此采用 request-local deterministic hash alias：

~~~text
原生长工具名
→ request-local alias
→ Provider 调用
→ 响应后恢复原工具身份
~~~

不会全局截断工具名，也不会影响不受该限制的 Provider。

### custom-tool SSE 修复

保留 PR #523 相关修复：

~~~text
native custom_tool_call
LiteLLM 转换
content / input 参数差异
→ namespace-relay 正确恢复
→ 不再 stream disconnected
→ 不再 Reconnecting 1/5 ... 5/5
~~~

这与后来的 Multi-Agent namespace patch 是两套独立问题，升级时必须分别验证。

---

## 7. Usage、升级和 Windows 运行维护

### Command Code Usage Accounting

Router 自己实现逐请求归因：

~~~text
input
cache read
cache write
output
pricing snapshot
provider/model
~~~

Control Center Usage 可以分层显示：

~~~text
官方计划 used / remaining
5h remaining
weekly remaining
本地 usage value
GOAT credit equivalent
每模型 runs / cache hit / coverage
Unattributed
~~~

原则是：**无法证明的 Token 不硬算成精确账单。**

### Windows Control Center 稳定性

已经做过一系列 Windows 专项修复：

- Limited-token / Integrity Level 打开窗口；
- PID reuse 防误判；
- Scheduled Task 生命周期管理；
- Tray recovery；
- ACL structural comparison；
- release transaction / rollback recovery；
- Control Center rebuild 安全替换；
- 代理环境继承；
- Renderer 测试固定 en-US，避免中文系统 locale 造成 locator 假失败；
- Control Center split-package 恢复流程；
- 原生 GPT 账号切换中的 Desktop executable-path 识别与 fail-closed。

---

# 为什么现在其他用户可以“一键复刻”

过去这些功能虽然在本机已经能运行，但“本机能用”并不等于“别人能安装”。真正实现可复刻，关键不是把一个目录打包发出去，而是把**代码、安装器、升级来源、秘密状态和发行验收**拆开。

## 1. 把本地功能变成 Git 中的正式代码

需要长期分发的能力被提交到：

~~~text
https://github.com/destineylu/codex-fusion
~~~

生产安装跟随：

~~~text
origin = destineylu/codex-fusion
branch = main
~~~

原始 Router 保留为：

~~~text
upstream = duolahypercho/codex-router
~~~

因此：

~~~text
上游 Router
→ 作为参考 upstream

Codex Fusion main
→ 作为实际用户安装与更新来源
~~~

这样不会因为上游更新而自动覆盖本地长期功能。

## 2. 一键安装器固定从公开 main 拉取

Windows：

~~~powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/destineylu/codex-fusion/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
~~~

macOS / Linux：

~~~sh
curl -fsSL https://raw.githubusercontent.com/destineylu/codex-fusion/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
~~~

安装器默认：

~~~text
repository = destineylu/codex-fusion
update branch = main
~~~

因此只要功能已经进入 main，新用户执行同一条安装命令就会获得对应源码、Router、Control Center 和已经纳入发行的本地增强。

## 3. 代码可以复制，账号秘密不能复制

真正可以通过 Git 复刻的是：

~~~text
Router 源码
Control Center
Provider 定义
Context Economy 规则
Multi-Agent 兼容
verify-model
Usage Accounting
Windows lifecycle/recovery
原生 GPT Profile Manager
ChatGPT Web / Auto Resume 的受控安装器
~~~

不能通过 Git 分发的是：

~~~text
Provider API Key
ChatGPT Cookie / browser profile
Codex auth token
原生 GPT Profile auth.json
OpenAI Tunnel runtime key
个人 Tunnel ID
xKiro / Command Code 登录凭据
本机项目路径
本机 IP / Tailscale 地址
~~~

所以“一键复刻”的准确含义是：

> 一键复刻**代码、架构、安装流程和安全边界**；每个用户仍需在自己的电脑上完成属于自己的 OAuth / API Key / 账号登录。

这样既可复现，也不会把维护者凭据分发给别人。

## 4. 用户状态写入统一受保护目录

运行时状态统一写入当前用户自己的目录，例如：

~~~text
%USERPROFILE%\.codex\codex-router
%LOCALAPPDATA%\codex-router-sidecars
~~~

原生 GPT Profile 也写在当前用户自己的：

~~~text
%USERPROFILE%\.codex\codex-router\native-accounts
~~~

不是写进 Git checkout，因此：

~~~text
代码更新
≠
覆盖用户登录
~~~

这也是为什么别人安装相同代码后，可以使用自己的账号和 Provider，而不是继承维护者的本机身份。

## 5. Control Center 把复杂安装步骤变成固定 UI

很多本地增强如果只依靠手工改 JSON / TOML，很难称为可复刻。

现在 Control Center 已经把常用能力做成固定入口：

~~~text
Models
→ Provider / model onboarding

Settings
→ Context Economy
→ ChatGPT 原生账号
→ ChatGPT Web Bridge
→ Codex Auto Resume
→ Native Agent Mode

Harness / Skills
→ Light v2 / Specialized Skill
~~~

因此新用户无需知道每个底层文件的位置，仍然可以按同一流程配置。

## 6. 可选 Sidecar 使用“固定审计版本”，而不是下载 latest

ChatGPT Web、Auto Resume 这类外部组件不直接跟随 upstream latest。

例如 ChatGPT Web 当前采用：

~~~text
audited version
+ installer SHA-256
+ app.asar input/output hash
+ unknown build fail-closed
~~~

这样一键安装不是“今天装到 A，明天装到 B”，而是可以复现同一个经过验证的版本。

## 7. release:verify 把“本机能跑”变成“发行必须满足”

发行前运行：

~~~powershell
npm run release:verify
~~~

它会检查：

- 一键安装 URL 仍指向 destineylu/codex-fusion/main；
- Windows / POSIX 安装器仍以 Codex Fusion 为发行源；
- 原始 Router 仍作为 reference upstream；
- ChatGPT Web pin/hash 没有漂移；
- Auto Resume 固定 commit 和安全默认值仍存在；
- 原生 GPT Account Profiles 的核心后端、UI、OAuth callback、Router-independent 约束仍存在；
- release-sensitive 文件中没有维护者本机路径/IP；
- 没有 credential-shaped literal 被误提交。

2026-09-20 原生 GPT 多账号功能提交前的发行验证为：

~~~text
Control Center tests
82 total
80 PASS
2 platform SKIP
0 FAIL

reproducibility checks
16 / 16 PASS

release-related tests
117 total
112 PASS
5 platform SKIP
0 FAIL

npm run check
PASS
~~~

所以不是只把代码 push 上去，而是给后续发行增加了自动保护：如果未来升级时把“原生 GPT 多账号”“Router 不重启”“无痕 localhost callback”等能力删掉，release:verify 会直接失败。

## 8. Git 发布采用 main + release 同步 fast-forward

原生 GPT 多账号功能已经形成独立提交：

~~~text
89aaec7
feat(control-center): add native ChatGPT account switching
~~~

并同步发布到：

~~~text
destineylu/main
destineylu/release/reproducible-v1
~~~

两个分支使用 atomic push 一次更新，避免 main 与 release 只成功一个。

现有用户升级：

~~~powershell
cd "$env:LOCALAPPDATA\codex-router"
.\model-router.ps1 codex update
~~~

更新器只对公开发行分支做 fast-forward，并保留 rollback ref；不会自动 merge reference upstream。

## 9. 升级保护文档决定“以后还能不能复刻”

每项大功能都有对应 LOCAL-PATCH / preservation 文档，记录：

~~~text
目标
边界
实现文件
运行状态
测试
升级时 keep / adapt / drop 规则
~~~

主要包括：

- docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md
- docs/LOCAL-UPGRADE-PRESERVATION-2026-09-18.md
- docs/LOCAL-PATCH-CONTEXT-ECONOMY-V1-2026-09-12.md
- docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md
- docs/LOCAL-PATCH-XKIRO2-ACCOUNT-2026-09-13.md
- docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-ACCOUNT-SWITCHER-2026-09-20.md
- docs/REPRODUCIBLE-V1.md

升级时不是机械覆盖这些本地改动，而是先判断：

~~~text
upstream solved
keep
adapt
drop
~~~

只有 upstream 已经提供等价或更好的实现，才允许删除本地 patch。

---

# 当前整体定位

如果压缩成一句话，目前这套系统已经变成：

> **多 Provider / 多账号模型路由 + 模型真实性保护 + 第三方长上下文成本控制 + 第三方 Native Multi-Agent 兼容 + Provider-first Control Center + 原生 GPT 多账号切换 + 模型验证系统 + Usage Accounting + Windows 稳定运行/升级保护。**

其中“多账号”现在有两种完全不同的含义：

~~~text
xkiro / xkiro2
→ 第三方 Provider 双账号
→ Provider ID / API Key / usage 独立

ChatGPT Native Profiles
→ Codex 原生 GPT 登录多账号
→ 官方 OAuth / auth.json Profile 切换
~~~

两者都禁止自动跨账号 fallback。

最值得长期保留的独立成果包括：

1. Context Economy；
2. Xkiro 双账号及 Opus payload guard；
3. 第三方 Multi-Agent DirectPlaintextMessage；
4. explicit-consent failover；
5. verify-model；
6. Provider-first Control Center；
7. Usage Accounting；
8. Windows lifecycle / recovery；
9. **原生 GPT 多账号 Profile Manager 与无痕 OAuth callback relay**。

最后要强调：

> **“一键复刻”不是把维护者电脑克隆给别人，而是把所有可公开的代码、策略、UI、安装器、升级规则和回归测试提交到同一个发行分支，再让每个用户在自己的机器上完成自己的秘密凭据和 OAuth 登录。**

这也是 Codex Fusion 从“本机长期魔改版”真正变成“别人可以安装、升级和复现的发行版”的关键。
