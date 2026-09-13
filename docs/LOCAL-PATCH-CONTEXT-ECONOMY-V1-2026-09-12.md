# Context Economy v1 本地补丁存档 — 2026-09-12

> 用途：防止 Codex Router / Control Center 升级、重装或 catalog 重发时丢失本次第三方长上下文治理方案。升级时若 upstream 已有等价能力，应 ADAPT / DROP 本地实现；否则只 PORT 最小缺失行为。

## 1. 补丁目标与边界

名称：`Context Economy v1`

目标：限制昂贵第三方编码模型在 Codex 长任务中的**日常工作上下文**，避免每个 agent step 持续携带 20～50 万 token 历史。

长期边界：

```text
不降低模型真实 context_window
不修改 Light v2
不影响原生 GPT
不自动切换模型
不启用 cross-model failover
不使用 GPT 名称冒充第三方模型
只对明确列入策略表的第三方 route 生效
```

`context_window` 是真实模型能力；`auto_compact_token_limit` 只是工作预算，二者不得混淆。

## 2. 触发本次修改的证据

Command Code 官方 usage 当时约：

```text
1,635 requests
246,810,477 input tokens
1,444,116 output tokens
54.8185 credits
月额度约 77.84%
```

Router 日志中的主要异常：

```text
2026-09-06 commandcode/deepseek-v4-flash
586 requests / 465 success / 121 failed
estimated input ≈ 170.74M

2026-09-09 commandcode/meta/muse-spark-1.3-contributor
250 requests / 249 success / 1 failed
estimated input ≈ 60.77M
```

DeepSeek V4 Flash 成功请求输入分布约为：min 208K、median 369K、P90 491K、max 543K。Muse Contributor 约为：min 202K、median 240K、P90 274K、max 289K。

DeepSeek Harness 9/10～9/12 已排除为本轮主要根因；已解析的直接 Command Code 会话仅 41 model steps，规模远小于上述 Codex 长会话。

## 3. 当前策略

| Route | 真实 context | working compact |
| --- | ---: | ---: |
| xkiro/anthropic/claude-opus-5 | 1,000,000 | 160,000 |
| commandcode-messages/claude-opus-5 | 1,000,000 | 160,000 |
| commandcode-messages/claude-opus-4.8 | 1,000,000 | 160,000 |
| commandcode/deepseek-v4-flash | 1,000,000 | 160,000 |
| commandcode/deepseek-v4-pro | 1,000,000 | 160,000 |
| commandcode/meta/muse-spark-1.3 | 1,048,576 | 180,000 |
| commandcode/meta/muse-spark-1.3-contributor | 1,048,576 | 180,000 |

归档时原生 `gpt-5.6-sol` / `gpt-5.6-luna` 仍为各自原生 catalog 设置，没有 Context Economy override。

## 4. 三层保护

**Context Pressure**：指定模型约 100K 开始控制，而不是等待普通外部模型默认的 70%。100K 阶段不做 conversation compact，只要求减少重复全文读取、限制工具输出、优先定向读取。

**Tool Result Aging**：Context Economy route 使用 `minBytes = 16 KiB`、`frontier = 2`。即使普通全局 aging 关闭，指定 route 仍有自己的保护。Control Center 中“同时压缩原生模型”保持 OFF。

**Lean Deferred Tool Surface**：第三方 Chat route 不再每轮无条件扩展整套 deferred Codex App tools；保留 live tools，并按历史真实调用或 forced tool choice 补回必要定义。此前 deferred app tools 约 18 个、约 31 KB schema。

## 5. 实现文件

新增：

```text
src/context-economy.mjs
src/context-economy-state.mjs
test/context-economy.test.mjs
```

修改：

```text
src/catalog.mjs
src/router.mjs
src/chat-tool-surface.mjs
src/control.mjs
apps/control-center/electron/api.d.ts
apps/control-center/electron/ipc.mjs
apps/control-center/electron/preload.cjs
apps/control-center/src/types.ts
apps/control-center/src/pages/SettingsPage.tsx
docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md
```

注意：当前工作树还有其他既有本地补丁，禁止用“整文件恢复 router.mjs / control.mjs”方式回滚本补丁。

## 6. 状态与控制

状态文件：

```text
%USERPROFILE%\.codex\codex-router\context-economy.json
```

归档时：

```json
{"version":1,"enabled":true}
```

控制：

```powershell
node .\src\control.mjs context-economy status
node .\src\control.mjs context-economy on
node .\src\control.mjs context-economy off
```

紧急临时覆盖：

```text
CODEX_ROUTER_CONTEXT_ECONOMY=0
```

正式关闭应使用 control command，以便同步重发 catalog。

## 7. Control Center 语义

Settings → Context Manager 中新增 `Context Economy v1`。

```text
ON  → 策略表里的第三方模型自动受控，无需再逐模型选择
OFF → 恢复 route 原始 working auto-compact
```

它与 Light v2、Codex Native Agent Mode、Router subagent selection、Vision Bridge、Native GPT、Failover 相互独立。

## 8. 归档现场状态

```text
Context Economy = ON
environmentOverride = false
Router health = ready
Control Center tray = running / canonical
Failover = OFF
Failover chain = []
```

有效 merged catalog 已核对：Opus / DeepSeek 为 160K compact，Muse 为 180K；真实 1M / 1.048M context window 保持不变。

## 9. 验证

```text
Context Economy focused      5/5 PASS
相关 catalog/context        70/70 PASS
Router routing              97/97 PASS
Control                     29/29 PASS
root npm run check           PASS
Control Center npm run check PASS
Control Center Vite build    PASS
```

Control Center 全套测试曾有一个 Playwright Models 按钮 1.5 秒稳定性超时，单独重跑 PASS，记为 timing flake。

一次全仓库并行 `npm test` 为 2941 tests / 2847 pass / 12 fail / 82 skip；失败集中在既有 login-free 测试隔离、locale 文案断言、provider 数量断言和并行端口占用，不应为了表面全绿顺手修改无关行为。

## 10. 质量与后续验收

100K pressure 不删除聊天历史；真正存在信息损失风险的是 160K / 180K conversation compact。大型长期项目应继续把关键事实写入 AGENTS / HANDOFF / PROJECT_STATE / 设计与测试文档。

建议同一线程经历 2～3 次 compact 后，用 HANDOFF 新开线程，而不是无限摘要。

实际使用 Opus / DeepSeek / Muse 后，继续监测：

```text
平均 input
cached input
fresh input
compact 前 token
compact 后第一轮 token
compact 周期
credits 消耗速度
是否遗漏关键约束
```

如果 compact 后第一轮仍常见 120K～140K，下一步应优化固定 Prompt / tool surface 底座，不要把 compact 阈值继续粗暴降到 100K。

## 11. 升级规则

升级前至少检查：

```powershell
git status --short
node .\src\control.mjs context-economy status
node .\src\control.mjs failover status
node .\src\control.mjs health
node .\src\control.mjs tray status
```

并同时阅读：

```text
docs/LOCAL-UPGRADE-PRESERVATION-2026-09-05.md
docs/LOCAL-PATCH-CONTEXT-ECONOMY-V1-2026-09-12.md
docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md
```

只有 upstream 已覆盖 per-route working budget、提前 aging、deferred tool surface、原生 GPT 隔离、无隐式模型切换、可关闭恢复等边界时，才可 DROP 本地补丁。

## 12. 回滚

正常回滚：

```powershell
node .\src\control.mjs context-economy off
```

禁止通过以下方式回滚：

```text
把真实 context_window 改成 160K / 180K
整文件恢复 src/router.mjs 或 src/control.mjs
覆盖整个 dirty working tree
开启自动 failover 规避问题
```
