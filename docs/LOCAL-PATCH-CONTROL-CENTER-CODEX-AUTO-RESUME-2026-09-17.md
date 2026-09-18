# Control Center — Codex Auto Resume Sidecar 本地补丁存档（2026-09-17）

> 目的：记录 `feifeigong/codex-auto-resume` 与 Codex Router Control Center 的本地集成边界，避免后续 Router / Control Center 升级、rebuild 或重装时丢失，或误把该工具并入 Router 路由状态机。

## 1. 架构结论

采用 sidecar，不 vendor 上游 Python 源码：

```text
Control Center
  renderer
    ↓ named IPC only
  Electron main
    ↓ fixed sidecar adapter
codex-auto-resume checkout
    ↓ public CLI
Codex app-server / original thread
```

Codex Auto Resume 只负责：

- 发现 native Codex usage-limit 中断；
- 读取 native Codex app-server 额度；
- 额度恢复后续跑原 thread；
- 上游自行管理 watch / autostart / state。

它不负责，也不得接管：

- Router provider/model routing；
- cross-model failover；
- Remote Compact / Context Economy；
- Codex Native Multi-Agent / Single-Team；
- Router usage ledger。

## 2. 上游基线

仓库：

```text
https://github.com/feifeigong/codex-auto-resume
```

审计版本：

```text
0.2.2
commit 1b2dae9d862573adc727b8d273d2760785344351
2026-09-12
```

Control Center 的 Install action 固定安装上述已审计 commit，不跟随未来 `main` 漂移。升级 sidecar 必须重新审计后再更新固定 commit。

2026-09-17 审计时仓库根目录没有 `LICENSE` 文件，因此本地补丁不得复制、改写或 vendoring 上游 Python 实现到 `codex-router`。Control Center 仅安装独立 checkout 并调用其公开 CLI。

## 3. Checkout 与 state 所有权

默认 sidecar checkout：

```text
Windows:
%LOCALAPPDATA%\codex-router-sidecars\codex-auto-resume

macOS:
~/Library/Application Support/codex-router-sidecars/codex-auto-resume
```

可信主进程可用：

```text
CODEX_AUTO_RESUME_ROOT
```

覆盖 checkout 根目录。Renderer 不允许传入任意路径。

上游自己的 state/config 继续保持其默认目录：

```text
Windows:
%LOCALAPPDATA%\vibcoding\codex-auto-resume

macOS:
~/Library/Application Support/vibcoding/codex-auto-resume
```

## 4. Control Center API

Preload 只暴露：

```text
getCodexAutoResume()
controlCodexAutoResume(action)
```

允许 action 只有：

```text
install
doctor
dry-run
enable-autostart
disable-autostart
enable-reset-credit
disable-reset-credit
```

其中 `dry-run` 固定调用上游 `once --dry-run`；reset-credit 只允许两个固定布尔动作，不向 renderer 暴露任意配置键或值。

不提供：

- 任意 shell / argv；
- 任意 sidecar 路径；
- 任意 Git URL；
- 任意 Python command；
- Router fallback / model 切换入口。

所有子进程调用保持 `shell: false`。

## 5. 安全与 reset credit

上游 0.2.2 的 `auto_redeem_weekly_reset` 默认是 `true`，但本地集成从 2026-09-18 起采用更保守的 Control Center 默认：

- 安装 sidecar 时立即写入 `auto_redeem_weekly_reset=false`；
- 启用 autostart 前再次强制写入 `false`，防止上游升级/配置漂移恢复危险默认；
- Settings 提供显式 reset-credit 开关，只有用户主动开启才写 `true`；
- 安装 sidecar 不自动启用 watcher；
- Router 不把此行为解释为 failover，也不自动替用户切换模型。

因此 5 小时额度恢复后的自动续跑与 weekly reset-credit 自动消耗彼此独立。

## 6. UI

入口保持在：

```text
Settings → Codex Auto Resume
```

不增加新的一级导航，避免继续扩大 Control Center 信息架构。

显示：

- Settings：installed / stopped / running、sidecar checkout 与版本、autostart、tracked/active thread 数、reset-credit 显式开关、最近一次 doctor / lifecycle / dry-run 结果；
- Status：只读紧凑卡片，显示 watcher 状态、autostart、tracked/active thread、最近状态/检查时间和 weekly reset-credit 自动消耗是否关闭。

操作：

- Install sidecar
- Run doctor
- Dry-run scan
- Enable autostart
- Disable autostart
- Explicitly enable/disable weekly reset-credit auto redeem
- View source

## 7. 本地修改文件

```text
apps/control-center/electron/codex-auto-resume.mjs
apps/control-center/electron/ipc.mjs
apps/control-center/electron/preload.cjs
apps/control-center/electron/api.d.ts
apps/control-center/src/types.ts
apps/control-center/src/pages/SettingsPage.tsx
test/control-center-electron.test.mjs
apps/control-center/test/renderer.test.mjs
docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AUTO-RESUME-2026-09-17.md
```

注意：实施本补丁前工作树已经存在与本任务无关的 `UsagePage.tsx`、`usage-status.css`、`renderer.test.mjs`、`src/router.mjs`、`model-failover-router.test.mjs` 和 `benchmarks/` 修改。后续移植本补丁时不可把这些既有改动误归入 Auto Resume。

## 8. 验证基线

2026-09-17 新补丁完成后：

```text
apps/control-center: npm run check
PASS

apps/control-center: npm test
69 tests
67 passed
0 failed
2 skipped
```

其中 renderer 测试实际验证：

- Settings 可见 Codex Auto Resume section；
- weekly reset-credit 自动使用默认关闭，并有独立显式开关；
- Run doctor 与 Dry-run scan 均走固定 action；
- Enable autostart 必须经过确认 dialog；
- action 完成后 sidecar 状态更新为 Running；
- Status 页以只读卡片显示 watcher/autostart/thread/reset-credit 状态。

## 9. 升级规则

升级 Router / Control Center 时：

1. 先检查 upstream 是否已经提供等价的 Codex quota-resume 管理。
2. 若 upstream 已提供，允许 DROP 本补丁，但必须保留 sidecar ownership、显式 reset-credit consent 和 no-generic-shell 边界。
3. 若 upstream 未提供，只 PORT 本文列出的最小能力。
4. 不得因为“方便”把 auto-resume 扫描、quota reader、resume state machine 复制到 Router。
5. 不得让 Auto Resume 成为 Router failover、compact、subagent 或 model picker 的隐式触发条件。
6. 升级或重装后必须重新确认 `auto_redeem_weekly_reset=false`，不得静默恢复上游 `true` 默认。
7. 不得把 sidecar checkout 放回 `%LOCALAPPDATA%\codex-router` Git 工作树内。
8. 不得把 Install 从固定审计 commit 改成浮动 `main`，除非先完成新版本审计。
