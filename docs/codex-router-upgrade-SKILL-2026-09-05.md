---
name: codex-router-upgrade
description: >
  Safely upgrade a local Codex Router installation on Windows while preserving
  provider credentials, user models, model-picker state, routed subagents,
  native/routed MultiAgent V2 compatibility, proxy settings, rollback points,
  Control Center recovery packages, verified
  local model additions, and local Windows patches. Use when upgrading Codex
  Router to a newer release, comparing local patches against upstream,
  rebuilding or recovering Control Center, republishing the model catalog, or
  validating Router/Tray/Codex after an upgrade.
---

# Codex Router Upgrade Skill

> Updated reference snapshot: **2026-09-05**. This revision adds the measured Xkiro Claude Opus 5 payload-safety workaround and an explicit-consent-only rule for any cross-model failover, including compaction.

## Purpose

Use this skill when upgrading an existing **Codex Router** installation on Windows.

The goal is not simply to pull the newest code. The goal is to:

1. preserve all user/provider state;
2. create a reliable rollback point;
3. upgrade to an explicit release commit;
4. avoid restoring obsolete patches;
5. compare current local patches against upstream equivalents;
6. validate Router backend first;
7. validate Control Center / Tray separately;
8. preserve the model-discovery / verify-model / curated-model workflow;
9. republish model catalog and routed agents safely;
10. verify Codex managed integration and Desktop with a real low-cost request;
11. preserve both native OpenAI subagents and routed third-party subagents;
12. leave the installation recoverable.

This skill is written for the current known Windows installation pattern:

```text
%LOCALAPPDATA%\codex-router
%USERPROFILE%\.codex\codex-router
%USERPROFILE%\.codex\config.toml
```

The exact paths may differ on another machine. Resolve them before making changes.

---

# 1. Non-negotiable safety rules

## Never perform these actions during an upgrade

Do **not** use:

```text
git reset --hard
git clean -fd
git clean -fdx
git checkout -- <broad path>
git restore --source=... <broad path>
whole stash pop
whole stash apply
force checkout over user files
blind origin/main upgrade
```

Do not delete or recreate:

```text
Provider credentials
user-models.json
model-picker.json
multi-agent-settings.json
multi-agent proofs/state
Codex config.toml
Router caller/internal secrets
rollback tags
upgrade backups
apps/control-center/release-recovery/
Control Center transaction and rollback artifacts until the transaction is settled
```

Do not change these unless the upgrade specifically requires it and the user explicitly approves:

```text
Router backend architecture
Windows Router Service
Scheduled Task "Codex Router"
4200-series ports
proxy 127.0.0.1:7890
Provider identities
custom Provider definitions
```

Do not weaken tests, remove failing tests, or increase timeouts merely to make failures disappear.

Do not force-kill Control Center as the normal upgrade path.

Do not run concurrent `tray install`, `tray refresh`, or `tray rebuild`
operations. If a long-running tray mutation returns a connector/transport 502,
first inspect the already-running updater/build process and the transaction
journal. Do not immediately start a second mutation.

Treat `apps/control-center/release-recovery/` as a protected recovery asset, not
as ordinary build output. Never remove it with `git clean`, and never discard a
`split-package-*` archive until the canonical package and a later successful
transaction have both been verified.

Do not send live or quota-consuming provider probes merely to make an upgrade
look complete. `verify-model --live --yes`, `test-model --live --yes`, and real
Codex compatibility turns require explicit user approval because they can spend
provider quota or credits.

For MultiAgent V2 compatibility, do **not** patch Codex Desktop binaries, app.asar,
WindowsApps files, or the bundled Codex runtime as the normal solution. The
verified 2026-09-05 repair is Router-side. Modify Codex Desktop only as a last
resort with explicit user approval.

Do not make routed third-party subagents depend on an OpenAI/ChatGPT native
decrypt relay as their primary handoff path. That design was proven to fail
precisely when native membership quota was exhausted: enabling session sharing
changed HTTP 401 into HTTP 429. Session sharing may be a diagnostic or optional
native capability, but it is not a prerequisite for the final routed-parent
subagent path.

## Model identity is an operator decision

Cross-model failover is a semantic change, not an ordinary transport retry. The
Router must never silently choose a different model simply because the selected
model hit quota, rejected a payload, failed compaction, or became unavailable.

Automatic behavior may retry the **same selected model / route** when the normal
retry policy permits it. Moving work to another model requires explicit operator
authorization for the exact fallback slug(s). This applies equally to ordinary
turns and to `/responses/compact`: a hidden model switch during compaction would
rewrite the checkpoint that shapes every later turn while the UI still appears
to be using the originally selected model.

The authorization contract is:

```text
failover.enabled = true
AND
failover.chain contains one or more explicitly named model slugs
```

Therefore:

```text
enabled = true + chain = []
→ no cross-model failover

failover state absent / defaulted
→ failover disabled

selected model cannot serve the request
→ prefer an explicit failure over an unapproved model substitution
```

Never interpret an empty chain as permission to auto-rank or auto-select a
replacement model. Never restore that behavior during an upgrade merely because
a newer upstream release contains an automatic failover feature.

---

# 2. Current known Windows architecture

Before upgrading, confirm the live installation instead of assuming it still matches this section.

Current v0.5.1 architecture uses:

```text
4200  LiteLLM Gateway
4201  Kimi OAuth forwarder
4202  Router / caller surface
4203  API / Anthropic forwarder
4208  Grok OAuth forwarder
```

The Windows desktop surface is:

```text
apps/control-center
```

not the old:

```text
apps/desktop
```

Control Center and Tray are one Electron application.

The Router background service and Control Center/Tray are separate planes.

---

# 3. Proxy model

Current proxy handling should be treated as **native Router state**, not a local patch.

Expected proxy environment:

```text
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
```

Important files/functions:

```text
%USERPROFILE%\.codex\codex-router\install-manifest.json
src/proxy-environment.mjs
src/install-manifest.mjs
src/service-windows.mjs
src/start.mjs
src/fetch-transport.mjs
```

Expected behavior:

```text
installer records proxy
→ install-manifest.json
→ serviceProxyEnvironment()
→ generated start-codex-router.cmd
→ Router process inherits proxy
→ Undici EnvHttpProxyAgent
→ 127.0.0.1:7890
```

Do not restore the old proxy patch merely because the generated CMD changes.

---

# 4. Old patches that should remain archived only

Do not reapply these historical v0.4.x patches unless a fresh investigation proves the new release regressed:

```text
windows-router-proxy-fix.patch
windows-service-orphan-fix.patch
old apps/desktop / Tauri GUI patches
```

They are historical references, not current upgrade inputs.

---

# 5. Current local patch families to compare against upstream

The known v0.5.1 local chain on 2026-09-04 is:

```text
97ec9a7  official v0.5.1 base
d2ef9fe  renderer locale fix
2661b26  Windows tray recovery + ACL structural comparison
9418d68  Control Center Limited-token open fix
040244b  persisted Control Center interface scale
dd24804  Control Center Skill profile controls
501b5fe  surface Codex mode controls in Control Center
81cb030  tolerate provider account-usage timeouts
```

The current working tree also contains important **uncommitted patch families**.
Treat them as upgrade inputs until they are either committed or proven absorbed
upstream:

```text
verify-model
  - safely verify an advertised but blocked model before local curation
  - basic + streaming + tool calling + optional reasoning
  - multi-protocol route selection
  - requestProfile detection such as auto-tool-choice
  - --apply only after exactly one compatible route
  - final routed compatibility proof
  - exact user-models / model-picker rollback on final failure

Command Code overlong tool-name compatibility
  - Command Code Chat rejects function names longer than 64 characters
  - deterministic request-local hashed aliases
  - history and tool_choice use the same alias
  - returned calls restore the exact native tool identity
  - do not globally truncate tool names
  - do not apply the rule to unrelated providers without evidence

Control Center provider-first model management
  - Models > Picker groups models by canonical Provider
  - protocol variants such as commandcode-messages fold into Command Code only
    in Control Center presentation
  - Models > Add Models performs Provider-scoped Fetch / Refresh
  - compatible models use Add
  - blocked models use Verify & add
  - Codex native UI is not modified

Control Center Codex Native Agent Mode
  - Settings exposes project-scoped Single / Sol + Luna Team
  - this controls Codex Native Multi-Agent only and remains independent from
    Router setSubagentMode / setSubagentModel / setSubagentEffort
  - Control Center copies verified config.single.toml / config.team.toml instead
    of regenerating TOML in Electron
  - agent-mode.txt plus byte equality with config.toml is the read-back proof
  - renderer may choose only single/team and may not supply filesystem paths
  - Team only enables native multi-agent capability; it must not auto-spawn a
    team unless the user explicitly invokes $sol-luna-orchestrator or explicitly
    requests a Sol + Luna team
  - the current user's pre-upgrade mode must be preserved rather than defaulting
    every upgrade to team or single
  - detailed local archive:
    docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md

Curated model display provenance
  - legacy default "MODEL_ID (curated)" is presented as
    "MODEL_ID (Provider Display Name)"
  - official registry names remain unchanged
  - user-custom display names remain unchanged
  - model slug, route, protocol, Provider id, and credential remain unchanged

Windows Control Center PID-reuse race
  - stale lifecycle PID may be reused by PowerShell/Node after Electron exits
  - PID existence alone is not proof that Control Center is still running
  - exact executable/process identity must participate in lifecycle decisions
  - never weaken normal no-force-kill / exact-process safety gates

Codex managed catalog recovery
  - current Router mode normally keeps model_provider = "openai"
  - Router integration is carried by managed openai_base_url and
    model_catalog_json
  - if both disappear, Codex falls back to the native OpenAI model cache and all
    third-party picker entries appear to vanish even though user-models.json and
    merged-models.json still exist

Xkiro Claude Opus 5 serialized-payload protection
  - exact route: xkiro/anthropic/claude-opus-5
  - Xkiro advertises a 1,000,000-token context window, but live measurements on
    2026-09-05 found a separate serialized-request-size failure boundary
  - the failure reproduces through both the OpenAI-compatible surface and
    Anthropic Messages, so switching protocol does not solve it
  - measured controls disproved a simple token-window limit:
      350,537 input tokens / about 700 KB → success
      about 1.188 MB serialized request → success
      about 1.190 MB serialized request → failure
  - retain contextWindow = 1,000,000
  - publish effective autoCompact = 230,000 for this exact route
  - enforce a conservative 1,150,000-byte serialized request safety limit
  - reject locally with context_length_exceeded-style semantics before contacting
    Xkiro when that exact-route payload limit is exceeded
  - do not generalize this limit to Xkiro Sonnet/Fable/other providers without
    separate evidence
  - relevant local files include src/provider-payload-limits.mjs,
    src/api-forwarder.mjs, src/model-registry.mjs, src/router.mjs and focused tests

Explicit-consent-only cross-model failover
  - default failover is disabled
  - enabled=true with chain=[] is intentionally inert
  - cross-model recovery is legal only when the operator explicitly names the
    fallback model slug(s) in failover.chain and enables failover
  - ordinary turns, cooldown handling, quota recovery, and compaction all obey
    the same authorization boundary
  - without authorization, failure stays on the selected model and is reported
    explicitly instead of being served by a hidden replacement
  - this prevents blind-box execution where the picker says one model but a
    different model actually generated a turn or conversation checkpoint
  - relevant local files include src/model-failover.mjs, src/router.mjs and
    test/model-failover*.test.mjs

Codex Desktop MultiAgent V2 routed-parent compatibility
  - verified Desktop surface: Codex Desktop 26.901.41600
  - verified Desktop-bundled internal runtime during this work: codex.exe 0.153.4
  - do not confuse that bundled runtime with an older npm/PATH Codex CLI
  - the map form of features.multi_agent_v2 must include enabled=true; merely
    publishing max_concurrent_threads_per_session / usage hints is not enough
  - parent eligibility and child eligibility are separate Router state:
    parentEnabled must not implicitly add the parent model to the child pool
  - preserve exact native collaboration identity on the response path:
    {name:"spawn_agent", namespace:"collaboration"}
  - support all observed Codex 26.901 tool-definition shapes:
      * native type=namespace container
      * explicit type=function + namespace=collaboration
      * already-flat Codex built-ins such as collaboration__spawn_agent
  - LiteLLM / Chat bridges may flatten namespace calls for the provider, but the
    Router must restore the exact request-local native identity before Desktop
    dispatches the call
  - preserve the 2 MiB bounded initial SSE frame budget in namespace-relay:
    LiteLLM can echo instructions + the full Codex tool catalog in
    response.created / response.in_progress; the previous 256 KiB bound disabled
    namespace restoration before collaboration__spawn_agent arrived
  - do not blindly increase or remove that bound; keep it finite and retain the
    oversized-frame fail-safe tests
  - routed third-party parents use Codex's official plaintext handoff marker:
    remove message.encrypted=true only from the provider-facing copy of
    spawn_agent/send_message/followup_task; do not mutate the client/native schema
  - replace historical gAAAAA collaboration message ciphertext only in the
    routed provider replay with a non-secret placeholder instructing the model to
    generate the current delegation as literal plaintext
  - when, and only when, the routed parent returns a genuine plaintext
    collaboration message, restore the native namespace and add
    encrypted_function_args=[]
  - never label a gAAAAA/native ciphertext message with
    encrypted_function_args=[]; fail safe instead
  - the old local parent-task cache may remain as a bounded fallback/diagnostic,
    but it is not the primary solution because real Codex V2 parent calls normally
    carry native ciphertext
  - the native OpenAI path must remain unchanged after membership quota recovers:
    route=undefined uses native passthrough and NamespaceToolCallTransform
    injectOnly=true, so the original encrypted handoff contract is preserved
  - ChatGPT session sharing is not required by the final routed-parent plaintext
    path; do not turn it on automatically during upgrade/recovery
  - temporary namespace-trace / handoff diagnostic logging is not a patch family
    to preserve once final E2E is accepted
  - relevant local files include src/namespace-relay.mjs, src/router.mjs,
    src/config-manager.mjs, src/multi-agent-state.mjs, src/catalog.mjs,
    src/control.mjs and focused namespace/routing/multi-agent tests
```

Also previously backported:

```text
f35ac504  Improve control center loading states
03b9d9f8  Fix partitioned control center refresh states
```

A previously reviewed upstream commit that was intentionally not applied:

```text
b7255f59  Make refresh ordering failure-safe
```

Never assume these exact commits or working-tree patches must be reapplied on
the next version. First inspect the target release and drop a local patch when
upstream now provides equivalent or better behavior.

For each local patch family:

```text
1. inspect new upstream implementation;
2. determine whether an equivalent fix exists;
3. if upstream already solves it, drop the local patch;
4. if upstream does not solve it, port only the minimum missing behavior;
5. run focused regression tests;
6. never cherry-pick blindly across a large version jump.
```

---

# 6. Pre-upgrade inventory

Before touching Git, collect a read-only inventory.

Run:

```powershell
cd "$env:LOCALAPPDATA\codex-router"

git status --short
git branch --show-current
git rev-parse HEAD
git log -5 --oneline --decorate
node -p "require('./package.json').version"
```

Record:

```text
current branch
current commit
current package version
tracked modifications
untracked files
existing rollback tags
```

Also inspect:

```powershell
.\model-router.ps1 codex providers
.\codex-router.ps1 tray status
node .\src\tray-service.mjs lifecycle
node .\src\service.mjs status
node .\src\config-manager.mjs status
node .\src\control.mjs failover status
Invoke-RestMethod http://127.0.0.1:4202/health
```

Record the Codex-managed integration separately:

```text
model_provider
openai_base_url present / absent
model_catalog_json present / absent
config_protected
merged-models.json path
current routed model count
current routed agent count
failover.enabled
failover.chain
provider cooldowns
Xkiro Opus 5 published context_window / auto_compact_token_limit if that route exists
```

For the current v0.5.1 Router design, `model_provider = "openai"` is normal.
Do not "repair" it to `codex-router` merely because third-party models are in
use. The Router-managed integration is represented by `openai_base_url` plus
`model_catalog_json`.

Before any Control Center mutation also inspect:

```text
apps/control-center/release/win-unpacked/
apps/control-center/release/.win-unpacked.previous-transaction
apps/control-center/release-recovery/
Control Center transaction journal
existing electron-builder / updater / tray-rebuild processes
```

A directory existing is not enough to call a package healthy. Verify both the
canonical executable and `resources/app.asar` before treating a package as a
valid rollback anchor.

Check ports:

```powershell
Get-NetTCPConnection `
  -LocalPort 4200,4201,4202,4203,4208 `
  -State Listen `
  -ErrorAction SilentlyContinue |
Select-Object LocalAddress,LocalPort,OwningProcess
```

Capture recent logs:

```powershell
Get-Content "$env:USERPROFILE\.codex\codex-router\router.log" -Tail 500
```

---

# 7. State that must be backed up

Back up at least:

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.codex\codex-router\install-manifest.json
%USERPROFILE%\.codex\codex-router\user-models.json
%USERPROFILE%\.codex\codex-router\model-picker.json
%USERPROFILE%\.codex\codex-router\multi-agent-settings.json
%USERPROFILE%\.codex\codex-router\failover.json if present
%USERPROFILE%\.codex\agents
Provider secret files
Router logs
generated litellm.yaml
apps/control-center/release-recovery/
Control Center package transaction journal if present
Control Center rollback package if present
Git diff
list of untracked files
Task Scheduler state
```

Do not expose secret contents while backing up or reporting.

Create:

```text
a timestamped backup directory
a rollback Git tag
```

Example tag naming:

```text
pre-vX.Y.Z-upgrade-YYYYMMDD-HHMMSS
```

If a stash already exists, keep it as an additional recovery artifact, but do not later `stash pop` it wholesale.

---

# 8. Select an exact upgrade target

Prefer:

```text
official release tag
or
exact release commit
```

Do not use a broad:

```text
git pull origin main
```

as the upgrade strategy.

Create a dedicated upgrade branch:

```text
upgrade-vX.Y.Z-YYYYMMDD-HHMMSS
```

Upgrade to the exact selected commit.

Do not mix unrelated newer upstream commits into the same change unless they are required to fix a proven regression.

---

# 9. Stage A — inspect new upstream before porting patches

Compare old and new structures.

At minimum inspect:

```text
src/service*.mjs
src/proxy-environment.mjs
src/start.mjs
src/config-manager.mjs
src/catalog.mjs
src/model-registry.mjs
src/model-discovery.mjs
src/curate-models.mjs
src/verify-model.mjs
src/chat-tool-surface.mjs
src/namespace-relay.mjs
src/compatibility-test.mjs
src/tray-service*.mjs
codex-router.ps1
model-router.ps1
apps/control-center
tests related to Windows/service/tray/renderer/model discovery/verification
```

Answer these questions before editing:

```text
Did upstream change service architecture?
Did upstream change Router ports?
Did upstream change proxy persistence?
Did upstream replace Control Center architecture?
Did upstream absorb any local Windows fix?
Did upstream change model-picker schema?
Did upstream change local user-model overlay or curation schema?
Did upstream add a native equivalent of verify-model?
Did upstream change Provider protocol-variant grouping?
Did upstream change Command Code Chat tool-name handling?
Did upstream change Control Center Models / Picker / Add Models behavior?
Did upstream add a native Control Center equivalent of the local Codex Native
Agent Mode Single / Team switch?
If so, does it remain independent from Router setSubagentMode and preserve the
user's current project mode?
Did upstream change Control Center package transaction or lifecycle identity checks?
Did upstream change multi-agent schema?
Did upstream change features.multi_agent_v2 map-form parsing or enabled semantics?
Did upstream change collaboration namespace/function wire identity?
Did upstream change encrypted_function_args / DirectPlaintextMessage handling?
Did upstream change Responses-to-Chat namespace preservation in LiteLLM or another
gateway layer?
Did upstream change generated agent definitions?
Did upstream change cross-model failover defaults, empty-chain semantics, cooldown
behavior, or compaction failover?
Did upstream add automatic model substitution that would violate explicit
operator consent?
Did upstream change Xkiro Opus 5 request serialization, provider payload limits,
or model auto-compaction metadata?
```

---

# 10. Stage B — validate Router backend before GUI work

Do not debug Control Center while the Router backend is still unproven.

Validate:

```text
Scheduled Task "Codex Router" is running
4200/4201/4202/4203/4208 are listening
/health returns HTTP 200
health.ok = true
health.version = target version
health.degraded = []
```

Restart Router through supported service management:

```powershell
node .\src\service.mjs restart
```

Prefer the unified service layer over manually stopping/starting Scheduled Tasks.

Run several restart cycles if the upgrade touched service lifecycle code.

After each cycle verify:

```text
no duplicate Router supervisor
no EADDRINUSE
no EACCES
no startup failed
no new fetch failed
no unexpected 502
```

Use only recent logs for acceptance. Historical log errors are not current failures.

---

# 11. Stage C — validate proxy persistence

Check manifest:

```powershell
Get-Content "$env:USERPROFILE\.codex\codex-router\install-manifest.json" |
Select-String "PROXY"
```

Check generated Windows launcher:

```powershell
Select-String `
  "$env:USERPROFILE\.codex\codex-router\start-codex-router.cmd" `
  -Pattern "NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|NO_PROXY"
```

Expected:

```text
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
```

If these survive reinstall/restart, do not apply historical proxy patches.

---

# 12. Stage D — Provider and model state preservation

Read-only verify that current Provider state survived the upgrade.

Do not delete/recreate Providers just because the UI changed.

Check:

```powershell
.\model-router.ps1 codex providers
node .\src\control.mjs providers
```

Preserve:

```text
enabled Provider selection
Provider keys
custom Provider definitions
user curated models
model-picker hidden/visible state
subagent settings
```

Remember:

```text
Provider enabled
≠
model visible in Picker
```

A Provider can be enabled while all its models are hidden.

## Local model discovery and verification workflow

Keep local model addition distinct from checked-in registry support.

For an already registered Provider, the preferred Windows operator flow is:

```text
Control Center
→ Models
→ Add Models
→ choose Provider
→ Fetch / Refresh model list
→ search the live Provider catalog
```

Interpret the actions as:

```text
Added
  already present locally

Add
  Router already has enough compatibility evidence to curate it directly

Verify & add
  Provider catalog advertises the model, but Router has not yet settled the
  compatible protocol/request profile for this machine/account
```

`Verify & add` is a quota-consuming action. It must be a deliberate operator
click; do not run it merely because the row is visible.

The CLI equivalent is:

```powershell
.\model-router.ps1 codex verify-model PROVIDER "MODEL_ID" --live --yes
```

To verify and apply in one operation:

```powershell
.\model-router.ps1 codex verify-model PROVIDER "MODEL_ID" --live --yes --apply
```

Expected verifier behavior:

```text
safe discovery first
→ confirm exact model id is currently advertised
→ return early if already registered
→ probe available protocol routes
→ basic response
→ streaming completion
→ forced tool call
→ if required tool_choice is refused, prove auto still calls the tool and
  record requestProfile=auto-tool-choice
→ optional reasoning=high when the route advertises reasoning
→ require exactly one compatible route unless the operator explicitly names one
→ --apply writes local user-models state
→ republish catalog/gateway
→ final routed compatibility test
→ exact rollback of user-models + model-picker snapshots if the final proof fails
```

Do not weaken Provider discovery DNS/SSRF checks to make verification work. Do
not treat a local verifier pass as checked-in registry certification or native
v2 subagent certification.

Protocol variants that share one Provider credential are still one Provider
family. For example, `commandcode` and `commandcode-messages` are not separate
accounts and must not be independently deleted or re-created.

## Curated display-name provenance

Provider identity belongs in the display metadata, not in the model slug.

For an untouched legacy default local name:

```text
MODEL_ID (curated)
```

the generated catalog may present:

```text
MODEL_ID (Command Code)
MODEL_ID (Xkiro API)
MODEL_ID (ClipProxy)
```

depending on the canonical Provider display name.

This presentation rule must not change:

```text
slug
upstream model id
Provider id
protocol
request profile
credential
routing destination
```

Official checked-in registry names remain authoritative. A user-custom display
name remains verbatim and must not be overwritten by this automatic provenance
rule.

---

## Cross-model failover and Xkiro payload-safety preservation

Treat failover state as operator intent, not as an optimization preference. After
an upgrade, inspect:

```powershell
node .\src\control.mjs failover status
```

Unless the pre-upgrade inventory recorded an explicitly authorized fallback
chain, the safe expected state is:

```text
enabled = false
chain = []
```

An upgrade must not turn on automatic ranking, infer a fallback from configured
Providers, or treat `chain=[]` as permission to choose a replacement model. If
the operator previously named a chain, preserve those exact slugs and do not
replace them with a newly ranked set.

For `xkiro/anthropic/claude-opus-5`, preserve the measured exact-route safety
behavior unless new upstream/provider evidence proves it obsolete:

```text
context_window = 1,000,000
auto_compact_token_limit = 230,000
serialized request safety limit = 1,150,000 bytes
```

This is a payload-size workaround, not a claim that Claude Opus 5 has only a
230K context window. Do not lower `context_window` to 230K/300K merely to make
the workaround look internally symmetric. Do not increase the 1.15 MB safety
limit toward the measured failure edge without a new live probe explicitly
authorized by the user.

If the payload limit is hit and no explicit fallback chain is authorized, the
correct behavior is an explicit local failure / context-length signal. Do not
secretly use another model to perform the compact operation.

---

# 13. Stage E — low-cost live request

Before GUI work, perform one minimal real request through a known cheap route.

Example:

```text
commandcode/deepseek-v4-flash
```

Prompt:

```text
TEST
```

Require:

```text
HTTP 200
valid response
no reconnect loop
no new Router 502
```

Once this passes, treat the backend as frozen while debugging Control Center unless new evidence proves the backend is involved.

---

# 14. Stage F — Control Center architecture

Use:

```text
apps/control-center
```

Do not restore:

```text
apps/desktop
old Tauri executable
old desktop patches
```

Control Center tests should be run before packaging.

Typical commands:

```powershell
cd apps\control-center
npm run check
npm test
npm run build
```

Then return to project root for:

```powershell
npm run check
```

Current Windows Models UX is intentionally implemented **only in Control
Center**, not in the Codex native UI:

```text
Control Center > Models

Picker
  → primary grouping by canonical Provider
  → models from protocol variants stay under the same Provider family
  → switches control Codex picker visibility

Add Models
  → select one Provider
  → Fetch / Refresh that Provider catalog
  → search
  → Add for directly curatable models
  → Verify & add for blocked/unsettled models
```

Do not patch Codex Desktop to add Provider tabs, Add buttons, or verification
controls. Codex consumes the final published catalog only.

When upgrading Control Center, preserve these boundaries even if the component
layout changes upstream.

---

# 15. Renderer locale regression

A Windows machine with Chinese locale can expose Chinese accessible names.

Do not “fix” this by breaking production localization.

If a Playwright test intentionally asserts English copy, set the browser test locale explicitly:

```text
locale: "en-US"
```

Do not replace translated production strings with English merely to satisfy the test.

---

# 16. Windows Integrity Level rule

The installed Control Center Tray should normally run as:

```text
current user
Interactive
RunLevel Limited
```

An elevated installer may run High Integrity while the GUI primary runs Medium Integrity.

Direct High → Medium Electron second-instance signaling can fail.

The safe pattern is:

```text
High installer
→ temporary current-user Scheduled Task
→ Interactive + Limited
→ exact canonical Control Center executable
→ Electron second-instance signal
→ existing Medium primary
```

Use this pattern for:

```text
graceful --quit-for-update
opening/showing the existing Control Center window
```

Do not replace it with force-kill.

---

# 17. Task Scheduler ACL comparison

Task Scheduler may reorder ACEs and set auto-inherited flags even when effective permissions are unchanged.

Do not compare security descriptors only as raw SDDL strings.

A safe comparison should preserve:

```text
Owner
Group
DACL revision
ACE count
ACE binary contents as a multiset
all meaningful ControlFlags
```

It may tolerate only known Task Scheduler canonicalization such as:

```text
ACE ordering
DiscretionaryAclAutoInherited
```

Do not weaken ACL verification beyond those specific canonicalization differences.

---

# 18. Packaging rule: never overwrite a running win-unpacked package

A live Windows Electron process holds:

```text
Codex Router.exe
```

open.

Do not directly run:

```text
electron-builder --win dir
```

over the canonical package while the Tray primary is running.

This can leave:

```text
release\win-unpacked
```

partially moved or partially rebuilt.

Use the official tray transaction:

```powershell
.\codex-router.ps1 tray rebuild
```

which should:

```text
gracefully stop/drain
→ build staged package
→ install/register
→ commit replacement
→ restart
→ reopen window
```

If an interrupted replacement leaves a transaction journal, inspect/recover
it before launching another mutating tray operation.

Do not run multiple concurrent tray install/rebuild commands.

If `tray rebuild` returns a connector or transport 502, assume the command may
still be running until proven otherwise. Inspect the original rebuild PID,
electron-builder/npm child processes, journal phase, task state, and package
layout. Never "retry just in case".

`apps/control-center/release-recovery/` is a recovery anchor. In particular, a
previous interrupted Windows replacement can leave a split state such as:

```text
release\win-unpacked
  app.asar exists
  Codex Router.exe missing

release\.win-unpacked.previous-transaction
  Codex Router.exe exists
  app.asar missing
```

Do not call either half a valid package. Preserve both halves and any
`split-package-*` archive. A complete recovery package must contain at least the
canonical executable and `resources/app.asar` and must pass the package
completeness checks before it is used.

## Windows lifecycle PID-reuse race

A lifecycle file can outlive the Electron process. Windows may immediately reuse
the old PID for PowerShell, Node, or another process. Therefore:

```text
PID exists
≠
Control Center is still running
```

Lifecycle / update code must bind a live PID to the expected Control Center
executable or equivalent exact process identity before treating it as the old
primary.

A stale PID may be ignored only when the surrounding safety evidence also says
the old Control Center is gone, for example:

```text
Scheduled Task is not running
and
no exact Control Center executable process exists
and
the lifecycle PID belongs to a different executable
```

Do not turn this into a generic "ignore PID mismatch" rule. If the Task is
running, Task state is unreadable, or an exact Control Center process exists,
continue to fail closed.

Never weaken the no-force-kill rule to solve PID reuse.

---

# 19. Control Center acceptance

After installation:

```powershell
.\codex-router.ps1 tray status
node .\src\tray-service.mjs lifecycle
```

Expected:

```text
installed = true
canonical = true
state = running
running = true
ready = true
visible = true
```

Verify:

```text
exactly one primary --tray-only process
primary executable is the canonical Control Center executable
no persistent temporary Limited helper tasks
no leftover transaction journal
no leftover orphan rollback package in the active release directory
no duplicate primary
no persistent cmd/powershell helper children
release-recovery remains available until the new package has been accepted
```

Closing the window may keep the Tray process alive.

Stopping Tray must not stop the Router backend.

---

# 20. Interface scale local patch

The current local installation adds a renderer-only preference:

```text
90%
100% default
110%
120%
130%
```

Storage key:

```text
codex-router-ui-scale
```

Current machine preference at skill creation:

```text
120%
```

When upgrading:

```text
If upstream now has native zoom/scale settings:
    migrate or drop this patch.
Else:
    port the minimal renderer-only preference.
```

Do not convert this into Router server state.

---

# 20A. Control Center Codex Native Agent Mode local patch

The current local installation adds a project-scoped Control Center setting for:

```text
Single (default)
Sol + Luna Team
```

It manages:

```text
F:\程序\office-leasing-ai\.codex\config.single.toml
F:\程序\office-leasing-ai\.codex\config.team.toml
F:\程序\office-leasing-ai\.codex\config.toml
F:\程序\office-leasing-ai\.codex\agent-mode.txt
```

The IPC names are intentionally distinct from Router subagent policy:

```text
getCodexAgentMode / setCodexAgentMode
    !=
setSubagentMode / setSubagentModel / setSubagentEffort
```

Single must yield:

```text
agents.enabled = false
multi_agent_v2.enabled = false
```

Team must yield:

```text
agents.enabled = true
multi_agent_v2.enabled = true
default_subagent_model = gpt-5.6-luna
```

Team is capability enablement only. The project remains default single-agent and
must require an explicit `$sol-luna-orchestrator` invocation or an explicit user
request for a Sol + Luna team before children are spawned.

Upgrade rule:

```text
If upstream now provides an equivalent or better native project Agent Mode UI:
    migrate/drop this local implementation only after behavior is proven equal.
Else:
    port only the minimal five-surface Control Center behavior.
```

Do not let the renderer provide arbitrary paths and do not rebuild TOML inside
Electron; the verified project templates remain the source of truth. Preserve
the user's actual pre-upgrade mode. Full details and the 2026-09-07 verification
record are in:

```text
docs/LOCAL-PATCH-CONTROL-CENTER-CODEX-AGENT-MODE-2026-09-07.md
```

---

# 21. Publish catalog and routed agents

After model/provider state is confirmed, republish using the supported catalog path.

Current v0.5.1 example:

```powershell
node .\src\catalog.mjs
```

Do not assume this command name remains unchanged in a future version; inspect the release.

Verify generated agents under:

```text
%USERPROFILE%\.codex\agents
```

Important distinction:

```text
"v2-agent applications valid (N)"
```

counts certification/proof application directories, not necessarily current routed agent definitions.

Do not cross-certify the same model name across different Providers.

After catalog publication, verify the Codex-managed root fields:

```powershell
node .\src\config-manager.mjs status
```

For the current v0.5.1 Router design the healthy state normally includes:

```text
mode = router
model_provider = openai
openai_base_url = local Router caller URL
model_catalog_json = %USERPROFILE%\.codex\codex-router\merged-models.json
```

`model_provider = openai` is not evidence that the Router is bypassed. The
managed `openai_base_url` redirects the OpenAI-compatible surface to the local
Router.

If **all** third-party models disappear from Codex at once, first check these
managed fields before re-adding any Provider or model. A common failure shape is:

```text
user-models.json still contains third-party entries
merged-models.json still contains third-party entries
model-picker.json still preserves visibility
but
openai_base_url and/or model_catalog_json disappeared from config.toml
```

In that case restore the Router-managed config with the supported config manager
and republish the catalog. Do not delete/recreate Providers and do not re-run
quota-consuming model verification.

---

# 22. Dual Codex CLI warning

A machine may contain both:

```text
ChatGPT Desktop bundled Codex
npm/PATH Codex CLI
```

A doctor check may probe both.

If the old PATH CLI rejects a newer config schema:

```text
do not remove new Router config features merely to satisfy the old CLI
```

First identify which Codex binary the actual user workflow uses.

If terminal Codex also needs to work, separately upgrade/remove the obsolete PATH CLI.

---

# 23. Final Router validation

Require:

```text
Router Task running
all expected ports listening
health HTTP 200
ok=true
target version correct
degraded=[]
```

Recent logs should contain no new:

```text
502
fetch failed
EADDRINUSE
EACCES
startup failed
```

Provider/model counts should match the pre-upgrade intent.

Also verify model-identity safety:

```text
failover status matches the pre-upgrade operator setting
empty failover chain never authorizes automatic model selection
no quota/cooldown/payload path can silently substitute another model
compaction cannot move to another model without an explicitly named authorized chain
```

If `xkiro/anthropic/claude-opus-5` is installed, verify the published catalog and
route policy still show:

```text
context_window = 1,000,000
auto_compact_token_limit = 230,000
payload safety limit = 1,150,000 bytes
```

Do not spend provider quota to re-probe the 1.19 MB boundary during routine
upgrade acceptance. Re-run that live boundary experiment only when a relevant
upstream/provider change gives a reason and the user explicitly approves it.

---

# 24. Final Control Center validation

Validate these surfaces:

```text
Dashboard
Usage
Status
Models
Local
Harness
Context Manager
Settings
```

Confirm:

```text
Provider rows load
Model catalog loads
Picker groups models by canonical Provider
protocol variants do not appear as duplicate account/provider groups
Picker controls work
Add Models can Fetch / Refresh one Provider catalog
Add Models distinguishes Added / Add / Verify & add
Verify & add is not triggered merely by opening or refreshing the page
Subagent controls reflect current state
Codex Agent Mode reads the project mode without reusing Router subagent state
Single / Team writes copy the verified project templates and preserve the user choice
Team does not itself auto-trigger Sol + Luna orchestration
Usage page loads
Settings page loads
language selection persists
interface scale persists if local patch retained
tray reopen works
```

Automated renderer tests are acceptable evidence for most UI behavior, but do not claim live UIAutomation inspection if the test/automation session is not in the same interactive Windows session as the user GUI.

---

# 25. Final Codex Desktop acceptance

Completely quit and reopen ChatGPT / Codex Desktop.

Verify:

```text
Model Picker loads
expected native OpenAI models visible
expected third-party routes visible
hidden routes remain hidden
curated default names identify their Provider instead of only saying "(curated)"
official registry display names remain unchanged
user-custom display names remain unchanged
```

Before blaming the catalog for a native-only Picker, confirm:

```powershell
node .\src\config-manager.mjs status
```

and require the expected managed `openai_base_url` and `model_catalog_json`.

Completely quitting and reopening Codex is required when validating a newly
published model catalog; an already-open window may retain the previous picker
snapshot.

Run:

```text
commandcode/deepseek-v4-flash
```

with:

```text
TEST
```

Require:

```text
successful response
no Reconnecting loop
no Router 502
```

Then, if multi-agent behavior changed in the upgrade and the user explicitly
approves quota-consuming E2E calls, validate the **two-path subagent matrix**:

```text
A. Routed third-party parent -> routed third-party child

Example verified pair:
xkiro/anthropic/claude-opus-5
  -> collaboration.spawn_agent
  -> commandcode/deepseek-v4-flash

Require:
- Desktop receives name=spawn_agent + namespace=collaboration
- parent delegation is literal plaintext for the routed provider
- completed native call carries encrypted_function_args=[]
- child reaches the intended routed model
- child provider requests return HTTP 200 and can execute tools
- no Native collaboration payload relay HTTP 401/429
- no Router 502
- the main thread does not silently perform the delegated task

B. Native OpenAI parent -> native subagent, when membership quota is available

Require:
- native collaboration schema/handoff remains encrypted/native
- no routed plaintext rewrite is applied to the native response stream
- NamespaceToolCallTransform runs injectOnly=true on the native path
- native subagent behavior remains the normal Codex behavior
```

If native quota is unavailable during the upgrade, do not fake test B with a
third-party alias. Record it as deferred until quota recovers; the static/focused
regression must still prove native inject-only isolation.

When reading Router logs for the acceptance turn, the served model must match the
model selected in Codex unless the operator deliberately enabled failover and
named the exact fallback slug before the test. A successful answer from an
unapproved replacement model is an acceptance failure, not a recovery success.

---

# 26. Rollback policy

Rollback must restore:

```text
code
Router-managed config
service registration
Control Center package
Control Center transaction/recovery artifacts
provider/model state
```

without deleting unrelated user data.

Prefer:

```text
timestamped backup
rollback Git tag
targeted file restoration
```

Do not use destructive worktree cleanup as a rollback substitute.

If rollback needs a local patch, apply only the specific patch or commit proven necessary.

---

# 27. Completion report format

At the end of an upgrade, report:

```text
Old version / commit
New version / commit
Upgrade branch
Rollback tag
Backup location

Router:
- service state
- health
- ports
- recent log errors

Providers / models:
- enabled Providers
- credentials preserved
- curated models preserved
- picker state preserved
- verify-model workflow retained or upstream-equivalent
- curated Provider display provenance retained
- model catalog counts before / after
- failover enabled/disabled state and explicitly authorized chain
- confirmation that empty-chain automatic model substitution is disabled
- Xkiro Opus 5 payload/autoCompact workaround retained, dropped as upstream-equivalent, or not applicable

Subagents:
- routed agent count
- Desktop version and actual bundled Codex runtime tested
- effective multi_agent / multi_agent_v2 feature state
- parentEnabled / child-enabled intent preserved
- routed-parent -> routed-child E2E result
- plaintext DirectPlaintextMessage marker result (encrypted_function_args=[])
- confirmation that routed child did not require native decrypt relay
- native OpenAI subagent isolation / quota-recovered result, or explicitly deferred
- certification notes

Control Center:
- build/test results
- Picker Provider grouping
- Add Models Fetch/Add/Verify & add behavior
- tray status
- lifecycle running/ready/visible
- exact primary executable identity
- temporary tasks/journal/orphan cleanup
- release-recovery disposition

Patches:
- old patches retired
- local patches retained
- local patches dropped because upstream absorbed them
- new patches added

Codex:
- actual Codex binary/version tested
- managed openai_base_url present
- managed model_catalog_json present
- model_provider value and why it is correct for this release
- third-party Picker visibility
- final TEST result

Remaining known issues
```

---

# 28. Current known v0.5.1 reference state

This section is a reference only. Re-read the live machine on every future
upgrade. It describes the verified 2026-09-05 installation and is not permission
to assume the next release has identical internals.

Known committed local chain:

```text
97ec9a7  official v0.5.1 base
d2ef9fe  renderer locale fix
2661b26  Windows tray recovery + ACL fix
9418d68  Limited-token Control Center open
040244b  persisted interface scale
dd24804  Skill profile controls
501b5fe  Codex mode controls visible in Control Center
81cb030  tolerate account-usage timeouts
```

Known working-tree patch families at this snapshot:

```text
verify-model + CLI/UI integration
Command Code >64-character tool-name aliasing
Control Center Provider-first Picker
Control Center Provider-scoped Add Models
Blocked model Verify & add
curated default display name → Provider display name
Windows Control Center PID-reuse lifecycle fix
Xkiro Opus 5 payload-aware context protection
explicit-consent-only cross-model failover
Codex Desktop MultiAgent V2 namespace + routed plaintext handoff compatibility
2 MiB bounded namespace SSE prelude support
native OpenAI subagent inject-only isolation
associated focused regression tests
```

Known current Router-mode config shape:

```text
model_provider = openai
openai_base_url = local Router caller URL
model_catalog_json = %USERPROFILE%\.codex\codex-router\merged-models.json
```

Known catalog snapshot observed during this work:

```text
69 total published models
56 routed third-party models
5 routed agents
```

Counts are acceptance hints only. Always compare them to the live pre-upgrade
inventory instead of hard-coding them as future requirements.

Known Control Center model-management shape:

```text
Models > Picker
  → grouped by canonical Provider

Models > Add Models
  → select Provider
  → Fetch / Refresh
  → Add
  → Verify & add when compatibility is not yet settled
```

Known 2026-09-05 cross-model failover policy:

```text
default failover = disabled
empty chain = no authorization to select another model
cross-model failover requires enabled=true AND explicitly named chain entries
ordinary turns and compaction share the same consent boundary
prefer explicit failure over silent model substitution
```

Known 2026-09-05 Xkiro Claude Opus 5 safety state:

```text
route = xkiro/anthropic/claude-opus-5
context_window = 1,000,000
auto_compact_token_limit = 230,000
serialized request safety limit = 1,150,000 bytes
measured provider failure edge ≈ 1.19 MB on both OpenAI-compatible and Anthropic Messages paths
350,537 input tokens at about 700 KB succeeded, disproving a simple 300K token ceiling
```

The exact payload workaround is route-scoped evidence, not a provider-wide rule.
A future upgrade may remove it only after the target release or a new authorized
live probe demonstrates equivalent or better protection.

Known old patches not applied:

```text
windows-router-proxy-fix.patch
windows-service-orphan-fix.patch
old Tauri GUI patch
```

Known proxy model:

```text
install-manifest.json
→ serviceProxyEnvironment()
→ generated Windows launcher
→ NODE_USE_ENV_PROXY=1
→ EnvHttpProxyAgent
```

Known Windows Control Center recovery rule:

```text
official tray transaction
→ preserve release-recovery
→ never build over a running canonical win-unpacked
→ do not parallelize rebuilds
→ treat connector 502 as unknown completion until the original process/journal is inspected
→ validate exact process identity, not PID existence alone
```

Known third-party Picker disappearance rule:

```text
if every third-party model disappears at once
→ inspect config-manager status first
→ confirm openai_base_url
→ confirm model_catalog_json
→ confirm merged-models.json still contains routes
→ restore managed config / republish if needed
→ do NOT recreate Providers or re-verify models unless evidence says their state was lost
```

This reference is not permission to assume future releases behave the same.
Always inspect the target release first.


---

# 29. 2026-09-05 late MultiAgent V2 repair — failure ladder and preservation rules

This section records the actual Desktop investigation that finally made a
third-party Parent launch and run a third-party child. It exists so a future
Router upgrade does not preserve only the final code while forgetting *why*
each boundary is necessary.

## 29.1 Verified runtime topology

The user workflow was **Codex Desktop**, not the PATH/npm CLI.

Verified during this incident:

```text
Codex Desktop UI        = 26.901.41600
Windows package         = OpenAI.Codex_26.901.5280.0_x64__2p2nqsd0c76g0
Desktop bundled runtime = codex.exe 0.153.4
```

The PATH npm CLI observed during the same work was older and was not the runtime
serving Desktop. Future diagnostics must identify the executable Desktop
actually launched before interpreting feature flags.

## 29.2 Failure ladder: what each symptom proved

The repair succeeded by treating each changed failure mode as evidence:

```text
1. unsupported call: collaboration__spawn_agent
   -> child not created
   -> namespace / Desktop dispatch boundary still broken

2. child created, then Native collaboration payload relay HTTP 401
   -> namespace repair worked
   -> child handoff reached the encrypted-content compatibility layer
   -> native credential sharing was unavailable

3. after explicit session-sharing authorization: 401 -> 429
   -> authorization worked
   -> the design still depended on native ChatGPT/Codex quota
   -> therefore native decrypt relay could not be the final third-party path

4. parent cache trace: message=native-token, child=miss
   -> final spawn_agent.message was already gAAAAA ciphertext
   -> caching plaintext from the completed call could not be the primary design

5. final successful turn:
   parent spawn message=plaintext
   encrypted_function_args=[]
   child commandcode/deepseek-v4-flash -> repeated HTTP 200
   vision bridge -> described=1 / failed=0
   -> the official DirectPlaintextMessage path was actually executing work
```

Do not collapse these into one generic "502" diagnosis. The status transition is
part of the evidence.

## 29.3 MultiAgent V2 feature gate

The map form of `features.multi_agent_v2` is an independent feature value.

Broken shape observed:

```toml
multi_agent_v2 = {
  max_concurrent_threads_per_session = 6,
  usage_hint_enabled = true
}
```

It can still report:

```text
multi_agent_v2  false
```

The managed form must include:

```toml
multi_agent_v2 = {
  enabled = true,
  max_concurrent_threads_per_session = 6,
  ...
}
```

The Router's probe must inspect the **effective** feature list, not merely accept
that the TOML parses.

Parent and child eligibility must remain separate:

```text
Parent On
  -> model may orchestrate

Child On
  -> model may be dispatched

Parent On
  != automatically add the same model to the child pool
```

## 29.4 Namespace restoration and the 256 KiB false lead

Codex Desktop's executor expects the native identity:

```json
{
  "type": "function_call",
  "name": "spawn_agent",
  "namespace": "collaboration"
}
```

Chat-compatible bridges can expose the provider-facing name as:

```text
collaboration__spawn_agent
```

That is acceptable only while it is outside Codex. Before the response returns
to Desktop, Router must restore the request-local native identity.

The compatibility layer must recognize the observed request definitions:

```text
type=namespace + tools[]
type=function + namespace=collaboration
already-flat collaboration__spawn_agent / list_agents / wait_agent / interrupt_agent
```

Never restore arbitrary `foo__bar` by splitting on `__`; literal user/MCP tool
names can contain that delimiter. Restore only identities proven by the current
tool inventory / known Codex built-ins.

A second bug made correct namespace code appear ineffective. The original
single-frame SSE budget was:

```text
256 KiB
```

LiteLLM's Responses<-Chat bridge can echo the full `instructions + tools`
catalog in `response.created` / `response.in_progress`. With Desktop Apps,
Computer Use, collaboration, Node, and MCP tools, that valid first frame can
exceed 256 KiB. The old transform disabled namespace rewriting before the
later spawn call arrived.

Offline reproduction used a >300 KiB prelude:

```text
before:
leaked=true
restored=false

after bounded increase to 2 MiB:
leaked=false
restored=true
```

Keep the finite 2 MiB pre-commit budget and all oversized/ambiguous/invalid-UTF8
fail-safe tests. Do not turn it into an unlimited buffer.

## 29.5 Why native decrypt relay and parent-cache are not the final design

Codex MultiAgent V2 native history legitimately stores collaboration messages as
opaque `gAAAAA...` ciphertext.

Attempting to make a routed child readable by calling native OpenAI `/responses`
as a decrypt/transport relay produced:

```text
session sharing disabled -> HTTP 401
session sharing explicitly enabled -> HTTP 429 when native quota exhausted
```

That proves this path is unsuitable as the primary solution for the exact
scenario where a user needs third-party subagents because native membership
quota is exhausted.

A bounded local parent-task cache was also tested. It is safe as a fallback, but
the completed parent `spawn_agent.message` in real Desktop history was already a
native ciphertext token, so the Router had no plaintext to cache at that point.
Do not redesign the upgrade around that cache.

## 29.6 Final third-party solution: Codex DirectPlaintextMessage

For routed third-party parents only, use the Codex-supported plaintext delivery
contract.

Provider-facing tool copy:

```text
collaboration.spawn_agent
collaboration.send_message
collaboration.followup_task

message.encrypted=true
  -> remove only from the provider-facing copy
```

Never mutate the original client/native tool schema.

Provider-facing history:

```text
historical message = gAAAAA...
  -> replace only that routed replay field with a non-secret placeholder
  -> preserve task_name, agent_type, fork_turns, model/target metadata
  -> instruct the routed parent to write the current delegation as literal plaintext
```

Response path:

```text
routed parent returns a genuine plaintext message
  -> restore {name, namespace}
  -> add encrypted_function_args=[]
  -> Codex selects DirectPlaintextMessage
  -> child receives ordinary input_text
  -> no native decrypt request is required
```

Fail-safe:

```text
message still looks like gAAAAA ciphertext
  -> NEVER add encrypted_function_args=[]
  -> do not pretend ciphertext is plaintext
```

## 29.7 Real E2E success evidence

The successful live Desktop task was:

```text
parent = xkiro/anthropic/claude-opus-5
child role = router_commandcode_deepseek_v4_flash
child route = commandcode/deepseek-v4-flash
task = /root/ai1_pdf_filename_retry_4
```

The parent rollout contained:

```text
name = spawn_agent
namespace = collaboration
message = literal AI 1 task text
encrypted_function_args = []
```

Desktop created the child, and Router then recorded repeated:

```text
model=commandcode/deepseek-v4-flash
provider=commandcode
status=200
```

The child also exercised the image/PDF path:

```text
vision-bridge
engine=commandcode/deepseek/deepseek-v4-flash-vision-exp
images=1
described=1
failed=0
```

This is the acceptance threshold. "Child created" alone is insufficient.

## 29.8 Membership quota recovery must not break native subagents

The routed plaintext repair is not permission to change the native OpenAI
collaboration protocol.

When membership quota is available and the selected Parent is a genuine OpenAI
model:

```text
route = undefined
-> native OpenAI passthrough
-> original native encrypted collaboration schema/handoff
-> NamespaceToolCallTransform injectOnly=true
-> no routed namespace/plaintext rewrite
```

Therefore, after quota recovery:

```powershell
node .\src\control.mjs auth-mode off
```

should restore the normal Hybrid operating state without removing this patch.

Expected long-term matrix:

```text
Native OpenAI Parent
  -> native encrypted subagent path
  -> unchanged Codex behavior

Routed third-party Parent
  -> DirectPlaintextMessage
  -> routed DeepSeek/Luna/Kimi/GLM child as configured
  -> independent of native GPT quota
```

Do not alias a GPT/native Picker entry to a third-party model to make either
test pass.

## 29.9 Upgrade-time regression commands and E2E acceptance

At minimum after porting or deciding upstream absorbed this patch family:

```powershell
node --test test/namespace-relay.test.mjs
npm run check
git diff --check
```

Also run the focused routing/multi-agent tests present in the target release,
especially tests covering:

```text
- collaboration namespace round-trip
- already-flat collaboration built-ins
- explicit function namespace shape
- >256 KiB / large LiteLLM SSE prelude
- plaintext marker on completed streamed calls
- ciphertext never mislabeled as plaintext
- native inject-only isolation
- encrypted child fail-closed behavior when no legal relay/plaintext exists
```

For a live Desktop test, explicit user approval is still required because it
spends provider quota. Verify not just startup but actual child work.

## 29.10 Temporary diagnostics are not preservation targets

During this incident the Router temporarily logged items such as:

```text
namespace-trace request
namespace-trace transport
namespace-trace raw
namespace-trace response
namespace-trace sse-disabled
subagent-handoff-cache ...
```

These were used to isolate the failure. They are not part of the semantic
compatibility contract. Once the live E2E is accepted and equivalent permanent
telemetry exists, do not blindly port these verbose traces to a future release.

The semantic behaviors that **must** survive are:

```text
effective multi_agent_v2 enabled state
parent/child eligibility separation
request-local namespace restore
bounded large-SSE prelude support
DirectPlaintextMessage for routed parents
ciphertext fail-safe
native OpenAI inject-only isolation
no hidden model substitution
```

## 29.11 Preserve Command Code request-level usage accounting

A 2026-09-06 local patch adds per-model Command Code spend attribution without
pretending the provider exposes historical model-level billing. Treat it as a
separate upgrade family.

The contract is:

```text
provider account API
  -> authoritative total balance / plan usage / 5h / weekly windows

Router usage ledger
  -> request-local model attribution
  -> fresh input / cache read / cache write / output
  -> rate snapshot at request time
  -> usage-value USD + GOAT credit equivalent

Control Center
  -> shows both layers together
  -> shows Unattributed rather than forcing reconciliation
```

Key files currently include:

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
test/commandcode-billing.test.mjs
```

The current pricing snapshot is versioned `goat-2026-09-06` and points to the
Command Code GOAT/Pricing documentation. **Do not blindly port those numeric
rates into a later release.** Before KEEP/PORT, re-read the official current
pricing table and compare:

```text
input / output / cache-read / cache-write rates
per-model GOAT monthly allowance
DeepSeek peak/off-peak UTC windows
plan monthly / 5-hour / weekly caps
```

If upstream values changed, update the pricing version and tests. The preserved
behavior is request-time price snapshotting, not stale prices.

Fail-honest rules are mandatory:

```text
- never price an estimated prompt token count as provider-reported fact
- missing cache-write usage on a priced cache-write model => incomplete
- unknown/unpriced model => unpriced, never guessed
- pre-tracking/history gaps => Unattributed, never assigned to a convenient model
- official account total remains authoritative over local reconstruction
```

For current-day legacy rows, a narrow retrospective reconstruction may be kept
only when explicitly labeled retrospective. Do not silently expand that cutoff
to old history during upgrades.

Regression gate for this family:

```text
node --test test/commandcode-billing.test.mjs \
  test/commandcode-stream.test.mjs \
  test/response-usage.test.mjs \
  test/provider-account-usage.test.mjs \
  test/provider-usage.test.mjs \
  test/usage-events.test.mjs
npm --prefix apps/control-center run check
npm --prefix apps/control-center test
npm run check
git diff --check
```

A real account-read validation is allowed without inference spend: verify that
`provider-usage` exposes the provider-reported Command Code plan totals beside
`commandCodeSpend`. Do not run a billed model probe merely to create a new
ledger row unless the operator explicitly approves quota consumption.

---

## 2026-09-05 revision notes

This revision records four upgrade-critical local behaviors established after
the 2026-09-04 snapshot:

1. **Xkiro Claude Opus 5 payload-aware protection** — keep the 1M advertised
   context, compact conservatively at 230K, and block the exact route locally at
   a 1.15 MB serialized-request safety limit because live probes reproduced a
   provider failure around 1.19 MB on both supported API protocol surfaces.
2. **Explicit-consent-only cross-model failover** — the Router must never turn
   model choice into a blind box. Cross-model recovery, including compaction, is
   permitted only after the operator explicitly enables failover and names the
   exact fallback model slug(s).
3. **Codex Desktop MultiAgent V2 namespace/SSE compatibility** — preserve the
   effective `multi_agent_v2.enabled=true` gate, exact collaboration namespace
   identity, and the bounded 2 MiB initial SSE frame budget required for large
   LiteLLM response preludes.
4. **Routed-parent DirectPlaintextMessage handoff** — third-party Parents receive
   a provider-facing plaintext collaboration schema/history and return completed
   calls with `encrypted_function_args=[]`; native OpenAI Parents remain on the
   untouched encrypted/inject-only path so membership quota recovery does not
   regress normal Codex subagents.

These are working-tree patch families as of this snapshot and must be compared
against upstream behavior on every future upgrade rather than blindly restored
or silently dropped.
