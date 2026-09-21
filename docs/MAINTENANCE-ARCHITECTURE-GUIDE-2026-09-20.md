# Codex Fusion / Codex Router 维护架构说明书

> 本文 = 架构事实地图；`docs/AI-HANDOFF-CODEX-FUSION-ROUTER-CONTROL-CENTER-2026-09-20.md` = 操作红线与历史踩坑。两者互补，不互相替代。本文面向维护者，记录代码事实、数据流、边界、故障定位顺序和有证据的维护建议；遇到冲突时，以代码、测试和仓库维护规则为准。不改变任何程序代码。

## 1. 系统定位

本仓库不是一个单一的“API 转发脚本”，而是由四层组合而成：

```text
发行与升级层
  install.sh / install.ps1 / bin/install / src/update.mjs
        ↓
共享 Router 平面
  state + secrets + catalog + LiteLLM + forwarders + 4202 router
        ↓
客户端适配层
  Codex / DeepSeek Harness / Gemini CLI
        ↓
管理与可选旁路层
  Electron Control Center / Tray / ChatGPT Web / Auto Resume / local runtimes
```

核心原则是“一套 Router 平面、多个客户端”：`MODEL_ROUTER_TARGET` 只决定写哪个客户端文档；服务、端口、Provider 选择、凭据和模型目录仍由同一平面共享。目标值目前为 `codex`、`dsh`、`gemini`。

仓库同时包含上游能力和本地整合能力。`NOTICE.md` 明确列出：Codex Router 是路由基础；`codex-chatgpt-web` 与 `codex-auto-resume` 是受审计版本的可选 sidecar；此外还吸收了 opencodex 的 merged catalog 思路和 devin-2api 的协议先验。维护时必须把“上游原有行为”和“本地适配/保护”分别判断，不能整仓机械覆盖。

## 2. 进程与端口拓扑

默认端口在 `src/paths.mjs` 定义：

| 端口 | 进程/职责 | 访问边界 |
| --- | --- | --- |
| 4200 | LiteLLM gateway | 仅 loopback，内部 service key |
| 4201 | Kimi OAuth forwarder | 仅 loopback，内部 service key |
| 4202 | `src/router.mjs` 主入口 | caller capability 路径 |
| 4203 | `src/api-forwarder.mjs` | 仅 loopback，内部 service key |
| 4208 | Grok OAuth forwarder | Provider 启用时使用 |
| 4210 | Devin CLI forwarder | 有 Devin 路由时使用 |
| 4212 | Antigravity OAuth forwarder | 配置了 OAuth client secret 时使用 |

`src/start.mjs` 是共享平面的进程编排器。它先恢复安装时记录的代理环境，再校验 secret 和 LiteLLM 虚拟环境，生成 `litellm.yaml`，按已发布模型决定是否启动可选 forwarder，然后并行等待 forwarder 健康，启动 LiteLLM，最后启动 Router。LiteLLM 已健康后由 `gateway-supervisor.mjs` 在有界窗口内单独重启；任一自有 forwarder 或 Router 退出则整个服务退出，由平台服务管理器重建。

`src/service.mjs` 是 stop/start/restart 的唯一入口，再委托到 macOS launchd、Linux systemd 或 Windows Task Scheduler 实现。不要把 `bin/start` 改回直接执行 `src/start.mjs` 的前台副本，否则会绕过已安装的代理、权限和服务生命周期。

## 3. 状态、配置和所有权

### 3.1 路径分层

`src/paths.mjs` 统一计算路径：

```text
CODEX_HOME                 ~/.codex 或用户指定目录
STATE_DIR                  CODEX_HOME/codex-router
CONFIG_PATH                CODEX_HOME/config.toml
NATIVE_CATALOG_PATH        state/native-models.json
MERGED_CATALOG_PATH        state/merged-models.json
LITELLM_CONFIG_PATH        state/litellm.yaml
PROVIDER_SELECTION_PATH    state/enabled-providers.json
PROVIDER_CREDENTIAL_STORE  state/provider-credentials.json（仅元数据）
```

运行时秘密单独存放在 state 下的受保护文件或官方 CLI 的原目录中。`caller-secret` 是客户端访问 4202 的能力；`internal-secret` 是平面内部服务间认证；Provider key 不进入 registry、catalog、LiteLLM 生成文件、日志或健康响应。

### 3.2 所有权防护

`state-owner.mjs`、`file-security.mjs`、原子写入工具和各类 publication lock 共同防止“错误 checkout 改写真实用户状态”。所有重要配置采用临时文件写入、权限收紧、原子 rename；无法确认 Router 拥有某个标记区块时，配置管理器拒绝写入而不是猜测。

Codex `config.toml` 的普通 Router/Hybrid 路径只写带标记的 `openai_base_url`、`model_catalog_json` 及 Router 明确拥有的附属设置；用户的 `model`、`profiles`、认证和未标记表格必须保留。`model_provider` 不是“永远只属于用户”的例外：login-free 与 signed-routing 有明确的 provider-mode state，能够临时取得 ownership，保存旧值/旧 provider table，并在 disable、rollback 或 refresh 事务完成时恢复。每次写入前都要验证当前值仍是 Router 自己安装的值；发生 ownership 漂移、未识别 provider table 或受保护 refresh journal 不一致时，必须 fail-closed，拒绝覆盖。普通 Hybrid/Native 更新不得顺手改写用户的 provider。DSh YAML 和 Gemini `.env` 也分别只拥有自己的键/标记块，并尽量保持原文、注释和缩进。

## 4. 安装、升级和回滚

安装入口是 POSIX 的 `install.sh` 与 Windows 的 `install.ps1`；稳定 checkout 默认位于 `~/.local/share/codex-router` 或 `%LOCALAPPDATA%\codex-router`。`src/install-plan.mjs` 计算依赖指纹和 Python 安装命令，Node 依赖由 lockfile 控制，LiteLLM 依赖由 `requirements/python.txt` 的 universal hash lock 控制。

安装事务大致为：检查平台与参数 → 识别已知旧安装 → 安装依赖 → 生成内部/调用者 secret → 读取/合并 native catalog → 生成 LiteLLM 路由 → 修改客户端托管区块 → 安装服务/Tray → 等待健康 → 记录 manifest → doctor。失败时只回滚已识别、已快照的 Router 状态，不停止或删除未知进程和用户拥有的配置。

生产源是 `destineylu/codex-fusion` 的 `main`，`duolahypercho/codex-router` 是参考 upstream。普通 update 只 fast-forward 发行源；上游采用必须在隔离分支中审计，并对本地能力逐项作 `upstream solved / keep / adapt / drop` 判断。不要使用 `git reset --hard`、`git clean` 或直接覆盖 canonical Electron package 来“解决升级问题”。Windows Tray rebuild 必须使用事务 journal、匹配的 exe 与 `app.asar`，并先确认没有已有 rebuild 进程。

## 5. 模型与 Provider 数据流

### 5.1 Registry → catalog → picker

`config/` 是按 Provider 拆分的 JSON registry。`model-registry.mjs` 递归按字节序读取 fragments，严格校验 Provider、模型 slug、协议、端点、匿名 allowlist、凭据元数据、能力和升级目标，形成 `PROVIDERS`、`MODELS`、`MODEL_BY_SLUG` 等只读索引。

`provider-selection.mjs` 保存启用 Provider；`provider-credentials.mjs` 解析环境变量、受保护文件、macOS Keychain、官方 OAuth 状态等来源；`provider-credential-store.mjs` 只保存安全的 credential reference，不保存秘密。只有“已选、已配置、已列出”的模型才成为可路由集合。

`catalog.mjs` 读取 Codex 账户 catalog 与 bundled catalog，合并 native 元数据，再叠加 Router 模型、用户模型、Context Economy、vision、Multi-Agent、native alias 和 picker 可见性策略，原子生成 `merged-models.json` 并写回 Codex 托管区块。`model-picker-state.mjs` 保存“用户明确显示/隐藏”的决定；启用 Provider 不等于自动展示全部模型。

### 5.2 请求路由

4202 收到请求后先验证 caller capability，再按 `/models`、Gemini API、Responses、compact、native image/search 等路径分派。Responses 路由依据 catalog slug 解析真实 route：

```text
native OpenAI route
  → 保留 Codex session / metadata，必要时走 4203
routed third-party route
  → normalize input / tools / reasoning / images
  → 可选 tool-result aging、context shaping、vision bridge
  → 4200 LiteLLM 或专用 4203/4201/4208/4210/4212 forwarder
  → provider
```

Router 负责请求级兼容：压缩与 checkpoint、SSE/JSON 翻译、推理内容保留、工具 namespace relay、Command Code 长工具名的 request-local alias、Gemini 重入 Responses、图像到文本模型的 vision bridge，以及 usage/event 记录。`api-forwarder.mjs` 在最后一跳按 Provider 处理认证、协议和响应差异，不应把某个 Provider 的修复放进全局 native 路径。

### 5.3 重试、冷却和 failover

同一模型的 provider retry/cooldown 属于传输恢复；跨模型 failover 是显式策略。`model-failover.mjs` 要求同时开启开关并提供明确 chain，默认 `OFF / []`。路由已开始向客户端转发字节后不得切换到另一个模型；失败原因必须保留真实的 provider/model 身份。任何新代码若自动选择“可用模型”都违反产品核心约束。

## 6. 三个客户端适配器

### Codex

`config-manager.mjs` 管理 TOML 标记区块，`catalog.mjs` 管理 merged catalog，native session 每次请求重新读取 live `auth.json`。原生 GPT、Router 第三方模型和 ChatGPT Web 模型在 registry、凭据、usage 和请求路径上必须保持可辨识。

### DeepSeek Harness

`dsh-config-manager.mjs` 只修改 `$DSH_HOME/settings.yaml` 中 `llm-pi-ai.providers.codex-router` 和 `.credentials.yaml` 中对应 reference。它是结构化、fail-closed 的 YAML block lexer，保留其他 Provider、注释、缩进和文档形状；Harness 热加载，所以成功 publish 后无需重启。

### Gemini CLI

`gemini-config-manager.mjs` 只写 `$GEMINI_CLI_HOME/.gemini/.env` 的 Router 标记块，设置 `GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL`；绝不改 Gemini `settings.json`。`gemini-surface.mjs` 把 Gemini 请求翻译成 Responses，再通过 4202 loopback 重入，因此 Gemini 没有自己的 provider upstream。

所有 target 的安装/卸载/refresh 都由 `target-integration.mjs` 统一调用，模型或凭据变化必须通过 `refreshTargetPickerIfInstalled()` 重新发布已安装的每一个客户端，而不是只更新当前 target。

## 7. Control Center 与 sidecar

Electron 主进程是受限的管理面：Renderer 通过 preload 暴露的命名 IPC 调用固定 `control.mjs` 命令；没有通用 shell、任意 URL、任意 payload 或 node integration。主进程串行化 mutation，读操作可并发；命令有超时、输出上限和整个子进程树终止。

Control Center 负责 Models、Usage、Status、Context、Harness、Settings、Local runtime、ChatGPT Web、Auto Resume 和 Native Account Profiles。这里的“不重复实现”只适用于 Router 的 Provider routing、Provider credential semantics 和模型路由决策；Control Center 确实拥有部分 desktop-only orchestration 与 sidecar/lifecycle 职责，包括 Native Account Profile 存储、官方 Codex OAuth 子进程编排、localhost callback relay、Native auth rollback/ACL、ChatGPT Web launcher/browser/daemon 生命周期、Auto Resume 控制，以及 Windows Tray/rebuild transaction。它调用固定命令和受控子进程，不因此成为第二套 Router。

ChatGPT Web 是隔离 sidecar：真实 Codex route 保持 4202，Web launcher 使用独立 `CODEX_HOME`，桥接到 17841；Control Center Tray 才负责受控登录恢复，上游 launcher 的 autoStart 必须关闭。Native GPT 多账号只交换用户的 live `auth.json`，切换前要求 Desktop 真正退出，Router 4202/4203、config、catalog、第三方 Provider 和 Web shadow home 均不变。

Auto Resume 只负责原生 quota 恢复续跑，默认不得自动兑换 weekly reset。它不是 failover、compact 或 subagent 系统。ComfyUI 是独立插件/仓库，不属于 Router v1 的共享运行时状态。

Router 的 ChatGPT Web route 是按当前请求解析出的 model slug/provider 选择的；compaction 分支同样先按当前 route 决定 native-session forwarder 或 gateway，代码没有显示会因旧 thread 曾使用 `chatgpt-web/high` 而在当前模型已切换为 Native Luna 时主动把 compact 发回 Web Bridge。因此，单次 `remote compact`/502 现象不能据此归因于 Router 选错 provider。另一方面，当前代码和测试没有建立跨 provider-family 旧 thread 的 continuation/remote-compaction 兼容证明；对已经很长或接近 compaction 的 thread，在 `chatgpt-web/*` 与 Native GPT 间切换应视为运行边界，优先新建 thread。该建议是 operational caution，不是已证明的 Router 根因，也不要求重启 Router、修改 `auth.json` 或打开 failover。

## 8. 长上下文、工具和 Multi-Agent

Context Economy 由 `context-economy.mjs`、`tool-result-aging.mjs` 和 `chat-tool-surface.mjs` 组成，只对明确策略表中的第三方 route 生效。它降低 working compact budget，不降低 registry 的真实 `contextWindow`；100K 左右 pressure 是形态控制，真正有损的是 160K/180K/260K compact。

Multi-Agent 有两条不可混合的路径：native parent 的 encrypted handoff 和第三方 parent 的 `DirectPlaintextMessage`/namespace relay。`multi_agent-state.mjs` 只允许已认证的 parent/child 能力；`v2_agent/` proof 资产和 catalog certification 不得被“运行过一次”自动改写。Control Center 的 Native Agent Mode Single/Team 只是能力开关，不是 Router 的 child model 选择，更不是自动组队。

## 9. 安全边界

1. 所有监听只绑定 loopback；4202 使用 caller capability，内部端口使用随机 internal key。
2. keyless endpoint 只能是 loopback；anonymous endpoint 必须命中代码内 allowlist；per-model endpoint 必须自带受约束的 credential/anonymous/keyless 之一。
3. API/OAuth credential 永不进入 catalog、LiteLLM YAML、日志、health、argv；Control Center secret 通过 stdin 传给子进程。
4. 原生 `auth.json`、ChatGPT Web shadow home、Provider key 和 Router state 是四类不同秘密边界。
5. 配置解析遇到重复键、inline mapping、未闭合字符串、未知 owner 或 marker 漂移时拒绝修改。
6. Support bundle 默认不含日志；诊断日志可能含 prompt/response 片段，分享前必须人工检查。

## 10. 故障定位顺序

先判断“客户端是否到达 4202”，再区分 Router、forwarder、LiteLLM、provider 和 sidecar：

```text
1. `bin/model-router <target> doctor`
2. 4202 /health（确认 caller capability 与 degraded 列表）
3. 4200 /health/liveliness、4201/4203/4208/4210/4212 /health
4. state/merged-models.json 与 user-models / provider selection 是否一致
5. `router.log`、usage-events.jsonl、provider cooldown/health 状态
6. 对照请求的 provider/model/route path，确认没有身份错配或隐式 failover
7. 若仅 Web 模型失败，检查 17841 launcher/browser/isolated CODEX_HOME，不要改 Native auth
8. 若仅账号切换失败，检查 Desktop executable path、live auth、profile rollback，不要重启 Router
```

遇到空完成、SSE 断流、429、compact 失败时，先看 Router 是否已经 relayed bytes；已 relayed 后不能再套跨模型重试。遇到 Windows rebuild timeout，先读 transaction journal、canonical、rollback、staging 和进程状态，不能立即再次启动 rebuild。

## 11. 维护建议（仅列确有依据者）

### 建议 A：为 login-free 配置测试建立显式隔离入口

`test/config-manager.test.mjs` 的多数用例会创建临时 `CODEX_HOME` 与 `stateDir`，因此不能仅凭“2 个失败”就断言测试已经读取了真实用户目录；当前保留下来的失败现象不足以证明是产品逻辑 bug，也不足以证明真实状态污染。维护时仍应把隔离条件做成可审计前置条件：运行 ownership/config-manager/login-free 测试前，明确确认 `CODEX_HOME`、`STATE_DIR`、refresh journal 和 config fixture 均指向临时路径；若测试入口允许真实环境变量继承，应在启动时拒绝真实用户目录并输出实际路径。只有在取得直接失败输出和路径证据后，才能把失败归类为隔离问题。无论测试如何隔离，都不能为了全绿而放松生产 fail-closed 或 ownership 检查。

### 建议 B：把“平面端口/可选进程”保持在一处生成并增加拓扑契约测试

当前端口由 `paths.mjs` 定义，启动条件又分布在 `start.mjs`、registry 和多个 forwarder 中。现有测试覆盖很多局部行为，但维护新 Provider 时仍容易漏更新 health、service env、doctor 或 target refresh。建议增加一个纯静态契约测试：从 `PORTS`、`start.mjs`、health payload、service render 和 registry forwarder 声明生成/比对完整拓扑；这属于降低遗漏风险的测试增强，不涉及运行时策略改变。

### 建议 C：把“外部项目版本/哈希/入口”做成可机器读取的 provenance 清单

当前版本和 hash 分散在 `NOTICE.md`、`REPRODUCIBLE-V1.md`、ChatGPT Web/Auto Resume 专项文档、安装器和 Control Center 代码。升级审计容易漏读。建议新增仅供校验的 provenance manifest，列出 upstream URL、审计版本/commit、资产 SHA、安装入口和对应 acceptance tests；由 `release:verify` 校验文档/代码一致性。此建议不要求现在改版本，也不要求自动更新 upstream。

### 不建议修改的部分

- 不建议为了让全仓测试“全绿”而放松 TOML/YAML fail-closed 或 ownership 检查；这些失败正是保护用户配置的证据。
- 不建议把 native GPT、xkiro/xkiro2、ChatGPT Web 或 Auto Resume 统一成一个“账号池”；它们的凭据、路由和生命周期故意不同。
- 不建议开放 cross-model 自动 fallback、把真实 context window 改成 working compact 值、或让 ChatGPT Web 直接成为 Codex route owner。
- 不建议把 Control Center 变成第二套 Router；其 IPC/queue/security 边界应继续只调用固定命令。

## 12. 验证记录

- `npm run check`：通过（syntax checks、v2-agent application validation）。
- `npm --prefix apps/control-center run check`：通过（TypeScript 与 Electron Node syntax）。
- 定向测试记录（来自上一轮审阅）：329 项，319 PASS、2 FAIL、8 SKIP；失败涉及 login-free `config-manager` 的 ownership、refresh journal/context override 状态。当前代码检查确认测试夹具普遍使用临时 `CODEX_HOME`/`stateDir`，但现有记录没有保留足够的失败输出与实际路径证据，不能把“与本机真实 ownership/journal 冲突”写成已证实事实；应按建议 A 先补齐隔离证据，再重新分类。此次复核未把该现象判定为产品逻辑 bug。
- 未运行 live provider/model 验证，避免消耗配额。
- 本次审阅未修改任何源代码、配置、凭据或未跟踪用户资产；唯一新增是本说明书。
