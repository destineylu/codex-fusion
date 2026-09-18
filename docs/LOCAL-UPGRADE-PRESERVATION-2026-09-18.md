# Codex Router 本地部署与升级保护存档 — 2026-09-18

> **升级前先读。** 本文件记录 2026-09-18 已完成并验收的本地部署。升级 Router 时不得直接覆盖这些能力，也不要重新调查已经明确解决的问题。

## 1. 当前基线

- Router / Control Center：`0.5.1`
- Router 分支：`upgrade-v0.5.1-20260903-083902`
- Router HEAD：`626fd9f968526d9cb5b8275458e33ba7c2f0c984`
- Windows 默认工作目录：`%LOCALAPPDATA%\codex-router`
- 当前仓库存在多项本地未提交补丁；**禁止**在升级前执行 `git reset --hard`、盲目 checkout 覆盖或直接 `update`。
- 模型策略：显式 provider / 显式 model；**禁止自动 fallback / 自动换模型**。
- 可重复发行源：`https://github.com/destineylu/codex-router.git` 的 `main`。
- Router 参考上游：`https://github.com/duolahypercho/codex-router.git`；只用于审计/适配，不由生产安装自动合并。
- 发行与上游升级总规则见 `docs/REPRODUCIBLE-V1.md`。

生产 Control Center 当前文件哈希：

- `apps/control-center/release/win-unpacked/Codex Router.exe`
  - SHA-256 `D072844AE02C08F65828C52585F6DEC0FA37BE86B9C79DB7DD5C7DBCC8026505`
- `apps/control-center/release/win-unpacked/resources/app.asar`
  - SHA-256 `8BD50C232230B140268A4328DF66FBB52C5F70F8D6ED7CCA0E0177C0AFCC06A6`

注意：Control Center 开启 `enableEmbeddedAsarIntegrityValidation=true`，因此以后不能只手工替换 `app.asar`；若重新打包，必须让 `Codex Router.exe` 与 `app.asar` 来自同一套 electron-builder 输出。

## 2. Windows 登录后的生产启动链

系统保留三项任务：

```text
Codex Router
Codex Router Tray
VibcodingCodexAutoResume
```

不存在独立的 `Codex ChatGPT Web Managed` Scheduled Task。

启动关系：

```text
Windows 登录
  ├─ Codex Router → 4202 / 4203
  ├─ Codex Router Tray --tray-only
  │    └─ 延迟约 30 秒，先验证真实 Codex route owner 仍为 Router
  │         └─ 恢复 isolated Codex Web GPT / 17841
  └─ VibcodingCodexAutoResume
```

ChatGPT Web 上游 launcher 自身 `autoStart=false`，不得改为 true；不得创建直接启动普通 `Codex Web GPT.exe` 的 Run / RunOnce / 登录任务。登录恢复只能由打包后的 Control Center Tray 在受控环境里执行。

真实 Codex route 必须始终保持：

```text
Codex Desktop
  → http://127.0.0.1:4202/_codex-router/<capability-redacted>/v1
```

不得把真实 Codex 改成直连 17841。

## 3. ChatGPT Web Bridge — 最终生产状态

上游：`miuuyy/codex-chatgpt-web`

- 已审计版本：`5.0.8`
- Windows x64 installer SHA-256：`83224d59506462ab2976f437bfaea96b046d4ed55caa7e1cfd6a3d61de0a8ff3`
- launcher：`%LOCALAPPDATA%\Programs\Codex Web GPT\Codex Web GPT.exe`
- managed root：`%LOCALAPPDATA%\codex-router-sidecars\codex-chatgpt-web`
- shadow `CODEX_HOME`：`...\codex-chatgpt-web\codex-home`
- launcher data：`...\codex-chatgpt-web\launcher`
- upstream bridge：`127.0.0.1:17841`
- Router API forwarder：`127.0.0.1:4203`
- Router：`127.0.0.1:4202`

生产链路：

```text
Codex Desktop
  → 4202 Codex Router
  → nativeSessionAuth provider 直接走 4203 api-forwarder
  → 17841 upstream-managed ChatGPT Web bridge
  → ChatGPT Web
  → Codex Native2 Full Harness
```

### 3.1 为什么 nativeSessionAuth 必须绕过 LiteLLM

旧路径会让 LiteLLM 转换后的 Responses 请求丢失 `client_metadata.x-codex-turn-metadata / turn_id`，导致 routed tools / turn 校验失败。

最终修复：

- `src/router.mjs`
  - `nativeSessionAuth + openai-responses` 走 `API_FORWARD_BASE`，不经过 LiteLLM；
  - compaction 同样走 4203；
  - native session 保留 `client_metadata` 与 reasoning。
- `src/api-forwarder.mjs`
  - native session 不删除 `client_metadata`。

普通 provider 仍保持原路径：

```text
4202 → 4200 LiteLLM → 4203 → provider
```

### 3.2 Full Harness / Browser

- ChatGPT Developer Mode 已开启。
- Connector：`Codex Native2`，Tunnel 模式，权限保持保守设置。
- Full Harness 工具包括 exec / apply_patch / tool inventory / view image / write stdin 等。
- Tunnel 与 launcher 需要继承 Windows WinINET loopback proxy；如用户启用了本机代理，只接受 loopback 代理地址，不在发行版中写死端口。
- `apps/control-center/electron/codex-chatgpt-web.mjs` 只接受 loopback proxy，不接受任意远端 proxy。
- 上游 launcher 的 preflight 原 15 秒超时曾不足，安装后的 `app.asar` 做过 15s→60s 精确长度补丁；备份与已审计补丁记录保留在 managed root 的 `patch-backups` 下。升级上游 launcher 时必须重新核对该问题是否仍存在，不要盲目沿用旧二进制补丁。

### 3.3 已正式发布的三个模型

当前 user model registry 已持久化：

```text
chatgpt-web/light   41K
chatgpt-web/medium  90K
chatgpt-web/high    90K
```

三者均已完成 2026-09-18 最终 live Gate：

```text
direct basic
streaming
tools
reasoning
final routed compatibility through 4202
```

三个模型现在是正式 picker 项，不是临时 discovery 项。

### 3.4 Control Center 相关文件

重点保留：

- `config/chatgpt-web/chatgpt-web.json`
- `apps/control-center/electron/codex-chatgpt-web.mjs`
- `apps/control-center/electron/main.mjs` 中 Tray-managed 登录恢复逻辑
- `apps/control-center/electron/ipc.mjs`
- `apps/control-center/electron/preload.cjs`
- `apps/control-center/src/pages/SettingsPage.tsx`
- `apps/control-center/src/types.ts`
- `apps/control-center/electron/api.d.ts`
- `src/model-registry.mjs`
- `src/model-discovery.mjs`
- `src/untrusted-model-discovery.mjs`
- `src/provider-selection.mjs`
- `src/user-models.mjs`
- `src/verify-model.mjs`
- `src/compatibility-test.mjs`
- `src/smoke-test.mjs`
- `src/router.mjs`
- `src/api-forwarder.mjs`
- 相关 tests / renderer tests

详细设计记录：

`docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-CHATGPT-WEB-2026-09-17.md`

## 4. Codex Auto Resume

上游：`feifeigong/codex-auto-resume`

- 版本：`0.2.2`
- sidecar：`%LOCALAPPDATA%\codex-router-sidecars\codex-auto-resume`
- 状态：installed / running
- Windows autostart：enabled
- Scheduled Task：`VibcodingCodexAutoResume`
- `auto_redeem_weekly_reset=false`

它只负责：

```text
原生 Codex quota 恢复
→ 在原 thread 继续
```

它**不参与**：

- Router provider fallback
- 自动切模型
- compact
- model picker
- subagent / Single / Team

升级或重装后必须重新确认 `auto_redeem_weekly_reset=false`，不得因为上游默认值而恢复自动消耗 reset credit。

重点保留：

- `apps/control-center/electron/codex-auto-resume.mjs`
- Control Center Settings / Status 显示与固定 actions
- `docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AUTO-RESUME-2026-09-17.md`

## 5. Codex ComfyUI 插件

独立仓库：用户自选工作目录中的 `codex-comfyui`（不属于 Router v1 主仓库）

当前：

- branch：`codex-port`
- HEAD：`9592a9d2a035c9148f0bf0d192d7fc2cfd94ce3a`
- Codex plugin：`codex-comfyui 0.3.0`
- `pnpm build:codex`：PASS（2026-09-18）

双 target：

```text
local  → http://127.0.0.1:8188
remote → 用户自己的远端 ComfyUI 地址
default target → remote
```

Companion Panel：

```text
http://<trusted-panel-host>:8189
```

规则：

- `comfyui_target list/select` 显式切换；
- **禁止自动 fallback**；
- 目标不可达时保持原 target 并明确失败；
- target 选择持久化；
- 切换 target 清空 load area，防止后端本地文件名串用；
- 已提交 prompt 记录原 target，后续 result / sweep / media 仍回原 ComfyUI；
- Panel 顶部可切 local / remote；
- Panel 并非完整 ComfyUI 节点 graph editor，目前是 workflow / 参数 / load area / queue / assets 控制面板。

Windows 防火墙应只允许用户明确授权的可信远端访问 Panel 8189，不要改成全网开放。

完整 ComfyUI 部署存档见：

`<codex-comfyui-workspace>\docs\CODEX-DEPLOYMENT-2026-09-18.md`

## 6. Control Center 现有入口

### ChatGPT Web

路径：

```text
Control Center → Settings → ChatGPT Web Bridge
```

现有内容包括：

- Launcher 状态
- Browser host / smoke 状态
- Bridge daemon 17841
- Codex route owner
- Router provider readiness
- Managed Start / Start 17841 / Stop managed
- Open browser
- Verify isolation
- View source

不要再增加第二套 ChatGPT Web 控制页面。

### Codex Auto Resume

路径：

```text
Control Center → Settings → Codex Auto Resume
```

现有内容包括：

- Sidecar 状态
- 登录自启状态
- tracked / active threads
- weekly reset-credit 显式开关（默认关闭）
- Run doctor
- Dry-run scan
- Enable / Disable autostart
- View source

Status 页另有只读状态卡。**当前已经有设置入口，不需要新增。**

## 7. 升级 Router 时的正确顺序

1. 先读本文件及两份 LOCAL-PATCH 文档。
2. 记录当前 branch / HEAD / `git status --short`；不要清工作树。
3. 在独立 worktree 或临时分支检查上游新版差异。
4. 先判断上游是否已经原生解决某项补丁，再决定保留 / 适配 / 删除本地补丁；不要机械覆盖。
5. 优先恢复：
   - provider registry / user model namespace；
   - nativeSessionAuth 4203 direct path；
   - ChatGPT Web managed isolation；
   - Tray-managed login recovery；
   - Auto Resume fixed actions / reset-credit safe default；
   - Control Center Settings / Status；
   - Single / Team 等既有本地补丁。
6. `npm --prefix apps/control-center run check`。
7. 运行 Control Center tests。renderer 偶发 click timeout 要单独重跑确认，不要一次偶发超时就改业务代码。
8. 打包 Control Center 时，如果仓库下 `release/win-unpacked` 被 Windows 文件句柄 EBUSY 占用，优先输出到 `%LOCALAPPDATA%\Temp\...`；由于启用了 Embedded ASAR Integrity，必须整套使用匹配的新 exe + app.asar。
9. 重启 `Codex Router Tray`，不要为了 UI 更新重启正在执行任务的 Router。
10. 最终验收 4202 / 4203 / 17841、route owner、三个 Web 模型、Auto Resume、ComfyUI plugin。

## 8. 减少下次测试时间

这次耗时长，主要因为三个 ChatGPT Web 模型各自完整跑 direct + browser + tools + reasoning + routed Gate，浏览器 UI 一个 turn 常需数十秒，tools completion evidence 最慢。

以后不要无条件重复三模型全量 Gate：

- 如果只改 Control Center UI、Usage、文案、无关 provider：不需要重跑三模型 live Gate。
- 如果只升级 Router 但 `nativeSessionAuth / Responses / api-forwarder / model registry / verify-model` 没变化：先做静态测试 + 17841 health + `light` canary；通过后再判断是否需要 medium/high。
- 只有涉及 ChatGPT Web auth、browser harness、Responses payload、4202/4203 routing、compaction、tool metadata 时，才需要完整三模型 live Gate。
- 任何新发现模型仍必须完整 live verify 后再发布。

## 9. 最终验收基线

必须同时成立：

```text
Router 4202                running / degraded=[]
API forwarder 4203         listening
ChatGPT Web 17841           reachable
routeOwner                  router
safeToDiscover              true
upstream launcher autoStart false
chatgpt-web/light           listed
chatgpt-web/medium          listed
chatgpt-web/high            listed
Auto Resume                 running + autostart
weekly reset auto redeem    false
Control Center Tray         running
```

升级后若某一项不成立，先修该项，不要启用 fallback 作为替代。
