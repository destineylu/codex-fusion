# Codex Fusion — Reproducible v1

This document defines the install and upgrade contract for the enhanced
`destineylu/codex-fusion` distribution. **Codex Fusion** is the product/distribution name; **Codex Router** remains the internal routing core and keeps its established v1 compatibility identifiers.

The goal is not to freeze upstream forever. The goal is to keep production on a
known-good distribution while making upstream adoption deliberate, reviewable,
and reversible. Upstream authorship is preserved: Codex Fusion is an integration
distribution, not a claim of original authorship over Codex Router,
`codex-chatgpt-web`, `codex-auto-resume`, or the other projects acknowledged in
[`NOTICE.md`](../NOTICE.md).

## 1. Source ownership

End-user installs use:

```text
origin   https://github.com/destineylu/codex-fusion.git
branch   main
```

The original Router remains a **reference upstream**:

```text
upstream https://github.com/duolahypercho/codex-router.git
branch   main
```

The installers add `upstream` when it is absent. They never merge it
automatically. Normal `update` operations fetch and fast-forward only the
Destiney distribution branch.

Advanced or test installs can override either source without editing files:

```text
CODEX_ROUTER_REPOSITORY_URL
CODEX_ROUTER_UPDATE_BRANCH
```

Running the Destiney installer over a recognized upstream checkout migrates
`origin` to the Codex Fusion distribution and preserves the original Router repository
as `upstream`. Existing checkouts that still carry the former `destineylu/codex-router`
remote are recognized as a legacy Destiney distribution name and may migrate safely.

The GitHub rename does **not** rename v1 runtime plumbing. Existing install directories,
script names, provider IDs, service/task names, and sidecar paths containing
`codex-router` remain valid by design.

## 2. What v1 reproduces

A clean source install provides the Router, the Electron Control Center and the
checked-in local extensions. Provider credentials and personal application
sessions are intentionally not stored in Git.

The following integrations are shipped as guarded optional components:

### Native ChatGPT account profiles

Windows Codex Desktop installs with the Electron Control Center include the
checked-in native-account profile manager. The feature is local-only and never
ships another operator's credentials or browser state.

- profiles live under the current user's Codex Router state, not in Git;
- adding an account invokes the official Codex OAuth flow inside an isolated
  `CODEX_HOME`;
- an incognito/alternate-account browser can return a complete localhost
  callback URL to Control Center when automatic loopback navigation fails;
- callback relay accepts only the expected loopback host/path/port and matching
  OAuth state, and the official Codex process still performs the token exchange;
- official `codex login --device-auth` remains available as a fallback;
- switching requires Codex Desktop to be closed, synchronizes refreshed auth,
  writes a rollback copy, atomically replaces live `auth.json`, and verifies
  the target identity;
- switching does not restart Router, does not rewrite `config.toml` or model
  catalogs, and does not modify ChatGPT Web or third-party provider state;
- automatic account rotation, quota-triggered switching, and account fallback
  are intentionally not part of reproducible v1.

Windows Desktop detection is executable-path-aware because Codex Desktop, npm
Codex CLI/app-server, and AppX resource CLIs may all present as `Codex.exe`.
Only recognized Desktop install roots block an account switch.

### ChatGPT Web

- upstream: `miuuyy/codex-chatgpt-web`
- audited version: `5.0.8`
- the Windows installer is accepted only when its checked-in SHA-256 matches;
- the known v5.0.8 preflight timeout defect is patched only when the original
  `app.asar` SHA-256 matches the audited build;
- the patched `app.asar` must match the checked-in patched SHA-256;
- any unknown launcher build is refused instead of being modified;
- the launcher uses an isolated `CODEX_HOME`; the real Codex route must remain
  owned by Codex Router;
- ChatGPT login, Developer Mode, Connector/Tunnel identity and runtime keys are
  per-user state and are never copied from another installation.

A newer upstream ChatGPT Web release is **not** installed automatically.
Maintainers must review it, update the audited version/hash set, determine
whether the v5.0.8 preflight patch is still needed, and rerun the ChatGPT Web
acceptance gate before publishing it.

### Codex Auto Resume

- upstream: `feifeigong/codex-auto-resume`
- install uses the checked-in audited commit, not a floating branch;
- weekly reset-credit auto-redeem is forced off during install/autostart setup;
- Control Center adds a native-account guard without vendoring or modifying the audited upstream Python source;
- each managed Native ChatGPT account uses an independent Auto Resume `state_dir`, keyed by the irreversible account identity fingerprint;
- quota snapshots, handled marks, resume counts and tracked-thread state must not be shared across Native ChatGPT accounts;
- every tracked thread is bound to an `accountFingerprint`; a thread bound to another account or a legacy thread whose account cannot be proven is fail-closed and cannot auto-resume;
- a single unmanaged native login may use the irreversible fingerprint from live `auth.json` as its scope without creating a saved Profile, but legacy thread ownership is still never guessed;
- switching Native ChatGPT accounts pauses the watcher, commits the auth switch, selects the target account state, then restores the previous watcher/autostart state; Router is not restarted;
- automatic account rotation remains intentionally unsupported: account switching is still an explicit user action;
- a new upstream commit is review-only until the audited commit is updated and the account-scope integration is revalidated.

### Single / Team Agent Mode

The distribution contains the Control Center integration, but no personal
project path is embedded. To expose the project-scoped switch, launch Control
Center with:

```text
CODEX_ROUTER_AGENT_MODE_PROJECT_ROOT=<project containing .codex templates>
```

Without that variable the feature reports itself unavailable instead of
guessing a local path.

### ComfyUI

The Codex ComfyUI port remains a separate optional repository. Router v1 does
not ship another operator's local/remote ComfyUI hosts, Tailscale addresses or
firewall policy. Those are installation-specific settings.

## 3. Clean installation

### Windows

```powershell
$installer = Join-Path $env:TEMP "codex-router-install.ps1"
Invoke-WebRequest https://raw.githubusercontent.com/destineylu/codex-fusion/main/install.ps1 -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -Target codex -Guided -WithTray
```

### macOS / Linux

```sh
curl -fsSL https://raw.githubusercontent.com/destineylu/codex-fusion/main/install.sh \
  | sh -s -- --target codex --guided --with-tray
```

The installer must leave the managed checkout on `origin/main` and add the
reference Router repository as `upstream`.

Optional sidecars are then installed from Control Center. Their credentials,
sessions and personal endpoints are configured by the new user.

## 4. End-user update path

Production users update from the Destiney distribution only:

```text
Control Center / router update
  -> fetch origin/main
  -> fast-forward only
  -> reinstall generated/runtime layers
  -> rollback reference recorded before mutation
```

A dirty tracked checkout is refused unless the operator explicitly chooses the
existing force path. Untracked work is never deleted.

This is intentionally separate from upstream adoption.

## 5. Maintainer upstream review

Run the read-only status command:

```sh
npm run upstream:status
```

or:

```sh
node scripts/upstream-status.mjs --json
```

It reports:

- current local Router revision and remotes;
- the latest reference Router `main` commit;
- the current audited ChatGPT Web version and latest upstream release;
- the current audited Auto Resume commit and latest upstream `main` commit.

It does not merge, install or update anything.

### Router upstream adoption

1. Fetch `upstream/main`.
2. Review the delta in an isolated branch/worktree.
3. Read the local preservation docs and classify each local feature as:
   `upstream solved`, `keep`, `adapt`, or `drop`.
4. Never overwrite the local Control Center integrations mechanically.
5. Run repository tests, Control Center checks, and targeted live gates
   proportional to the surfaces changed.
6. Merge the reviewed result into the Destiney release branch.
7. Publish to `destineylu/codex-fusion main` only after acceptance.
8. Existing user installations then receive the reviewed build through their
   normal fast-forward update.

### ChatGPT Web upstream adoption

For every new upstream launcher release:

1. Download the release asset without replacing the audited production pin.
2. Verify release provenance and record the new installer SHA-256.
3. Inspect the launcher/runtime changes, especially browser setup, route
   mutation, Responses payloads and MCP/Connector behavior.
4. Check whether the v5.0.8 `15_000` preflight cap still exists.
5. If the defect is gone, remove the version-specific patch rather than carrying
   it forward.
6. If a patch is still required, create a new exact input/output hash pair.
7. Run direct, streaming, reasoning, tools, continuation and final routed
   compatibility gates.
8. Only then change the audited version in the distribution.

### Auto Resume upstream adoption

Review the upstream commit range, confirm the reset-credit default and
autostart semantics, run its doctor/dry-run tests, then advance the audited
commit.

## 6. Release acceptance

A v1 release is not complete merely because it works on the maintainer's
machine. At minimum, verify on a clean Windows user profile or VM:

```text
fresh clone from destineylu/main
origin = destineylu
upstream = duolahypercho
dependency install
Router health / doctor
Control Center build + launch
provider setup without copied credentials
ChatGPT Web audited install
ChatGPT Web isolated start
real Codex route remains Router
Auto Resume audited install
weekly reset auto redeem = false
self-update from origin/main
rollback path remains available
```

Do not use an already-configured maintainer profile as the only release test.

## 7. Upgrade invariants

These rules are part of the distribution contract:

- no automatic model fallback unless the operator explicitly enables a named
  fallback policy;
- no upgrade may silently replace the user's Codex login or unrelated config;
- no upstream repository may be auto-merged into production;
- no sidecar may float to an unreviewed upstream release;
- no personal filesystem path, API key, Tunnel key, account token, Tailscale
  address or ComfyUI endpoint belongs in release defaults;
- release source, upstream reference and user state remain three separate
  layers.

That separation is what makes the system both reusable by other people and
maintainable when the reference projects continue to evolve.
