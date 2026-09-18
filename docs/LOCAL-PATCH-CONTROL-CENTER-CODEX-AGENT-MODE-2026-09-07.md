# Control Center — Codex Native Agent Mode 本地补丁存档（2026-09-07）

> 目的：防止后续 Codex Router / Control Center 升级、rebuild 或重新基于 upstream 整理工作树时，丢失已经验证的 **Single / Sol + Luna Team** 项目级开关。
>
> 这是一项本地 operator patch。升级时必须先检查 upstream 是否已经提供等价或更好的 Native Multi-Agent 项目模式控制；若已提供，允许 DROP 本补丁，但必须保留下面的行为边界和验收结果。若 upstream 未提供，则只 PORT 最小缺失行为，不要机械覆盖新版本文件。

## 1. 补丁身份

名称：

```text
Control Center Codex Native Agent Mode
```

实现日期：

```text
2026-09-07
```

Router 仓库：

```text
C:\Users\73428\AppData\Local\codex-router
```

受控项目：

```text
F:\程序\office-leasing-ai
```

本补丁只控制 **Codex Native Multi-Agent** 是否启用，不控制 Router 的 routed subagent 模型选择，也**不锁定 Codex 主模型或主模型 reasoning effort**。主模型由 Codex Picker / 用户级配置决定。

严格区分：

```text
getCodexAgentMode / setCodexAgentMode
    → 项目级 Codex Native Multi-Agent Single / Team

setSubagentMode / setSubagentModel / setSubagentEffort
    → Router 哪些 routed models 可作为 subagent
```

两者不能合并、复用或互相替代。

## 2. 只修改的 5 个 Control Center 源文件

```text
apps/control-center/electron/ipc.mjs
apps/control-center/electron/preload.cjs
apps/control-center/electron/api.d.ts
apps/control-center/src/types.ts
apps/control-center/src/pages/SettingsPage.tsx
```

本补丁不应修改：

```text
office-leasing-ai 业务代码
Router 模型路由
现有 setSubagentMode
Light v2 / Skill profile
Provider 配置
Router 后台服务
Codex native model identity / aliases
```

## 3. 项目侧配置是唯一真实模板

Control Center 不自行拼装 TOML，只读/复制已经验证的项目模板：

```text
F:\程序\office-leasing-ai\.codex\
├─ config.single.toml
├─ config.team.toml
├─ config.toml
└─ agent-mode.txt
```

Single 模板语义：

```toml
# 不写 model / model_reasoning_effort；主模型继续由 Picker / 用户级配置决定。
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[agents]
enabled = false
max_concurrent_threads_per_session = 4
default_subagent_model = "gpt-5.6-luna"
default_subagent_reasoning_effort = "medium"

[features.multi_agent_v2]
enabled = false
```

Team 模板语义：

```toml
# 不写 model / model_reasoning_effort；Team 只提供 Multi-Agent 能力。
# 精确 Sol + Luna 编排要求用户先在 Picker 明确选择 GPT-5.6 Sol，再显式调用编排 skill。
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[agents]
enabled = true
max_concurrent_threads_per_session = 4
default_subagent_model = "gpt-5.6-luna"
default_subagent_reasoning_effort = "medium"

[features.multi_agent_v2]
enabled = true
```

禁止在 Single / Team 模板重新加入顶层 `model = "gpt-5.6-sol"` 或 `model_reasoning_effort = ...`。否则打开 `office-leasing-ai` 时项目级配置会覆盖用户当前模型选择，使 Agent Mode 从“能力开关”退化成“主模型锁定器”。

`agent-mode.txt` 只允许：

```text
single
team
```

## 4. Electron / IPC 行为

`apps/control-center/electron/ipc.mjs` 中必须存在等价行为：

```text
CODEX_AGENT_MODES = ["single", "team"]
CODEX_AGENT_MODE_PROJECT_ROOT
codexAgentModePaths()
getCodexAgentModeSnapshot()
setCodexAgentMode(mode)
```

默认 Windows 项目根：

```text
F:\程序\office-leasing-ai
```

允许通过可信主进程环境变量覆盖：

```text
CODEX_ROUTER_AGENT_MODE_PROJECT_ROOT
```

Renderer **不能**传入任意项目路径；IPC 只接受固定的 `single` / `team` 枚举，避免把文件系统写入能力暴露给 renderer。

读取规则：

```text
读取 agent-mode.txt
→ 只能是 single / team
→ 再读取 config.toml
→ 必须与对应 config.single.toml / config.team.toml byte-for-byte 一致
→ 一致才返回该 mode
→ 不一致返回 mode = unknown，并说明原因
```

写入规则：

```text
single
→ config.single.toml 原样复制为 config.toml
→ agent-mode.txt = single
→ 重新读取并验证

team
→ config.team.toml 原样复制为 config.toml
→ agent-mode.txt = team
→ 重新读取并验证
```

禁止恢复为“在 Electron 内重新生成 TOML”的实现，因为这会让 CLI 模板与 Control Center 形成两套配置来源。

## 5. Preload / TypeScript API

Preload 必须只暴露两个命名动作：

```text
getCodexAgentMode()
setCodexAgentMode(mode)
```

对应类型：

```ts
type CodexAgentMode = "single" | "team";

interface CodexAgentModeSnapshot {
  supported: boolean;
  mode: CodexAgentMode | "unknown";
  projectRoot?: string;
  why?: string;
}
```

升级后若 upstream 重构 `RouterControl` / `RouterControlApi`，可以调整内部类型位置，但这些能力和边界必须保留或由 upstream 等价功能替代。

## 6. Settings UI 行为

Settings 页面存在独立区域：

```text
Codex Agent 模式
```

选项：

```text
Single（默认）— 当前所选模型单代理
Team 能力 — 显式 Sol + Luna 编排
```

Single 说明语义：

```text
当前所选主模型
Native Multi-Agent OFF
新建 Codex 会话后生效
```

Team 说明语义：

```text
Native Multi-Agent ON
不锁定主模型
精确 Sol + Luna 编排需先在 Picker 选择 GPT-5.6 Sol
新建 Codex 会话后仍需显式输入 $sol-luna-orchestrator
```

关键安全行为：

```text
Team ≠ 自动组队
```

项目 `AGENTS.md` 的长期规则仍是：

```text
默认 single-agent
只有用户显式调用 $sol-luna-orchestrator
或明确要求 Sol + Luna multi-agent team
才允许启用组队工作流
```

因此 Control Center 的 Team 只是打开 Codex Native Multi-Agent 能力，不应让普通复杂任务自动 spawn child。

## 7. 旧 preload / renderer mock 兼容

Settings UI 必须对旧 preload / renderer test mock 兼容：

```text
如果 api.getCodexAgentMode 不存在
→ 不抛异常
→ Agent Mode 显示 unavailable / unknown
→ Settings 其余区域继续正常渲染
```

同样：

```text
如果 api.setCodexAgentMode 不存在
→ 不尝试调用
→ 不影响其他 Settings 功能
```

这是 2026-09-07 正式 rebuild 前实际发现并修正的兼容点。

## 8. 2026-09-07 已验证结果

仓库检查：

```text
npm run check
→ v2-agent applications valid (6)
→ syntax checks passed
```

Control Center 完整测试：

```text
66 tests
64 pass
0 fail
2 skip
```

Control Center renderer production build：

```text
PASS
```

Windows 官方 Control Center / Tray rebuild：

```text
.\codex-router.ps1 tray rebuild
→ Companion rebuilt, installed, and started.
```

最终 Tray：

```text
installed = true
supported = true
loaded = true
state = running
canonical = true
```

归档时项目状态：

```text
agent-mode = team
config.toml == config.team.toml   → yes
config.toml == config.single.toml → no
```

这个“归档时为 team”只是现场状态，不是未来升级应强制恢复的模式。长期默认策略仍是 **Single**；升级必须保留用户升级前的实际选择，而不是无条件写 team。

## 9. 升级前检测

升级前至少检查：

```powershell
cd "$env:LOCALAPPDATA\codex-router"

git status --short

grep / Select-String markers:
CODEX_AGENT_MODES
CODEX_AGENT_MODE_PROJECT_ROOT
getCodexAgentMode
setCodexAgentMode
Codex Agent 模式
```

同时读取项目：

```text
F:\程序\office-leasing-ai\.codex\agent-mode.txt
F:\程序\office-leasing-ai\.codex\config.toml
F:\程序\office-leasing-ai\.codex\config.single.toml
F:\程序\office-leasing-ai\.codex\config.team.toml
```

保存升级前当前 mode，升级后必须恢复同一用户选择，除非用户明确要求改变。

## 10. 升级后的 PORT / DROP 决策

### DROP 本地补丁的条件

只有在 upstream 已提供等价或更好的能力，并且确认全部满足时才能 DROP：

```text
1. 能控制 Codex Native Multi-Agent Single / Team
2. 不复用 Router setSubagentMode
3. 不让 renderer 传任意文件路径
4. Single 真实关闭 agents + multi_agent_v2
5. Team 真实开启 agents + multi_agent_v2
6. Luna 仍是 default_subagent_model
7. Team 不自动触发组队
8. 当前用户模式可被读取并保留
9. Settings 页面其他功能不会因该接口缺失而崩溃
```

### PORT 本地补丁的条件

如果 upstream 没有等价能力：

```text
1. 先理解新 Control Center 的 IPC / preload / types / Settings 架构
2. 只移植上述语义
3. 不整文件覆盖
4. 不恢复旧版本无关代码
5. 不修改 setSubagentMode
6. 不修改业务项目代码
7. 使用官方 Control Center build / tray transaction
```

## 11. 升级后强制验收

静态 / 本地：

```text
npm run check
Control Center npm test
Control Center npm run build
git diff --check
tray rebuild / refresh 按新版本官方路径完成
```

配置验收：

```text
getCodexAgentMode 能识别升级前模式
config.toml 与对应模板完全一致
非法 mode 被拒绝
setSubagentMode 仍存在且行为未被本补丁替代
```

额度恢复后再做两条真实 Codex 运行验收：

```text
Single
→ 复杂任务也必须 0 child

Team + 显式 $sol-luna-orchestrator
→ child 必须实际为 gpt-5.6-luna
```

不要为了升级验收而自动执行 quota-consuming Codex 请求；真实运行验收仍需要用户明确允许。

## 12. 禁止的恢复方式

不要用：

```text
git reset --hard
git clean
git restore --source=... 广泛覆盖
git checkout -- 整目录
whole stash pop / apply
旧 5 文件整文件覆盖新 upstream
```

正确策略：

```text
先比较 upstream
→ DROP 已被吸收的行为
→ PORT 最小缺失行为
→ focused tests
→ Control Center full tests/build
→ 官方 tray transaction
```

本文件与：

```text
docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md
%USERPROFILE%\.codex\skills\codex-router-upgrade\SKILL.md
```

共同构成该补丁的升级保护记录。
