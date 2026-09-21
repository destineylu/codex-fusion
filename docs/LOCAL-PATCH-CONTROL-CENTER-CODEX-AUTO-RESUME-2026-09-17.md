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

2026-09-21 起，Control Center 在上游 sidecar 外增加 **Native Account Guard**。它不改写或 vendor 上游 Python，而是在调用 sidecar 前后管理账号作用域：每个 Native ChatGPT Profile 使用独立 Auto Resume state，thread 通过不可逆 `accountFingerprint` 绑定；当前 live 账号与 thread fingerprint 不一致时 fail-closed，不允许自动续跑。

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

上游 config 入口继续保持默认目录：

```text
Windows:
%LOCALAPPDATA%\vibcoding\codex-auto-resume

macOS:
~/Library/Application Support/vibcoding/codex-auto-resume
```

账号感知模式下，Control Center 保留这个目录作为控制根，并把 `config.json.state_dir` 指向当前原生账号自己的状态目录：

```text
<control-root>/
  config.json
  account-bindings.json
  state.json                    # 旧版 legacy，仅迁移输入
  accounts/
    <accountFingerprint-A>/
      state.json
      codex-fusion-account.json
    <accountFingerprint-B>/
      state.json
      codex-fusion-account.json
```

不同账号的 `last_quota`、handled mark、resume count 和 thread state 不再共用，避免“账号 A 100% 用尽 → 切账号 B 5%”被误判为同一账号额度恢复。

## 4. Control Center API

Preload 只暴露：

```text
getCodexAutoResume()
controlCodexAutoResume(action)
```

允许固定 action 只有：

```text
install
doctor
dry-run
enable-autostart
disable-autostart
enable-reset-credit
disable-reset-credit
```

另有一个受限 IPC：`bindCodexAutoResumeThread(threadId)`。它只允许把一个 UUID thread 显式绑定到**当前** Native ChatGPT Profile 的 `accountFingerprint`，不接受任意 fingerprint、路径、命令或账号凭据。

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

### Native 多账号保护

- Native Profile Manager 维护 `switch-history.json`，只记录 Profile ID、不可逆 account fingerprint 与激活时间，不记录 token；
- 单账号用户即使从未建立 saved Profile，也可以直接使用 live `auth.json` 的不可逆 identity fingerprint 建立独立作用域；不会因此自动创建/复制 Profile 或凭据；
- 对这种未管理单账号，如果 legacy thread 没有 activation 证据，仍必须保持 `UNBOUND`，由用户显式绑定，不能因为“目前只有一个账号”就猜归属；
- 切换账号前，Control Center 暂停正在运行的 Auto Resume watcher；
- auth 切换成功后，把 sidecar `state_dir` 切到目标 fingerprint 的独立目录，再恢复原来的 running/autostart 状态；
- watcher 因而会重新创建 app-server，读取新 live `auth.json`，不会长期持有旧账号 quota session；
- legacy thread 只有在其 observed time 能落入已记录的账号 activation interval 时才自动归属；无法证明的旧 thread 标记为 `UNBOUND`，默认 disabled；
- 已绑定到其他账号的 waiting thread 标记为 `account-mismatch`，默认 disabled；
- 用户可以在 Settings 中把 `UNBOUND` thread 显式“绑定到当前账号”；
- 账号切换不重启 Router，不修改 Router provider、catalog、failover、compact 或 ChatGPT Web。

## 6. UI

入口保持在：

```text
Settings → Codex Auto Resume
```

不增加新的一级导航，避免继续扩大 Control Center 信息架构。

显示：

- Settings：installed / stopped / running、sidecar checkout 与版本、当前 Native 账号名称与 `accountFingerprint`、Guarded/Unbound 状态、autostart、按账号隔离后的 tracked/active thread、每个 thread 的账号归属、UNBOUND 显式绑定按钮、reset-credit 开关、最近一次 doctor / lifecycle / dry-run 结果；
- Status：只读紧凑卡片，显示当前账号作用域、fingerprint、Guarded 状态、watcher/autostart、tracked/active thread、最近状态/检查时间和 weekly reset-credit 自动消耗是否关闭。

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
9. 不得重新把不同 Native ChatGPT 账号的 quota/thread state 合并回同一个 `state.json`。
10. Native 账号切换必须保持“pause watcher → auth transaction → accountFingerprint scope → restore watcher”的顺序；失败时宁可 watcher 停止，也不能让旧账号 state 在新账号下自动续跑。
11. 无法证明归属的 legacy thread 必须保持 UNBOUND/fail-closed，禁止根据余额、Profile label 或 thread 内容猜账号。
12. 不得要求单账号用户先创建 Native Profile 才能使用 Auto Resume；允许以 live auth identity fingerprint 建作用域，但这不能降低 legacy thread 的归属证明标准。

## 10. 2026-09-21 Native Account Guard 最终验收

最终代码与发行 gate：

```text
Control Center tests
84 total
82 PASS
2 platform SKIP
0 FAIL

release:verify
16/16 reproducibility checks
119 tests
114 PASS
5 SKIP
0 FAIL
```

真实本机 dry-run 验收（公开文档去标识化）：

```text
current managed native account = detected
accountFingerprint = <irreversible 12-char fingerprint>
accountGuarded = true
waiting thread = <current-account thread UUID>
thread binding = current
unbound = 0
mismatch = 0
```

该验收只运行 doctor / dry-run，没有发起模型请求。公开文档不记录维护者账号别名、真实 fingerprint 或真实 thread ID。随后恢复 Auto Resume 原有运行状态：

```text
running = true
autostart = true
auto_redeem_weekly_reset = false
Scheduled Task = Running
```

部署使用 official Windows Control Center rebuild transaction；Router 4202 / 4203 在部署前后保持同一 PID，证明 rebuild 未重启 Router。packaged `app.asar` 已验证包含 accountFingerprint guard、account-mismatch、账号切换 watcher pause/restore、受限 thread bind IPC，以及 renderer 的“原生账号作用域 / 绑定到当前账号”。

本轮外层执行器超时后曾留下两条并发 rebuild 链。按恢复规则先检查 transaction/process tree，终止其中一条重复事务链；随后发现 canonical package 处于已知 split-package 状态，于是把两半分别归档到新的 recovery 目录，非覆盖合并恢复完整 canonical package，再启动一个**独立、单事务、受监控** official rebuild。最终 rebuild 正常 commit，journal/orphan rollback 清空，Tray ready，Router PID 全程未变。以后遇到外层 timeout 继续遵守：**先检查 transaction / process tree，不直接重跑 rebuild。**
