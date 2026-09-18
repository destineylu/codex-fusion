# Local patch: guarded Codex ChatGPT Web sidecar

Date: 2026-09-17

## Decision

Codex Desktop + Codex Router remain the production control plane.

`miuuyy/codex-chatgpt-web` is the only ChatGPT Web integration candidate for the production path. It is treated as an external loopback sidecar/provider, not as the owner of Codex routing, session state, compaction, workers, or workspace state.

Chat On Steroids remains an isolated experiment for Goal / Loop / durable-worker research only. It is intentionally not connected to Router or Control Center.

## Audited upstream

- Repository: https://github.com/miuuyy/codex-chatgpt-web
- Audited release: v5.0.8
- Release date checked: 2026-09-16
- Windows x64 asset: `codex-web-gpt-5.0.8-win-x64.exe`
- Audited Windows asset SHA-256:
  `83224d59506462ab2976f437bfaea96b046d4ed55caa7e1cfd6a3d61de0a8ff3`
- Loopback Responses endpoint: `http://127.0.0.1:17841/v1`

The Control Center installer downloads that exact asset and verifies the fixed hash before running the silent current-user installer. It does not start the launcher after installation.

## Route ownership invariant

Codex Router must remain the owner of Codex `openai_base_url`.

Expected topology:

```text
Codex Desktop
    |
    v
Codex Router (4202 capability route)
    |
    +-- xKiro / Command Code / other providers
    |
    +-- chatgpt-web
            |
            v
       127.0.0.1:17841
            |
            v
       ChatGPT Web
```

The upstream launcher currently expects to be able to install itself directly into Codex. Its external-router/provider request (#205) was closed as not planned in the audited upstream state.

Therefore Control Center never points the real Codex home at the upstream launcher. Managed Start launches the upstream app with a dedicated shadow `CODEX_HOME`; inside that managed launcher, upstream `Install models` / route-connect actions are allowed because they can only rewrite the shadow Codex config. The real Codex `openai_base_url` must never be intentionally replaced with port 17841.

## Control Center boundary

Renderer-visible actions are fixed:

- `install`
- `start-managed`
- `show-managed`
- `start-daemon`
- `stop-managed`
- `verify-isolation`

`start-managed` is the only supported launcher start path. `show-managed` only re-opens/focuses that same isolated instance through Electron single-instance handling. Both inject:

- `CODEX_HOME=<managed-root>/codex-home`
- `CODEX_CHATGPT_WEB_HOME=<managed-root>`
- `CODEX_WEB_GPT_LAUNCHER_DATA_DIR=<managed-root>/launcher`

The managed root defaults to `%LOCALAPPDATA%\\codex-router-sidecars\\codex-chatgpt-web` on Windows. The real Codex config is fingerprinted before launch and watched during the launch transaction. If the real config or its route owner changes, the managed launcher is terminated and the exact pre-launch config is restored.

The managed launcher state is forced to `autoStart=false` before every managed launch. Any Windows Run/RunOnce entry pointing directly at the upstream launcher is also removed as a second defense, so a later Windows login cannot start the launcher outside the sandbox.

Windows login recovery is owned by the existing **Codex Router Tray** task, not by the upstream launcher and not by a second ChatGPT Web scheduled task. When the packaged Control Center starts with `--tray-only`, it waits 30 seconds, verifies that the real Codex route owner is still Router, then restores the managed launcher / upstream-owned 17841 bridge. Recovery retries are bounded and fail closed. If Router is not the route owner, no ChatGPT Web process is started. This path was acceptance-tested from a fully stopped 17841 state and restored `running=true`, `browserReady=true`, `daemonRunning=true`, `bridgeReachable=true`, `safeToDiscover=true` while the real Codex route remained on 4202.

The first managed launch may materialize the audited runtime into `<managed-root>/versions/5.0.8-win32-x64`. The manager waits for the live `launcher-browser.json` descriptor rather than assuming the Electron process is ready.

There is no generic command, argv, filesystem path, URL, provider endpoint, or shell bridge exposed to the renderer.

The status adapter:

- locates the installed launcher and starts it only through the managed sandbox action;
- reads only safe fields from the managed `<root>/runtime/launcher-supervisor.json`;
- classifies the Codex route without returning the raw Router capability URL;
- probes only fixed loopback endpoints;
- reports a direct-route conflict if Codex points to 17841;
- never rewrites the real Codex config during normal operation; the only write-back is transactional restoration if a managed launch/setup/daemon start unexpectedly touches the real config.

## Managed 17841 lifecycle

The production launcher is used as an isolated authenticated browser host **and** owns the production 17841 daemon. Router must not start a second competing `serve` process. `start-daemon` is therefore an ensure/recovery action: it verifies that Router still owns the real Codex route, ensures the isolated launcher/browser is ready, and lets the upstream-managed daemon become reachable on `127.0.0.1:17841`.

The real Codex route always remains:

```text
Codex Desktop
    |
    v
4202 Codex Router
    |
    v
chatgpt-web provider
    |
    v
17841 upstream-managed bridge
    |
    v
ChatGPT Web + Codex Native2 Full harness
```

The real Codex config is fingerprinted across managed launch/setup/daemon recovery. A route or file change fails closed and restores the exact pre-operation bytes. The upstream launcher's own autostart stays disabled; login recovery is performed only by the packaged Control Center Tray in the guarded managed environment.

## Router provider

`config/chatgpt-web/chatgpt-web.json` registers a keyless loopback OpenAI Responses provider at `127.0.0.1:17841/v1`.

The registry descriptor remains conservative and does not blindly publish discovered Web models. On this machine, live compatibility and final Router-routed acceptance have now passed for three user-curated models:

- `chatgpt-web/light` — 41K context
- `chatgpt-web/medium` — 90K context
- `chatgpt-web/high` — 90K context

Each model passed direct basic / streaming / tools / reasoning probes and final routed compatibility through 4202. The local user-model registry now contains all three entries. Publication still fails closed for any newly discovered model until it passes the same live verification path. Automatic fallback remains disabled.

## CoS isolation rule

Do not add Chat On Steroids to:

- Router providers;
- Control Center lifecycle management;
- Codex model picker;
- Router compact/resume;
- Router subagents;
- Router workspace/session ownership.

If Goal / Loop or durable-worker behavior is later useful, reimplement only the smallest required continuation primitive after a separate design review.

## Upgrade rules

Before updating codex-chatgpt-web:

1. Re-audit the release and binary checksum.
2. Check whether upstream now has a documented external-router/provider mode.
3. Re-check whether launcher startup, CLI setup, or model installation can escape the shadow `CODEX_HOME`.
4. Keep Router as the sole real Codex route owner; direct/manual launcher startup is unsupported.
5. Keep `start-daemon` free of `--replace-codex-route`; Router owns daemon lifecycle and provider publication.
6. Keep the bridge loopback-only and keyless.
7. Do not expose generic process execution through Control Center.
8. Do not enable automatic model fallback.
9. Do not merge browser/session/compaction ownership into Router.
10. Do not publish ChatGPT Web models until isolation verification passes.

If upstream eventually supports external-provider mode as a first-class contract, the guarded adapter may be simplified, but the Router ownership invariant should remain.
