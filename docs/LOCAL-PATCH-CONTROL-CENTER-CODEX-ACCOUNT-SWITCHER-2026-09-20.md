# Control Center Codex Native ChatGPT 多账号切换补丁 — 2026-09-20

> 目的：在 Codex Router / Codex Fusion 的 Control Center 内管理多个 **Codex Native GPT / ChatGPT 登录账号**，替代 CC Switch 对 live Codex 文件的并行接管。此补丁只管理 Native ChatGPT 认证身份，不管理第三方 Provider，也不管理 ChatGPT Web Bridge。

## 1. 用户可见入口

路径：

```text
Control Center → Settings → ChatGPT 原生账号
```

第一版只提供四个显式动作：

- 添加账号；
- 重命名账号；
- 手动切换账号；
- 删除非当前账号 Profile。

**不实现自动轮换、额度耗尽自动切号、负载均衡或账号池自动选择。**

## 2. 硬约束

账号切换必须始终满足：

```text
Router 4202 / 4203              不停止、不重启
config.toml                     不修改
model_provider                  不修改
model catalog / picker          不修改
第三方 Provider                不修改
ChatGPT Web shadow CODEX_HOME   不修改
Codex Native live auth.json     唯一被切换的 live 身份文件
```

切换动作不得调用 Router service stop/start/restart，也不得通过 catalog republish 间接改变模型路由。

现有 `src/codex-native-session.mjs` 的 `nativeSessionHeaders()` 每次请求都会重新读取 live `auth.json`，因此 Router 进程不需要因账号切换重启。

## 3. 存储

默认 Profile 根目录：

```text
%USERPROFILE%\.codex\codex-router\native-accounts
```

结构：

```text
native-accounts/
├─ accounts.json
├─ active-account.json
├─ last-switch-backup.json
└─ profiles/
   ├─ <uuid-A>/auth.json
   └─ <uuid-B>/auth.json
```

认证文件按私密文件处理：

- POSIX：目录 0700、文件 0600；
- Windows：使用当前 Windows SID 的 owner-only DACL；
- UI 只显示账号别名、可用/过期状态和不可逆 identity fingerprint；
- UI、日志、IPC 返回值均不得包含 access token、refresh token 或完整 account id。

## 4. 添加账号

添加账号使用官方 Codex 登录，不由 Control Center 自己实现 OAuth：

```text
Control Center
  → 创建隔离 Profile CODEX_HOME
  → official codex login
  → 浏览器完成 ChatGPT 登录
  → 登录成功后只保留该 Profile 的 auth.json
```

隔离登录环境会移除 `OPENAI_BASE_URL`、`OPENAI_API_BASE`、`OPENAI_API_KEY`，避免 Router 路由变量污染官方登录。

如果第一次启用账号管理时 live `%USERPROFILE%\.codex\auth.json` 已存在，Control Center 会先把它保存成：

```text
当前 Codex 账号
```

然后才启动第二账号的隔离登录，所以“添加账号”不会切换当前身份。

## 5. 切换事务

第一版要求 **Codex Desktop 完全退出** 后再切换；Router 必须继续运行。

事务顺序：

1. 检查 Codex Desktop 是否仍在运行；若运行则拒绝切换。
2. 校验目标 Profile 的 auth 可用；如果 access token 已过期但仍有 refresh token，允许切换并标记为“打开 Codex 后刷新”，不能把短期 access token 过期误判为整个账号失效。
3. 把当前 live `auth.json` 的最新内容同步回当前 Profile，保留 Codex 最近刷新过的 token 状态。
4. 保存 live auth 回滚备份。
5. 原子替换 live `%USERPROFILE%\.codex\auth.json`。
6. 重新读取 live auth，验证身份指纹与目标 Profile 一致。
7. 验证成功后更新 `active-account.json`。
8. 若验证失败，恢复切换前备份。
9. 用户重新打开 Codex Desktop。

这里**不包含 Router lifecycle 操作**。

## 6. 与 ChatGPT Web 的边界

ChatGPT Web Bridge 继续使用自己的：

```text
%LOCALAPPDATA%\codex-router-sidecars\codex-chatgpt-web\codex-home
```

Native 账号切换不得读取、复制或改写该 shadow CODEX_HOME。两个登录体系保持完全隔离。

## 7. 代码位置

核心：

- `apps/control-center/electron/codex-account-profiles.mjs`

接口：

- `apps/control-center/electron/ipc.mjs`
- `apps/control-center/electron/preload.cjs`
- `apps/control-center/electron/api.d.ts`
- `apps/control-center/src/types.ts`

界面：

- `apps/control-center/src/pages/SettingsPage.tsx`
- `apps/control-center/src/styles.css`

测试：

- `test/control-center-electron.test.mjs`
- `apps/control-center/test/renderer.test.mjs`

## 8. 回归验收

必须至少证明：

1. 添加第二账号不会改变当前 live `auth.json`。
2. Codex Desktop 未退出时切换被拒绝。
3. 切换前当前账号的 refreshed auth 会同步回其 Profile。
4. 切换后 live auth 身份与目标 Profile 一致。
5. `config.toml` 在切换前后字节不变。
6. Router PID / lifecycle 哨兵在切换前后不变。
7. UI 明示“Router 始终保持运行”，且不提供自动切号开关。
8. access token 已过期但仍有 refresh token 的备用 Profile 仍可切换，等待官方 Codex 刷新。
9. Control Center typecheck、Electron syntax、renderer tests 通过。

真实双账号 OAuth 与最终 A→B 切换已经完成本机人工验收：只退出并重开 Codex Desktop，Router 全程保持运行。

## 9. 2026-09-20 本机部署验收

代码与 UI 已部署进当前 Windows Control Center canonical package：

```text
%LOCALAPPDATA%\codex-router\apps\control-center\release\win-unpacked
```

最终证据：

- `npm --prefix apps/control-center run check`：PASS；
- 完整 Control Center tests：82 项，80 PASS / 2 platform SKIP / 0 FAIL；
- official `tray rebuild`：exit 0；
- transaction journal：已 commit 并清除；
- Control Center lifecycle：`running=true / ready=true`；
- packaged `app.asar` 已确认包含 `electron/codex-account-profiles.mjs`；
- packaged renderer 已确认包含“ChatGPT 原生账号”和“Router 始终保持运行”；
- packaged account module 静态验收确认不存在 `controlService` / `runControl` / `controlTray` 调用；
- Router 4202 / 4203 的 PID 哨兵在部署前后保持不变，证明 Control Center rebuild 没有重启 Router；公共文档不记录维护者机器的具体 PID。

部署中第一次长时 rebuild 被外层工具执行时限截断，触发了已知 Windows split-package 状态：

```text
release/win-unpacked
  → app.asar 等资源半包

release/.win-unpacked.previous-transaction
  → Codex Router.exe 等另一半
```

按既有升级规则完成恢复：

1. 两半分别归档；
2. 字节核验 rollback archive 与原 rollback 一致；
3. 非覆盖合并恢复完整 canonical package；
4. 停止 Tray（Router 不停）；
5. 将 orphan rollback 移出 active release；
6. canonical Tray 恢复成功；
7. 再次执行受监控 official `tray rebuild`；
8. 新 package 成功 commit。

恢复证据保存在：

```text
apps/control-center/release-recovery/split-package-20260920-0228/
```

该 recovery archive 属于升级保护资产，**不要用 git clean 或普通清理脚本删除**。

第一次添加账号尝试后，当前 live 账号已经被 Profile Manager 安全收录；失败的第二账号 OAuth 没有留下可用 Profile，也没有改变 live auth。

## 10. 无痕窗口登录回调修复

首次真实使用发现：用户把普通 `codex login` 弹出的完整 OAuth 地址复制到 Chrome 无痕窗口并成功完成网页登录后，Control Center 仍然没有收到完成状态。现场证据为：

- 官方 `codex.exe login` 仍持续运行；
- 本机 `127.0.0.1:1455` callback listener 仍在等待；
- 新账号隔离 Profile 中没有生成 `auth.json`；
- 因此问题发生在网页登录后的 localhost callback 返回阶段，而不是账号密码、state/PKCE 地址或 Router。

最终采用 CLIProxyAPI 同类的“手工 localhost callback 回传”模式作为主流程，同时保留官方 device-auth 作为备用。

### 浏览器 OAuth / 无痕登录（推荐）

1. Control Center 在隔离 `CODEX_HOME` 中启动官方 `codex login`；
2. 官方 Codex 仍负责生成 state、PKCE verifier/challenge、打开授权页和最终 token 交换；
3. 用户可以在弹出的浏览器中直接登录，也可以复制同一授权 URL 到 Chrome 无痕窗口；
4. 如果最终跳转到 `http://localhost:1455/auth/callback?code=...&state=...` 时页面无法访问，用户只需复制地址栏中的完整 callback URL；
5. Control Center 严格只接受：
   - `http://localhost:<expected-port>/auth/callback`
   - `http://127.0.0.1:<expected-port>/auth/callback`
   - 必须包含 `code` 与 `state`
   - 如果已从授权 URL 捕获 expected state，则必须完全匹配；
6. Control Center 不自己交换 token，而是把 callback 请求直接送到本机 `127.0.0.1:<expected-port>`，并保留 `Host: localhost:<port>`；
7. 等待官方 `codex login` 完成后，再验证隔离 `auth.json`，保存为新 Profile；
8. callback URL 和 OAuth code 不写入持久日志；
9. 当前 live 账号、Router、`config.toml`、第三方 Provider 与 ChatGPT Web 全程不变。

这种方式解决了“常用 Chrome 已登录账号 A，但需要在无痕窗口登录账号 B”时 localhost 自动回调失败的问题，同时没有在 Control Center 内重新实现 OpenAI token exchange。

### 设备代码登录（备用）

如果 localhost 回调环境仍有异常，可使用：

```text
codex login --device-auth
```

Control Center 会显示官方验证地址和一次性代码；该模式完全不依赖 localhost callback。

Settings 的“添加 ChatGPT 账号”现在提供两个入口：

- **浏览器 OAuth / 无痕登录（推荐）**：支持手工提交完整 localhost callback URL；
- **设备代码登录（备用）**：官方 device-auth。

新增接口：

- `startCodexAccountBrowserLogin(label)`
- `submitCodexAccountCallback(callbackUrl)`
- `startCodexAccountDeviceLogin(label)`
- `cancelCodexAccountLogin()`
- `CodexAccountProfilesSnapshot.loginSession`

新增测试：

- browser OAuth 授权 URL / state / callback port 解析；
- CLIProxyAPI 风格手工 callback relay；
- state mismatch 拒绝；
- callback relay 后仍由官方登录进程生成隔离 `auth.json`；
- device-auth prompt 解析与备用流程；
- renderer 实际点击“浏览器 OAuth / 无痕登录（推荐）”，填写并提交 callback URL；
- 完成后第二 Profile 保存成功且 live auth 不变。

最终测试：

```text
Control Center tests = 82
PASS = 80
platform SKIP = 2
FAIL = 0
```

最终部署状态：

```text
official tray rebuild = exit 0
transaction journal = none
Control Center = running / ready
4202 PID = unchanged across deployment
4203 PID = unchanged across deployment
```

packaged `app.asar` 已验证：

- backend 包含 `submitCodexAccountCallback`、`/auth/callback`、state 校验和 `127.0.0.1` loopback relay；
- backend 仍不存在 Router service/tray lifecycle 调用；
- renderer 包含“提交回调 URL”；
- renderer 包含“浏览器 OAuth / 无痕登录（推荐）”；
- renderer 包含“设备代码登录（备用）”；
- `routerRestartRequired=false`；
- `configMutationRequired=false`。

## 11. Codex Desktop 退出误判修复

真实第二账号登录成功后，第一次切换仍被 Control Center 拒绝，提示“请先完全退出 Codex Desktop”。现场检查确认 Desktop 已经退出，但 Windows 仍有两个进程：

```text
%APPDATA%\npm\node_modules\@openai\codex\...\bin\codex.exe app-server
%APPDATA%\npm\node_modules\@openai\codex\...\bin\codex.exe app-server --listen stdio://
```

两者都是 Codex CLI / app-server，`MainWindowHandle=0`，不是 Desktop。

旧检测只执行：

```text
tasklist /FI "IMAGENAME eq Codex.exe"
```

因此任何 CLI `codex.exe` 都会被错误识别为 Desktop，导致账号永远无法切换。

当前 Windows Codex Desktop 是 AppX：

```text
OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0
C:\Program Files\WindowsApps\OpenAI.Codex_...\app\Codex.exe
C:\Program Files\WindowsApps\OpenAI.Codex_...\app\ChatGPT.exe
```

修复后 `codexDesktopRunning()` 不再按进程名判断，而是读取 Codex/ChatGPT 进程的真实可执行路径，只把以下 Desktop 安装根视为阻塞条件：

- `WindowsApps\OpenAI.Codex_*\app\Codex.exe`
- `WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe`
- 兼容传统 `AppData\Local\Programs\...\Codex` / `Program Files\OpenAI\Codex` Desktop 安装路径。

明确排除：

- npm `@openai/codex` CLI；
- `codex.exe app-server`；
- AppX 包内 `app\resources\codex.exe` CLI；
- OAuth `codex login` CLI。

新增测试覆盖 CLI-only=false、AppX resources CLI=false、AppX Desktop=true。

修复后本机实际快照满足：

```text
desktopRunning = false
targetProfile.active = true
targetProfile.liveMatches = true
```

真实 A → B 切换已完成，live `auth.json` 与目标 Profile 一致；原账号 Profile 仍保留，可随时切回。

最终 Control Center tests：

```text
82 total
80 PASS
2 platform SKIP
0 FAIL
```

检测修复部署前后，Router 4202 / 4203 的 PID 哨兵保持不变；真实 A → B 切换本身没有触发 Router 重启。
