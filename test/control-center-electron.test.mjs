import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertMutationCompatibility,
  detachedControlRuntime,
  discoverSourceRoot,
  runControlDetached,
  runControl,
  runControlJson,
  runtimeEnvironment,
  standardSourceRoots,
} from "../apps/control-center/electron/command-runner.mjs";
import {
  groupModelFamilies,
  modelFamilyKey,
} from "../apps/control-center/src/model-families.mjs";
import {
  addPendingCatalogModels,
  beginCatalogRequest,
  catalogRequestIsCurrent,
  clearProviderCatalogStates,
  invalidateProviderCatalogRequests,
  modelRouteKind,
  modelRouteProtocol,
  pendingCatalogModelIds,
  removePendingCatalogModels,
  searchLoadedCatalogModels,
} from "../apps/control-center/src/model-catalog-search.mjs";
import {
  createOpenRequestGate,
  createRendererReadyGate,
  lifecycleStatePath,
  linuxStatusNotifierHostAvailable,
  queryLifecycleState,
  shouldQuitOnLastWindowClosed,
  writeLifecycleState,
} from "../apps/control-center/electron/lifecycle-state.mjs";
import {
  controlCenterDestination,
  controlCenterNavigationURL,
  NAVIGATION_ARGUMENT,
  NAVIGATION_SOURCE_ARGUMENT,
} from "../apps/control-center/electron/navigation.mjs";
import {
  parseCodexModeStatus,
  parseCodexSkills,
} from "../apps/control-center/electron/codex-skill-control.mjs";
import {
  codexAutoResumeRoot,
  controlCodexAutoResume,
  getCodexAutoResumeSnapshot,
} from "../apps/control-center/electron/codex-auto-resume.mjs";
import {
  classifyCodexRoute,
  getCodexChatGptWebSnapshot,
  patchCodexChatGptWebPreflightBytes,
} from "../apps/control-center/electron/codex-chatgpt-web.mjs";
import {
  addCodexAccount,
  cancelCodexAccountLogin,
  codexDesktopRunning,
  deleteCodexAccount,
  getCodexAccountIdentityContext,
  getCodexAccountProfilesSnapshot,
  isWindowsCodexDesktopExecutable,
  parseCodexBrowserLoginOutput,
  parseCodexDeviceLoginOutput,
  renameCodexAccount,
  startCodexAccountBrowserLogin,
  startCodexAccountDeviceLogin,
  submitCodexAccountCallback,
  switchCodexAccount,
} from "../apps/control-center/electron/codex-account-profiles.mjs";

test("Control Center navigation accepts only one fixed widget destination", () => {
  assert.deepEqual(controlCenterDestination(["electron", ".", NAVIGATION_ARGUMENT, "usage"]), {
    destination: "usage",
    sourceId: undefined,
  });
  assert.deepEqual(
    controlCenterDestination(["electron", ".", NAVIGATION_ARGUMENT, "usage-resets"]),
    { destination: "usage-resets", sourceId: undefined },
  );
  assert.deepEqual(
    controlCenterDestination([
      "electron", ".", NAVIGATION_ARGUMENT, "usage", NAVIGATION_SOURCE_ARGUMENT, "deepseek",
    ]),
    { destination: "usage", sourceId: "deepseek" },
  );
  assert.equal(controlCenterDestination(["electron", ".", NAVIGATION_ARGUMENT, "settings"]), undefined);
  assert.equal(controlCenterDestination(["electron", ".", NAVIGATION_ARGUMENT]), undefined);
  assert.equal(controlCenterDestination([
    "electron", ".", NAVIGATION_ARGUMENT, "usage", NAVIGATION_SOURCE_ARGUMENT, "deep_seek",
  ]), undefined);
  assert.equal(controlCenterDestination([
    "electron", ".", NAVIGATION_ARGUMENT, "usage", NAVIGATION_ARGUMENT, "usage-resets",
  ]), undefined);
});

test("Control Center navigation URLs are exact and source bounded", () => {
  assert.deepEqual(controlCenterNavigationURL(
    "codex-router://control-center/usage-resets?source=openai",
  ), { destination: "usage-resets", sourceId: "openai" });
  assert.deepEqual(controlCenterNavigationURL(
    "codex-router://control-center/usage",
  ), { destination: "usage", sourceId: undefined });
  for (const value of [
    "https://control-center/usage",
    "codex-router://other/usage",
    "codex-router://control-center//usage",
    "codex-router://control-center/settings",
    "codex-router://control-center/usage?source=deep_seek",
    "codex-router://control-center/usage?source=openai&source=deepseek",
    "codex-router://control-center/usage?next=settings",
    "codex-router://control-center/usage#reset",
  ]) assert.equal(controlCenterNavigationURL(value), undefined, value);
});

test("Control Center groups provider routes under one model family", () => {
  const families = groupModelFamilies([
    { slug: "opencode-go/glm-5.3-flash", displayName: "GLM-5.3-Flash (opencode Go)", provider: "opencode-go", visible: true, enabled: true },
    { slug: "opencode-go/glm-5.3", displayName: "GLM-5.3 (opencode Go)", provider: "opencode-go", visible: true, enabled: true },
    { slug: "deepseek/deepseek-v4-pro", displayName: "DeepSeek V4 Pro (API)", provider: "deepseek", visible: true, enabled: true },
  ]);
  assert.equal(families.length, 3);
  const glmFlash = families.find((family) => family.id === "glm-5-3-flash");
  assert.equal(glmFlash.displayName, "GLM-5.3-Flash");
  assert.deepEqual(glmFlash.routes.map((route) => route.slug), ["opencode-go/glm-5.3-flash"]);
  const glm = families.find((family) => family.id === "glm-5-3");
  assert.equal(glm.displayName, "GLM-5.3");
  assert.deepEqual(glm.routes.map((route) => route.slug), ["opencode-go/glm-5.3"]);
  assert.equal(modelFamilyKey({ displayName: "Kimi K3 (OAuth)" }), "kimi-k3");
  assert.equal(modelFamilyKey({ displayName: "Kimi K3 (opencode Go)" }), "kimi-k3");
});

test("global model search includes candidates that exist only in loaded discovery state", () => {
  const directory = [{
    id: "opencode-go",
    displayName: "opencode Go/Zen",
    setup: {
      configured: true,
      catalogSources: [
        { id: "opencode-go", displayName: "opencode Go" },
        { id: "opencode-zen", displayName: "opencode Zen" },
      ],
    },
  }];
  const states = {
    "opencode-zen": {
      data: {
        discovered: ["discovery-only-model"],
        registered: [],
        unregistered: ["discovery-only-model"],
        addable: ["discovery-only-model"],
        blocked: {},
        contextLengths: { "discovery-only-model": 131_072 },
        metadata: {
          "discovery-only-model": {
            contextWindow: 262_144,
            maxOutputTokens: 32_000,
            inputModalities: ["text", "image"],
            supportsTools: true,
            reasoning: { supportedEfforts: ["low", "high"] },
          },
        },
      },
    },
  };

  const [match] = searchLoadedCatalogModels(directory, states, "discovery only");
  assert.equal(match.modelId, "discovery-only-model");
  assert.equal(match.providerName, "opencode Go/Zen");
  assert.equal(match.sourceName, "opencode Zen");
  assert.equal(match.sourceId, "opencode-zen");
  assert.equal(match.addable, true);
  assert.equal(match.registered, false);
  assert.equal(match.contextWindow, 262_144);
  assert.equal(match.maxOutputTokens, 32_000);
  assert.deepEqual(match.inputModalities, ["text", "image"]);
  assert.deepEqual(match.reasoningEfforts, ["low", "high"]);
  assert.equal(match.supportsTools, true);
  assert.equal(searchLoadedCatalogModels(directory, states, "opencode zen").length, 1);
});

test("global model search exposes blocked reasons and hides disconnected catalog state", () => {
  const connected = [{
    id: "opencode-go",
    displayName: "opencode Go/Zen",
    setup: {
      configured: true,
      catalogSources: [{ id: "opencode-go", displayName: "opencode Go" }],
    },
  }];
  const states = {
    "opencode-go": {
      data: {
        discovered: ["future-protocol-model"],
        registered: [],
        unregistered: ["future-protocol-model"],
        addable: [],
        blocked: {
          "future-protocol-model": "No certified Chat, Messages, or Responses route yet.",
        },
      },
    },
  };

  const [match] = searchLoadedCatalogModels(connected, states, "future protocol");
  assert.equal(match.addable, false);
  assert.equal(match.blockedReason, "No certified Chat, Messages, or Responses route yet.");

  const disconnected = [{
    ...connected[0],
    setup: { ...connected[0].setup, configured: false },
  }];
  assert.deepEqual(searchLoadedCatalogModels(disconnected, states, "future protocol"), []);
});

test("credential changes clear every loaded catalog source in only that provider family", () => {
  const current = {
    "opencode-go": { status: "ready" },
    "opencode-zen": { status: "ready" },
    deepseek: { status: "ready" },
  };
  const cleared = clearProviderCatalogStates(current, [
    { id: "opencode-go" },
    { id: "opencode-zen" },
  ]);
  assert.deepEqual(cleared, { deepseek: { status: "ready" } });
  assert.deepEqual(current, {
    "opencode-go": { status: "ready" },
    "opencode-zen": { status: "ready" },
    deepseek: { status: "ready" },
  });
  assert.strictEqual(clearProviderCatalogStates(current, []), current);
});

test("credential changes invalidate every pre-existing catalog completion", () => {
  const generations = {};
  const oldGo = beginCatalogRequest(generations, "opencode-go");
  const oldZen = beginCatalogRequest(generations, "opencode-zen");
  const unrelated = beginCatalogRequest(generations, "deepseek");

  invalidateProviderCatalogRequests(generations, [
    { id: "opencode-go" },
    { id: "opencode-zen" },
  ]);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", oldGo), false);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-zen", oldZen), false);
  assert.equal(catalogRequestIsCurrent(generations, "deepseek", unrelated), true);

  const newGo = beginCatalogRequest(generations, "opencode-go");
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", newGo), true);
  assert.equal(catalogRequestIsCurrent(generations, "opencode-go", oldGo), false);
});

test("route protocol labels use the provider-qualified snapshot slug", () => {
  const base = { provider: "opencode-go", enabled: true, visible: true };
  const messages = { ...base, slug: "opencode-go-messages/minimax-m3" };
  const responses = { ...base, slug: "opencode-go-responses/grok-4.5", isFree: true };

  assert.equal(modelRouteProtocol(messages), "messages");
  assert.equal(modelRouteKind(messages), "Messages API route");
  assert.equal(modelRouteProtocol(responses), "responses");
  assert.equal(modelRouteKind(responses), "Responses API route");
});

test("overlapping catalog adds retain each operation's pending models", () => {
  let pending = {};
  pending = addPendingCatalogModels(pending, "deepseek", ["deepseek-v4", "shared-model"]);
  pending = addPendingCatalogModels(pending, "deepseek", ["deepseek-v5", "shared-model"]);
  assert.deepEqual(
    new Set(pendingCatalogModelIds(pending, "deepseek")),
    new Set(["deepseek-v4", "deepseek-v5", "shared-model"]),
  );

  pending = removePendingCatalogModels(pending, "deepseek", ["deepseek-v4", "shared-model"]);
  assert.deepEqual(
    new Set(pendingCatalogModelIds(pending, "deepseek")),
    new Set(["deepseek-v5", "shared-model"]),
  );

  pending = removePendingCatalogModels(pending, "deepseek", ["deepseek-v5", "shared-model"]);
  assert.deepEqual(pendingCatalogModelIds(pending, "deepseek"), []);
  assert.deepEqual(pending, {});
});

test("Electron queues pre-ready open requests and drains them once", () => {
  let opens = 0;
  const gate = createOpenRequestGate(() => { opens += 1; });
  gate.requestOpen();
  gate.requestOpen();
  assert.equal(gate.pending(), true);
  assert.equal(opens, 0);
  gate.markReady();
  assert.equal(gate.pending(), false);
  assert.equal(opens, 1);
  gate.requestOpen();
  assert.equal(opens, 2);
});

test("Electron renderer readiness requires load and first-paint signals", () => {
  let ready = 0;
  let failures = 0;
  const gate = createRendererReadyGate({
    onReady: () => { ready += 1; },
    onFailure: () => { failures += 1; },
  });
  gate.didFinishLoad();
  assert.equal(gate.ready(), false);
  assert.equal(ready, 0);
  gate.didBecomeReadyToShow();
  assert.equal(gate.ready(), true);
  assert.equal(ready, 1);
  gate.didBecomeReadyToShow();
  gate.didFinishLoad();
  gate.didFailLoad(new Error("late failure"));
  assert.equal(ready, 1);
  assert.equal(failures, 0);
});

test("Electron renderer readiness fails closed before first paint", () => {
  let ready = 0;
  let failure;
  const gate = createRendererReadyGate({
    onReady: () => { ready += 1; },
    onFailure: (error) => { failure = error; },
  });
  gate.didFinishLoad();
  gate.didFailLoad(new Error("missing renderer"));
  gate.didBecomeReadyToShow();
  assert.equal(gate.ready(), false);
  assert.equal(gate.failed(), true);
  assert.equal(ready, 0);
  assert.match(failure.message, /missing renderer/);
});

test("Electron lifecycle state is durable, queryable, and fail-closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-lifecycle-"));
  const file = path.join(directory, "control-center-lifecycle.json");
  try {
    assert.equal(
      lifecycleStatePath({ MODEL_ROUTER_STATE_DIR: directory }, "/unused"),
      file,
    );
    const written = writeLifecycleState(file, {
      pid: 4321,
      ready: true,
      visible: true,
      now: new Date("2026-08-24T00:00:00.000Z"),
    });
    assert.equal(written.visible, true);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o077, 0);
    assert.deepEqual(queryLifecycleState(file, { isRunning: (pid) => pid === 4321 }), {
      version: 1,
      running: true,
      pid: 4321,
      ready: true,
      visible: true,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    assert.deepEqual(queryLifecycleState(file, { isRunning: () => false }), {
      version: 1,
      running: false,
      pid: null,
      ready: false,
      visible: false,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    writeLifecycleState(file, { pid: 4321, ready: false, visible: false });
    const stopped = queryLifecycleState(file, { isRunning: () => true });
    assert.equal(stopped.ready, false);
    assert.equal(stopped.visible, false);
    await writeFile(file, "not json\n", { mode: 0o600 });
    assert.equal(queryLifecycleState(file).visible, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a windowless desktop process survives only while a real tray owner exists", () => {
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "darwin", nativeTrayOwnedByHost: true }), true);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "darwin", nativeTrayOwnedByHost: false, trayAvailable: false }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "win32", nativeTrayOwnedByHost: false, trayAvailable: true }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "win32", nativeTrayOwnedByHost: false, trayAvailable: false }), true);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "linux", nativeTrayOwnedByHost: false, trayAvailable: true }), false);
  assert.equal(shouldQuitOnLastWindowClosed({ platform: "linux", nativeTrayOwnedByHost: false, trayAvailable: false }), true);
});

test("Linux tray-only mode trusts only a positively registered StatusNotifier host", () => {
  const calls = [];
  const available = linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => true,
    environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/test/session-bus" },
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: "(<true>,)\n" };
    },
  });
  assert.equal(available, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "/usr/bin/gdbus");
  assert.deepEqual(calls[0].args, [
    "call",
    "--session",
    "--dest", "org.kde.StatusNotifierWatcher",
    "--object-path", "/StatusNotifierWatcher",
    "--method", "org.freedesktop.DBus.Properties.Get",
    "org.kde.StatusNotifierWatcher",
    "IsStatusNotifierHostRegistered",
  ]);
  assert.equal(calls[0].options.shell, false);

  for (const result of [
    { status: 0, stdout: "(<false>,)\n" },
    { status: 0, stdout: "unexpected\n" },
    { status: 1, stdout: "(<true>,)\n" },
  ]) {
    assert.equal(linuxStatusNotifierHostAvailable({
      platform: "linux",
      executableExists: () => true,
      spawn: () => result,
    }), false);
  }
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => false,
    spawn: () => assert.fail("a missing probe must fail open without spawning"),
  }), false);
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "linux",
    executableExists: () => true,
    spawn: () => { throw new Error("session bus unavailable"); },
  }), false);
  assert.equal(linuxStatusNotifierHostAvailable({
    platform: "win32",
    executableExists: () => true,
    spawn: () => assert.fail("non-Linux platforms must not query D-Bus"),
  }), false);
});

async function waitForProcessExit(pid, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`descendant process ${pid} survived command termination`);
}

async function makeProcessTreeControlRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-control-tree-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, "src", "control.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const [pidFile, mode] = process.argv.slice(2);',
      'const descendant = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(pidFile, String(descendant.pid));',
      'if (mode === "overflow") process.stdout.write("x".repeat(4096));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(path.join(root, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path.join(root, "bin", "control"), 0o700);
  return root;
}

test("control center knows each installer's stable checkout location", () => {
  assert.deepEqual(
    standardSourceRoots({ platform: "win32", environment: { LOCALAPPDATA: "/local/appdata" }, home: "/home/test" }),
    [path.join("/local/appdata", "codex-router")],
  );
  assert.deepEqual(
    standardSourceRoots({ platform: "linux", environment: { XDG_DATA_HOME: "/xdg/data" }, home: "/home/test" }),
    [path.join("/xdg/data", "codex-router"), path.join("/home/test", ".local", "share", "codex-router")],
  );
});

test("control center repairs the runtime PATH for desktop-launched commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-node-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const node = path.join(directory, nodeName);
  try {
    await writeFile(node, "", { mode: 0o700 });
    const environment = runtimeEnvironment({ PATH: directory, KEEP_ME: "yes" });
    assert.equal(environment.KEEP_ME, "yes");
    assert.equal(environment.PATH.split(path.delimiter)[0], directory);
    assert.equal(environment.CODEX_ROUTER_NODE_BIN, node);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the recorded runtime keeps the name a version-manager shim dispatches on", { skip: process.platform === "win32" }, async () => {
  // volta ships one dispatcher binary and symlinks `node` at it; it decides
  // what to run from the name it was invoked under. Recording the link target
  // hands `bin/install` a launcher that refuses to start, and that value is
  // written straight into the background service definition.
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-shim-"));
  try {
    const dispatcher = path.join(directory, "volta-shim");
    const node = path.join(directory, "node");
    await writeFile(dispatcher, "", { mode: 0o700 });
    symlinkSync(dispatcher, node);
    const environment = runtimeEnvironment({ PATH: directory });
    assert.equal(environment.CODEX_ROUTER_NODE_BIN, node);
    assert.equal(path.basename(environment.CODEX_ROUTER_NODE_BIN), "node");
    assert.equal(environment.PATH.split(path.delimiter)[0], directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an operator's own runtime choice is honored exactly as written", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-chosen-"));
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  try {
    const chosen = path.join(directory, nodeName);
    await writeFile(chosen, "", { mode: 0o700 });
    assert.equal(
      runtimeEnvironment({ PATH: "", CODEX_ROUTER_NODE_BIN: chosen }).CODEX_ROUTER_NODE_BIN,
      chosen,
    );
    // A named runtime that cannot be executed must not be recorded; discovery
    // takes over, and an undiscoverable runtime leaves the refusal to the
    // installer rather than naming something that does not run.
    const broken = runtimeEnvironment(
      { PATH: "", CODEX_ROUTER_NODE_BIN: path.join(directory, "missing") },
      { platform: "sunos" },
    );
    assert.notEqual(broken.CODEX_ROUTER_NODE_BIN, path.join(directory, "missing"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows detached tray refresh runs outside the package on external node.exe", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "router-control-detached-"));
  const packageDirectory = path.join(directory, "win-unpacked");
  const runtimeDirectory = path.join(directory, "node-runtime");
  const packagedExecutable = path.join(packageDirectory, "Codex Router.exe");
  const externalNode = path.join(runtimeDirectory, "node.exe");
  try {
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(packagedExecutable, "");
    await writeFile(externalNode, "");
    const launch = detachedControlRuntime(
      {
        PATH: "",
        CODEX_ROUTER_NODE_BIN: externalNode,
        ELECTRON_RUN_AS_NODE: "1",
      },
      { platform: "win32", execPath: packagedExecutable, electron: true },
    );
    assert.equal(launch.executable, externalNode);
    assert.equal(launch.environment.CODEX_ROUTER_NODE_BIN, externalNode);
    assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, undefined);

    const source = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
    const detached = source.slice(source.indexOf("export function runControlDetached("));
    assert.match(detached, /spawnImpl\([\s\S]*runtime\.executable,[\s\S]*path\.join\(sourceRoot, "src", "control\.mjs"\), \.\.\.args/);
    assert.doesNotMatch(detached, /spawn\(process\.execPath/);

    const inPackageNode = path.join(packageDirectory, "node.exe");
    await writeFile(inPackageNode, "");
    assert.throws(
      () => detachedControlRuntime(
        { PATH: "", CODEX_ROUTER_NODE_BIN: inPackageNode },
        { platform: "win32", execPath: packagedExecutable, electron: true },
      ),
      /trusted external node\.exe is required/,
    );
    await rm(inPackageNode);
    assert.throws(
      () => detachedControlRuntime(
        { PATH: "" },
        { platform: "win32", execPath: packagedExecutable, electron: true },
      ),
      /trusted external node\.exe is required/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-Windows detached refresh keeps the packaged Node-mode launch", { skip: process.platform === "win32" }, () => {
  const launch = detachedControlRuntime(
    { PATH: path.dirname(process.execPath) },
    { platform: process.platform, execPath: process.execPath, electron: true },
  );
  assert.equal(launch.executable, process.execPath);
  assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, "1");
});

test("detached control resolves only after spawn and rejects a pre-spawn error", async () => {
  const runtime = { executable: "/test/node", environment: {} };
  const sourceRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const failedChild = new EventEmitter();
  failedChild.unref = () => assert.fail("a failed child must not be unreferenced as launched");
  const failed = runControlDetached(["tray", "restart"], {
    sourceRoot,
    runtime,
    spawnImpl: () => {
      queueMicrotask(() => failedChild.emit("error", new Error("spawn ENOENT")));
      return failedChild;
    },
  });
  await assert.rejects(failed, /spawn ENOENT/);

  const launchedChild = new EventEmitter();
  launchedChild.pid = 4242;
  let unreferenced = false;
  launchedChild.unref = () => { unreferenced = true; };
  const launched = runControlDetached(["tray", "restart"], {
    sourceRoot,
    runtime,
    spawnImpl: () => {
      queueMicrotask(() => launchedChild.emit("spawn"));
      return launchedChild;
    },
  });
  assert.equal(await launched, 4242);
  assert.equal(unreferenced, true);
});

test("control center resolves a trusted router source root", async () => {
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  delete process.env.CODEX_ROUTER_SOURCE_ROOT;
  delete process.env.MODEL_ROUTER_STATE_DIR;
  process.env.CODEX_ROUTER_STATE_DIR = state;
  delete process.env.KIMI_CODEX_STATE_DIR;
  const repositoryRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  try {
    assert.equal(discoverSourceRoot(), repositoryRoot);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(state, { recursive: true, force: true });
  }
});

test("control center follows the recorded router owner", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(
      path.join(state, "install-manifest.json"),
      JSON.stringify({ version: 1, current: { sourceRoot: owner } }),
      { mode: 0o600 },
    );
    delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    delete process.env.MODEL_ROUTER_STATE_DIR;
    process.env.CODEX_ROUTER_STATE_DIR = state;
    delete process.env.KIMI_CODEX_STATE_DIR;
    assert.equal(discoverSourceRoot(), realpathSync(owner));
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("control center refuses mutations across app/control protocol skew", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-contract-"));
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    assert.throws(() => assertMutationCompatibility(owner), /same build/);

    const bundled = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
    await mkdir(path.join(owner, "apps", "control-center"), { recursive: true });
    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: bundled.version, controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.doesNotThrow(() => assertMutationCompatibility(owner));

    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: "0.0.0", controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.throws(() => assertMutationCompatibility(owner), /same build/);
  } finally {
    await rm(owner, { recursive: true, force: true });
  }
});

test("trusted install provenance overrides contradictory package-manager environment", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const environmentKeys = [
    "CODEX_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_STATE_DIR",
    "CODEX_ROUTER_STATE_DIR",
    "KIMI_CODEX_STATE_DIR",
    "CODEX_ROUTER_PACKAGE_MANAGER",
  ];
  const prior = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const writeManifest = (packageManager) => writeFile(
    path.join(state, "install-manifest.json"),
    JSON.stringify({ version: 1, current: { sourceRoot: owner, packageManager } }),
    { mode: 0o600 },
  );
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(
      path.join(owner, "src", "control.mjs"),
      "process.stdout.write(JSON.stringify({ packageManager: process.env.CODEX_ROUTER_PACKAGE_MANAGER ?? null }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    process.env.CODEX_ROUTER_SOURCE_ROOT = owner;
    delete process.env.MODEL_ROUTER_SOURCE_ROOT;
    process.env.MODEL_ROUTER_STATE_DIR = state;
    delete process.env.CODEX_ROUTER_STATE_DIR;
    delete process.env.KIMI_CODEX_STATE_DIR;
    process.env.CODEX_ROUTER_PACKAGE_MANAGER = "contradictory";

    await writeManifest("homebrew");
    assert.equal((await runControlJson()).packageManager, "homebrew");
    await writeManifest(null);
    assert.equal((await runControlJson()).packageManager, null);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("electron boundary does not enable node integration or shell argv", async () => {
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("routerControl"/);
  assert.match(preload, /require\("electron"\)/);
  assert.doesNotMatch(preload, /executeJavaScript|node:child_process|node:fs|node:path/);
  const main = await readFile(new URL("../apps/control-center/electron/main.mjs", import.meta.url), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /frame:\s*false/);
  assert.match(main, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(main, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*16\s*\}/);
  assert.match(main, /titleBarStyle:\s*"hidden"/);
  assert.doesNotMatch(main, /titleBarOverlay/);
  assert.match(main, /setApplicationMenu\(null\)/);
  assert.match(main, /icon:\s*appIconPath\(\)/);
  assert.match(main, /app\.dock\?\.setIcon\(appIconPath\(\)\)/);
  assert.match(main, /function showDockForVisibleWindow\(\)[\s\S]*app\.dock\.setIcon\(appIconPath\(\)\)[\s\S]*app\.dock\.show\(\)/);
  assert.match(main, /function hideDockForHiddenWindow\(\)[\s\S]*app\.dock\.hide\(\)/);
  assert.match(main, /function revealWindow\(\)[\s\S]{0,420}showDockForVisibleWindow\(\)[\s\S]{0,120}mainWindow\.show\(\)/);
  assert.match(main, /createdWindow\.on\("hide"[\s\S]{0,180}hideDockForHiddenWindow\(\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /if \(app\.isPackaged \|\| !requested\)/);
  assert.match(main, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(parsed\.hostname\)/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /else openRequests\.requestOpen\(\)/);
  assert.match(main, /new Tray\(/);
  assert.match(main, /createdTray\.on\("click", showWindow\)/);
  assert.match(main, /Open Control Center/);
  assert.match(main, /CODEX_ROUTER_EMBEDDED_CONTROL_CENTER/);
  assert.match(main, /image\.isEmpty\(\)[\s\S]*tray icon could not be loaded/);
  assert.match(main, /const trayAvailable = trayIsAvailable\(\)/);
  assert.match(main, /process\.platform === "linux"[\s\S]{0,100}linuxStatusNotifierHostAvailable\(\)/);
  assert.doesNotMatch(main, /nativeImage\.createEmpty\(\)/);
  assert.match(
    main,
    /if \(!trayOnlyInvocation \|\| !trayAvailable\) openRequests\.requestOpen\(\);\s*createWindow\(\);/,
  );
  assert.doesNotMatch(main, /if \(trayAvailable\)[\s\S]{0,100}completeApplicationReadiness\(\)/);
  assert.match(main, /webContents\.once\("did-finish-load"/);
  assert.match(main, /createdWindow\.once\("ready-to-show"/);
  assert.match(main, /webContents\.once\([\s\S]{0,80}"did-fail-load"/);
  assert.match(main, /rendererReady\.didFailLoad/);
  assert.match(main, /app\.exit\(1\)/);
  assert.match(main, /commandLine\.includes\("--quit-for-update"\)/);
  assert.match(main, /shouldQuitOnLastWindowClosed\([\s\S]{0,120}app\.quit\(\)/);
  assert.match(main, /LIFECYCLE_QUERY_ARGUMENT/);
  assert.match(main, /queryLifecycleState\(lifecycleFile\)/);
  assert.match(main, /createdWindow\.on\("hide"[\s\S]{0,140}windowVisible = false/);
  assert.match(main, /app\.on\("will-quit"[\s\S]{0,160}applicationReady = false/);
  assert.match(main, /app\.on\("before-quit"/);
  assert.match(main, /mutationLifecycle\.hasActiveMutations\(\)/);
  assert.match(main, /mutationLifecycle\.whenMutationsIdle\(\)/);
  assert.match(main, /script-src 'self' 'sha256-Z2\/iFzh9VMlVkEOar1f\/oSHWwQk3ve1qk\/C2WdsC4Xk='/);
  assert.doesNotMatch(main, /script-src[^;]*'unsafe-inline'/);
  const builder = await readFile(new URL("../apps/control-center/electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /extraResources:[\s\S]*icon\.png/);
  assert.match(builder, /runAsNode:\s*true/);
  assert.match(builder, /enableEmbeddedAsarIntegrityValidation:\s*true/);
  assert.match(builder, /onlyLoadAppFromAsar:\s*true/);
  assert.match(builder, /mac:[\s\S]*target:\s*\[dmg, zip\]/);
  assert.match(builder, /linux:[\s\S]*executableName:\s*codex-router-control-center[\s\S]*target:\s*\[AppImage\]/);
  assert.match(builder, /win:[\s\S]*target:\s*\[nsis\]/);
  const compatibilityMain = await readFile(new URL("../apps/control-center/main.mjs", import.meta.url), "utf8");
  assert.match(compatibilityMain, /import "\.\/electron\/main\.mjs"/);
  assert.doesNotMatch(compatibilityMain, /BrowserWindow|ipcMain|registerIpcHandlers/);
  const renderer = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(renderer, /traffic-lights/);
  assert.match(renderer, /native-titlebar/);
  const styles = await readFile(new URL("../apps/control-center/src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.traffic-lights/);
  assert.match(styles, /native-titlebar/);
  assert.match(styles, /native-titlebar-darwin\.sidebar-collapsed \.titlebar[\s\S]*padding-left:\s*88px/);
  assert.doesNotMatch(renderer, /drag-region|no-drag/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
  assert.match(styles, /-webkit-app-region:\s*no-drag/);
  for (const label of ["Close window", "Minimize window", "Maximize or restore window"]) {
    assert.match(renderer, new RegExp(`aria-label=\\"${label}\\"`));
  }
  const runner = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /shell:\s*false/);
  assert.doesNotMatch(runner, /shell:\s*true/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
  assert.match(runner, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(runner, /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
});

test("control center package version follows the router beta", async () => {
  const routerPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const appPackage = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
  const appLock = JSON.parse(await readFile(new URL("../apps/control-center/package-lock.json", import.meta.url), "utf8"));
  assert.equal(appPackage.version, routerPackage.version);
  assert.equal(appPackage.controlProtocol, 1);
  assert.equal(appLock.version, routerPackage.version);
  assert.equal(appLock.packages[""].version, routerPackage.version);
});

test("background usage polling is conservative while manual refresh stays immediate", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 5 \* 60_000\)/);
  assert.doesNotMatch(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 30_000\)/);
  assert.match(source, /Promise\.allSettled\(\[refreshCore\(\), refreshUsage\(\)\]\)/);
  assert.match(source, /Promise\.allSettled\(\[[\s\S]*api\.getSnapshot\(\)[\s\S]*api\.getHealth\(\)/);
  assert.match(source, /settleRead\("snapshot", api\.getSnapshot\(\), setSnapshot\)/);
  assert.match(source, /settleRead\("providers", api\.getProviders\(\), setProviders\)/);
  assert.match(source, /settleRead\("providerUsage", api\.getProviderUsage\(\), setProviderUsage\)/);
  assert.doesNotMatch(source, /loading \? <LoadingState \/> : page/);
  assert.match(source, /downloadPollInFlight\.current/);
  assert.match(source, /healthPollInFlight\.current/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /localDownloadActive(?: \|\| mlxOperationActive)? \? api\.getLocalModels\(\)/);
  assert.match(source, /visionDownloadActive \? api\.getVisionBridge\(\)/);
  assert.match(source, /downloadTimer = window\.setInterval\(\(\) => void refreshDownloadProgress\(\), 4_000\)/);
  assert.doesNotMatch(source, /downloadTimer = window\.setInterval\([\s\S]{0,160}refreshCore/);
});

test("Codex Light v2 skill output is parsed without exposing a generic shell bridge", async () => {
  const status = parseCodexModeStatus([
    "Codex context mode: LIGHT v2",
    "Model: commandcode/deepseek-v4-flash",
    "LIGHT v2 skill disable entries in config: 47",
    "Current specialized skill candidates: 48",
    "Temporary skill exceptions: 1",
  ].join("\n"));
  assert.deepEqual(status, {
    mode: "light",
    modeLabel: "LIGHT v2",
    model: "commandcode/deepseek-v4-flash",
    modelProvider: undefined,
    temporaryExceptions: 1,
    disabledEntries: 47,
    specializedCandidates: 48,
  });
  assert.deepEqual(parseCodexSkills([
    "  [OFF]      comfyui                        comfyui-skill",
    "  [ON TEMP]  xiaohongshu-box                xiaohongshu-box",
  ].join("\n")), [
    { name: "comfyui", source: "comfyui-skill", state: "OFF", enabled: false, temporary: false },
    { name: "xiaohongshu-box", source: "xiaohongshu-box", state: "ON TEMP", enabled: true, temporary: true },
  ]);
  const source = await readFile(new URL("../apps/control-center/electron/codex-skill-control.mjs", import.meta.url), "utf8");
  assert.match(source, /switch-codex-mode\.ps1/);
  assert.match(source, /new Set\(\["status", "skills", "preview", "light", "full", "skill-on", "skill-off"\]\)/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /-Command/);
});

test("Codex Auto Resume stays an external fixed-root sidecar", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-auto-resume-"));
  const root = path.join(tmp, "checkout");
  const stateDir = path.join(tmp, "vibcoding", "codex-auto-resume");
  await mkdir(path.join(root, "src", "codex_auto_resume"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(root, "run.py"), "# test fixture\n", "utf8");
  await writeFile(path.join(root, "src", "codex_auto_resume", "__init__.py"), '__version__ = "0.2.2"\n', "utf8");
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
    enabled: true,
    auto_redeem_weekly_reset: false,
  }), "utf8");
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({
    last_status: "waiting-primary-reset",
    last_checked_at: 123,
    threads: {
      a: { thread_id: "thread-a", enabled: true, status: "waiting", resumes: 2 },
      b: { thread_id: "thread-b", enabled: false, status: "disabled", resumes: 0 },
    },
  }), "utf8");

  const env = {
    CODEX_AUTO_RESUME_ROOT: root,
    XDG_DATA_HOME: tmp,
  };
  assert.equal(codexAutoResumeRoot({ platform: "linux", env, home: tmp }), root);
  const snapshot = getCodexAutoResumeSnapshot({ platform: "linux", env, home: tmp });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.version, "0.2.2");
  assert.equal(snapshot.autoRedeemWeeklyReset, false);
  assert.equal(snapshot.trackedThreads, 2);
  assert.equal(snapshot.activeThreads, 1);
  assert.equal(snapshot.root, root);
  assert.equal(snapshot.supported, false);

  const helper = await readFile(new URL("../apps/control-center/electron/codex-auto-resume.mjs", import.meta.url), "utf8");
  assert.match(helper, /https:\/\/github\.com\/feifeigong\/codex-auto-resume\.git/);
  assert.match(helper, /1b2dae9d862573adc727b8d273d2760785344351/);
  assert.match(helper, /codex-router-sidecars/);
  assert.match(helper, /CODEX_AUTO_RESUME_ROOT/);
  assert.match(helper, /shell: false/);
  assert.doesNotMatch(helper, /shell: true/);
  await rm(tmp, { recursive: true, force: true });
});

test("Codex Auto Resume scopes an unmanaged single native login without silently claiming legacy threads", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-auto-resume-unmanaged-"));
  const home = path.join(tmp, "home");
  const liveHome = path.join(home, ".codex");
  const sidecarRoot = path.join(tmp, "sidecar");
  const threadId = "33333333-3333-4333-8333-333333333333";
  try {
    await mkdir(liveHome, { recursive: true });
    await mkdir(path.join(sidecarRoot, "src", "codex_auto_resume"), { recursive: true });
    await writeFile(path.join(liveHome, "auth.json"), JSON.stringify(accountTestAuth("acct-single", "single-live")));
    await writeFile(path.join(sidecarRoot, "src", "codex_auto_resume", "__init__.py"), '__version__ = "0.2.2"\n');
    await writeFile(
      path.join(sidecarRoot, "run.py"),
      [
        "import sys",
        'cmd = sys.argv[1] if len(sys.argv) > 1 else ""',
        'if cmd == "once":',
        '    print("dry-run waiting=1")',
        '    print("  ' + threadId + ' usage-limit reset=None")',
        'elif cmd == "doctor":',
        '    print("app_server OK ok")',
        "",
      ].join("\n"),
    );

    const options = {
      home,
      platform: "linux",
      env: {
        CODEX_AUTO_RESUME_ROOT: sidecarRoot,
        XDG_DATA_HOME: path.join(tmp, "data"),
      },
    };
    const identity = getCodexAccountIdentityContext(options);
    assert.equal(identity.activeProfileId, undefined);
    assert.match(identity.activeAccountFingerprint || "", /^[a-f0-9]{12}$/);

    const result = controlCodexAutoResume("dry-run", options);
    assert.equal(result.accountFingerprint, identity.activeAccountFingerprint);
    assert.equal(result.accountGuarded, true);
    assert.equal(result.unboundThreads, 1);
    assert.equal(result.mismatchedThreads, 0);
    assert.match(result.report, /dry-run waiting=0 blocked=1/);
    assert.equal(result.threads[0]?.threadId, threadId);
    assert.equal(result.threads[0]?.accountBinding, "unbound");
    assert.equal(result.threads[0]?.enabled, false);
    assert.equal(result.threads[0]?.status, "account-unbound");

    const accountRoot = path.join(tmp, "data", "vibcoding", "codex-auto-resume", "accounts");
    assert.equal(existsSync(path.join(accountRoot, identity.activeAccountFingerprint, "state.json")), true);
    assert.equal(existsSync(path.join(home, ".codex", "codex-router", "native-accounts", "accounts.json")), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Codex Auto Resume scopes quota/thread state by native account fingerprint", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-auto-resume-accounts-"));
  const home = path.join(tmp, "home");
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  const sidecarRoot = path.join(tmp, "sidecar");
  const controlDir = path.join(tmp, "data", "vibcoding", "codex-auto-resume");
  const threadA = "11111111-1111-4111-8111-111111111111";
  const threadB = "22222222-2222-4222-8222-222222222222";
  try {
    await mkdir(liveHome, { recursive: true });
    await mkdir(path.join(sidecarRoot, "src", "codex_auto_resume"), { recursive: true });
    await mkdir(controlDir, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-live")));
    await writeFile(path.join(sidecarRoot, "src", "codex_auto_resume", "__init__.py"), '__version__ = "0.2.2"\n');
    await writeFile(
      path.join(sidecarRoot, "run.py"),
      [
        "import sys",
        'cmd = sys.argv[1] if len(sys.argv) > 1 else ""',
        'if cmd == "once":',
        '    print("dry-run waiting=2")',
        '    print("  ' + threadA + ' usage-limit reset=None")',
        '    print("  ' + threadB + ' usage-limit reset=None")',
        'elif cmd == "doctor":',
        '    print("app_server OK ok")',
        'elif cmd in {"install-autostart", "uninstall-autostart"}:',
        '    print(cmd)',
        "",
      ].join("\n"),
    );

    const accountOptions = { home, env: {}, platform: "linux", desktopRunning: false };
    const added = await addCodexAccount("账号 B", {
      ...accountOptions,
      loginRunner: async (isolatedHome) => {
        await mkdir(isolatedHome, { recursive: true });
        await writeFile(path.join(isolatedHome, "auth.json"), JSON.stringify(accountTestAuth("acct-b", "b-login")));
      },
    });
    const accountB = added.profiles.find((profile) => profile.label === "账号 B");
    assert.ok(accountB);
    const contextA = getCodexAccountIdentityContext(accountOptions);
    const fingerprintA = contextA.activeAccountFingerprint;
    assert.ok(fingerprintA);

    await new Promise((resolve) => setTimeout(resolve, 8));
    switchCodexAccount(accountB.id, accountOptions);
    const contextB = getCodexAccountIdentityContext(accountOptions);
    const fingerprintB = contextB.activeAccountFingerprint;
    assert.ok(fingerprintB);
    assert.notEqual(fingerprintA, fingerprintB);
    assert.equal(contextB.activations.length >= 2, true);

    const activatedA = Date.parse(contextB.activations.find((entry) => entry.accountFingerprint === fingerprintA).activatedAt) / 1000;
    const activatedB = Date.parse(contextB.activations.find((entry) => entry.accountFingerprint === fingerprintB).activatedAt) / 1000;
    assert.ok(activatedB > activatedA);

    await writeFile(path.join(controlDir, "state.json"), JSON.stringify({
      version: 1,
      last_status: "reached:rate_limit_reached",
      last_quota_source: "app-server",
      last_checked_at: activatedB + 1,
      last_quota: { primary: { used_percent: 98 } },
      threads: {
        [threadA]: { thread_id: threadA, enabled: true, status: "waiting", observed_at: activatedA + 0.001, resumes: 0 },
        [threadB]: { thread_id: threadB, enabled: true, status: "waiting", observed_at: activatedB + 0.001, resumes: 0 },
      },
    }));

    const options = {
      home,
      platform: "linux",
      env: {
        CODEX_AUTO_RESUME_ROOT: sidecarRoot,
        XDG_DATA_HOME: path.join(tmp, "data"),
      },
    };
    const result = controlCodexAutoResume("dry-run", options);
    assert.equal(result.accountFingerprint, fingerprintB);
    assert.equal(result.accountGuarded, true);
    assert.match(result.stateDir, new RegExp("accounts[\\\\/]" + fingerprintB + "$"));
    assert.match(result.report, /dry-run waiting=1 blocked=1/);

    const current = result.threads.find((thread) => thread.threadId === threadB);
    const foreign = result.threads.find((thread) => thread.threadId === threadA);
    assert.equal(current?.accountBinding, "current");
    assert.equal(current?.enabled, true);
    assert.equal(foreign?.accountBinding, "other");
    assert.equal(foreign?.enabled, false);
    assert.equal(foreign?.status, "account-mismatch");

    const config = JSON.parse(await readFile(path.join(controlDir, "config.json"), "utf8"));
    assert.equal(path.resolve(config.state_dir), path.resolve(result.stateDir));
    const bindings = JSON.parse(await readFile(path.join(controlDir, "account-bindings.json"), "utf8"));
    assert.equal(bindings.threads[threadA].accountFingerprint, fingerprintA);
    assert.equal(bindings.threads[threadB].accountFingerprint, fingerprintB);

    const ipc = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
    assert.match(ipc, /pauseCodexAutoResumeForAccountSwitch/);
    assert.match(ipc, /restoreCodexAutoResumeAfterAccountSwitch/);
    assert.match(ipc, /bindCodexAutoResumeThread/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ChatGPT Web audited preflight patch is exact, deterministic, and narrow", () => {
  const before = Buffer.from("before timeoutMs: Math.min(options.timeoutMs || 15_000, 15_000) after", "utf8");
  const result = patchCodexChatGptWebPreflightBytes(before);
  assert.equal(result.changed, true);
  assert.equal(
    result.bytes.toString("utf8"),
    "before timeoutMs: Math.min(options.timeoutMs || 60_000, 60_000) after",
  );
  assert.equal(before.toString("utf8").includes("15_000"), true, "input must not be mutated");
  assert.equal(patchCodexChatGptWebPreflightBytes(Buffer.from("no signature")).changed, false);
  assert.throws(
    () => patchCodexChatGptWebPreflightBytes(Buffer.concat([before, before])),
    /not unique/,
  );
});

test("ChatGPT Web bridge stays loopback, pinned, and behind Codex Router", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "codex-chatgpt-web-"));
  const launcher = path.join(tmp, "Codex Web GPT.exe");
  const appHome = path.join(tmp, "chatgpt-web-home");
  const codexHome = path.join(tmp, "codex-home");
  const routerSecret = "do-not-expose-this-router-capability";
  await mkdir(path.join(appHome, "runtime"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(launcher, "test fixture\n", "utf8");
  await writeFile(
    path.join(appHome, "runtime", "launcher-supervisor.json"),
    JSON.stringify({
      ownerPid: process.pid,
      daemonPid: process.pid,
      status: "ready",
    }),
    "utf8",
  );
  await writeFile(
    path.join(codexHome, "config.toml"),
    `openai_base_url = "http://127.0.0.1:4202/_codex-router/${routerSecret}/v1"\n`,
    "utf8",
  );

  const snapshot = await getCodexChatGptWebSnapshot({
    platform: "win32",
    home: tmp,
    env: {
      CODEX_CHATGPT_WEB_LAUNCHER_PATH: launcher,
      CODEX_ROUTER_CHATGPT_WEB_MANAGED_ROOT: appHome,
      CODEX_HOME: codexHome,
    },
    fetchImpl: async () => ({ status: 200 }),
  });
  assert.equal(snapshot.installed, true);
  assert.equal(snapshot.auditedVersion, "5.0.8");
  assert.equal(snapshot.providerId, "chatgpt-web");
  assert.equal(snapshot.daemonEndpoint, "http://127.0.0.1:17841/v1");
  assert.equal(snapshot.home, appHome);
  assert.equal(snapshot.shadowCodexHome, path.join(appHome, "codex-home"));
  assert.equal(snapshot.launcherDataDir, path.join(appHome, "launcher"));
  assert.equal(snapshot.routeOwner, "router");
  assert.equal(snapshot.directRouteConflict, false);
  assert.equal(snapshot.safeToDiscover, true);
  assert.equal(snapshot.upstreamExternalProviderSupported, false);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(routerSecret));
  assert.match(snapshot.routeDisplay, /capability path redacted/);

  const conflict = classifyCodexRoute("http://127.0.0.1:17841/v1");
  assert.equal(conflict.owner, "chatgpt-web");

  const helper = await readFile(
    new URL("../apps/control-center/electron/codex-chatgpt-web.mjs", import.meta.url),
    "utf8",
  );
  assert.match(helper, /5\.0\.8/);
  assert.match(helper, /83224d59506462ab2976f437bfaea96b046d4ed55caa7e1cfd6a3d61de0a8ff3/);
  assert.match(helper, /127\.0\.0\.1:17841\/v1/);
  assert.match(helper, /CODEX_ROUTER_CHATGPT_WEB_MANAGED_ROOT/);
  assert.match(helper, /CODEX_WEB_GPT_LAUNCHER_DATA_DIR/);
  assert.match(helper, /MANAGED_START_GUARD_MS/);
  assert.match(helper, /shell: false/);
  assert.doesNotMatch(helper, /bridgeEnabled/);
  assert.doesNotMatch(helper, /integrationMode/);

  const provider = JSON.parse(
    await readFile(new URL("../config/chatgpt-web/chatgpt-web.json", import.meta.url), "utf8"),
  );
  assert.equal(provider.providers[0].id, "chatgpt-web");
  assert.equal(provider.providers[0].protocol, "openai-responses");
  assert.equal(provider.providers[0].baseUrl, "http://127.0.0.1:17841/v1");
  assert.equal(provider.providers[0].keyless, true);

  await rm(tmp, { recursive: true, force: true });
});

test("preload exposes only the named control operations", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  for (const method of [
    "getSnapshot",
    "getHarnesses",
    "getCodexSkillControl",
    "getCodexAutoResume",
    "getCodexChatGptWeb",
    "getContextSessions",
    "minimizeWindow",
    "toggleMaximizeWindow",
    "closeWindow",
    "setProviderEnabled",
    "discoverProviderModels",
    "addProviderModels",
    "connectProvider",
    "saveProviderCredential",
    "setSubagentEffort",
    "controlLocalRuntime",
    "installLocalMlx",
    "cancelLocalMlx",
    "setVisionBridgeEngine",
    "downloadVisionModel",
    "useLocalVisionModel",
    "benchmarkVisionModel",
    "setDefaultModel",
    "repairInstall",
    "setCodexContextMode",
    "setCodexSkillException",
    "launchHarness",
    "installHarness",
    "openHarnessSession",
    "openExternal",
  ]) {
    assert.match(source, new RegExp(`${method}\\s*:`));
  }
  assert.doesNotMatch(source, /runCommand|exec|spawn|argv/);
  assert.doesNotMatch(source, /runMaintenance/);
  assert.doesNotMatch(source, /setLoginFree/);
  assert.doesNotMatch(source, /typeof\s+\w+\s*===\s*"object"/);
});

test("preload constructs exact positional IPC payloads", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  const calls = [];
  let api;
  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "routerControl");
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (channel, input) => { calls.push([channel, input]); },
          on() {},
          removeListener() {},
        },
      };
    },
  });
  const cases = [
    ["discoverProviderModels", ["provider"], { providerId: "provider", refresh: false }],
    ["discoverProviderModels", ["provider", { refresh: true }], { providerId: "provider", refresh: true }],
    ["setProviderEnabled", ["provider", false], { providerId: "provider", enabled: false }],
    ["addProviderModels", ["provider", ["model-a", "model-b"]], { providerId: "provider", modelIds: ["model-a", "model-b"] }],
    ["connectProvider", ["provider"], { providerId: "provider" }],
    ["saveProviderCredential", ["provider", "credential"], { providerId: "provider", credential: "credential" }],
    ["removeProviderCredential", ["provider"], { providerId: "provider" }],
    ["setSubagentMode", ["proven"], { mode: "proven" }],
    ["setSubagentModel", ["model", true], { slug: "model", enabled: true }],
    ["setSubagentEffort", ["model", "xhigh"], { slug: "model", effort: "xhigh" }],
    ["setSubagentSelection", [false], { selectAll: false }],
    ["setPickerModel", ["model", false], { slug: "model", visible: false }],
    ["setPickerModels", [true], { showAll: true }],
    ["installLocalModel", ["model:latest", true], { tag: "model:latest", force: true, yes: true }],
    ["uninstallLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["setLocalModelEnabled", ["model:latest", false], { tag: "model:latest", enabled: false }],
    ["benchmarkLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["controlLocalRuntime", ["start"], { action: "start" }],
    ["installLocalMlx", [], { yes: true }],
    ["cancelLocalMlx", [], null],
    ["setVisionBridgeEnabled", [true], { enabled: true }],
    ["setVisionBridgeEngine", ["auto", "high"], { engine: "auto", effort: "high" }],
    ["setVisionBridgeEffort", ["high"], { effort: "high" }],
    ["downloadVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["useLocalVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["benchmarkVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["setToolResultAging", [true], { enabled: true }],
    ["setNativeToolResultAging", [false], { enabled: false }],
    ["setToolResultRetentionTtl", [7], { days: 7 }],
    ["setDefaultModel", ["model"], { slug: "model" }],
    ["setSignedRouting", [false], { enabled: false }],
    ["setPresence", ["always"], { mode: "always" }],
    ["controlService", ["start"], { action: "start" }],
    ["controlTray", ["status"], { action: "status" }],
    ["controlCodexAutoResume", ["doctor"], { action: "doctor" }],
    ["controlCodexChatGptWeb", ["start-managed"], { action: "start-managed" }],
    ["controlCodexChatGptWeb", ["show-managed"], { action: "show-managed" }],
    ["controlCodexChatGptWeb", ["start-daemon"], { action: "start-daemon" }],
    ["controlCodexChatGptWeb", ["stop-managed"], { action: "stop-managed" }],
    ["controlCodexChatGptWeb", ["verify-isolation"], { action: "verify-isolation" }],
    ["setCodexContextMode", ["light"], { mode: "light" }],
    ["setCodexSkillException", ["xiaohongshu-box", true], { skillName: "xiaohongshu-box", enabled: true }],
    ["launchHarness", ["codex", "app"], { harnessId: "codex", surface: "app" }],
    ["installHarness", ["deepcode"], { harnessId: "deepcode" }],
    ["openHarnessSession", ["codex", "session", "terminal", "model"], { harnessId: "codex", sessionId: "session", surface: "terminal", model: "model" }],
    ["openExternal", ["https://example.com"], { url: "https://example.com" }],
  ];
  for (const [method, args, expected] of cases) {
    await api[method](...args);
    const actual = calls.shift();
    assert.deepEqual(
      JSON.parse(JSON.stringify(actual)),
      [`router-control:${method}`, expected],
      method,
    );
  }
  assert.equal(calls.length, 0);
});

// The Control Center and the tray render the same health report through two
// separate implementations, so the pair has to be checked, not just one half
// (#366). apps/panel/model.mjs is exercised directly in
// test/panel-ui.test.mjs; this is the TypeScript twin.
test("the control center health rows match the tray's on absent and Grok dependencies", async () => {
  const source = await readFile(new URL("../apps/control-center/src/service-health.ts", import.meta.url), "utf8");

  // A router that answered `ok` has already probed every dependency it knows
  // about, so an id missing from `degraded` is Ready rather than Unknown.
  assert.match(source, /routerOk\?: boolean/);
  assert.match(source, /if \(!offline && routerOk === true\) \{[\s\S]*?state: "ready"/);
  assert.match(source, /dependencyRow\("gateway", "Gateway", health\?\.gateway, degraded, routerOk\)/);

  // The Grok OAuth forwarder is a fifth local port with its own probe, and
  // both surfaces enumerate forwarders explicitly, so it has to be listed.
  assert.match(source, /\["grokOauth", "Grok OAuth forwarder"\]/);
  const types = await readFile(new URL("../apps/control-center/src/types.ts", import.meta.url), "utf8");
  assert.match(types, /grokOauth\?: RouterServiceHealth;/);
});

test("control center sidebar keeps the requested product order", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const navBlock = source.match(/const NAV_ITEMS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(navBlock, "NAV_ITEMS block should be readable");
  const ids = [...navBlock.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["dashboard", "usage", "status", "models", "local", "harness", "context", "settings"]);
  assert.doesNotMatch(navBlock, /deferred|Soon/);
  assert.match(navBlock, /label: "Models"/);

  const status = await readFile(new URL("../apps/control-center/src/pages/StatusPage.tsx", import.meta.url), "utf8");
  // Settings remains the only page that renders the diagnostic report; Status
  // may start a repair but must not grow a doctor surface of its own.
  assert.doesNotMatch(status, /doctor/i);
  assert.match(status, /api\.repairInstall\(\)/);
  assert.match(status, /<ServiceHealthPanel[^>]*onRepair=/);

  // Repair is offered on this panel only while a service actually needs it, so
  // a healthy router never shows a maintenance button beside its green badge.
  const serviceHealth = await readFile(new URL("../apps/control-center/src/ServiceHealth.tsx", import.meta.url), "utf8");
  assert.match(serviceHealth, /\{onRepair && attention \?/);

  const usage = await readFile(new URL("../apps/control-center/src/pages/UsagePage.tsx", import.meta.url), "utf8");
  assert.match(usage, /ChatGPT · measured by this router/);
  assert.match(usage, /ChatGPT account · reported by OpenAI/);
  assert.match(usage, /excludes account usage/);
  assert.match(usage, /This router total is the sum of every measured provider row/);
  assert.match(usage, /Account-reported · excluded from router total/);
  assert.match(usage, /regularInputTokens/);
  assert.match(usage, /cachedInputTokens/);
  assert.match(usage, /outputTokens/);
  assert.match(usage, /All retained/);
  assert.match(usage, /scopeLabel/);
  assert.match(usage, /is-regular/);
  assert.match(usage, /is-cached/);
  assert.match(usage, /is-output/);
  assert.match(usage, /ChartTooltip/);
  assert.match(usage, /aria-label=\{label\}/);
  assert.match(usage, /Regular input|regular input/);
  const usageStyles = await readFile(new URL("../apps/control-center/src/pages/usage-status.css", import.meta.url), "utf8");
  assert.match(usageStyles, /--token-regular/);
  assert.match(usageStyles, /--token-cached/);
  assert.match(usageStyles, /--token-output/);
  assert.match(usageStyles, /\.us-token-mix > div \{[\s\S]*border-right/);
  assert.doesNotMatch(usageStyles, /\.us-token-mix > div \{[^}]*border-radius/);
  assert.match(usageStyles, /\.us-chart-tooltip/);
  assert.match(usageStyles, /white-space: normal|text-transform: capitalize/);
  assert.match(usageStyles, /data-edge="start"|data-edge/);
  const dashboard = await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /db-trend-stack/);
  assert.match(dashboard, /TrafficTooltip/);
  assert.match(dashboard, /tabIndex=\{0\}/);
  assert.match(dashboard, /Token activity/);
  assert.match(dashboard, /TOKEN_ACTIVITY_WEEKS = 53/);
  assert.match(dashboard, /providerUsage\?\.retained\?\.providers/);
  assert.match(dashboard, /\["daily", "weekly", "cumulative"\]/);
  assert.match(dashboard, /role="gridcell"/);
  assert.match(dashboard, /db-token-tooltip/);
  assert.doesNotMatch(dashboard, /title="Routing mode"/);
  assert.doesNotMatch(dashboard, /Credentials on file and routes in use/);
  assert.doesNotMatch(dashboard, /title="Catalog readiness"/);
  assert.doesNotMatch(dashboard, /title="Context reused, 24h"/);
  const dashboardStyles = await readFile(new URL("../apps/control-center/src/pages/dashboard.css", import.meta.url), "utf8");
  assert.match(dashboardStyles, /--token-regular/);
  assert.match(dashboardStyles, /--token-cached/);
  assert.match(dashboardStyles, /--token-output/);
  assert.match(dashboardStyles, /\.db-trend-tooltip/);
  assert.match(dashboardStyles, /\.db-token-cells/);
  assert.match(dashboardStyles, /grid-template-columns: repeat\(53, minmax\(var\(--db-token-min-cell\), 1fr\)\)/);
  assert.match(dashboardStyles, /\.db-token-day\.level-4/);
  assert.match(dashboardStyles, /\.db-token-tooltip/);
  assert.match(dashboardStyles, /border-radius: 0/);
});

test("settings keeps model choice out and exposes durable app preferences", async () => {
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  // Default model selection belongs to the catalog page. Settings owns the
  // router switches and renderer-local preferences, so it must not grow a
  // second model-choice control as the catalog evolves.
  assert.doesNotMatch(settings, /setDefaultModel|default model/i);
  assert.match(settings, /settings\.language\.title/);
  assert.match(settings, /settings\.context\.enable\.title/);
  assert.match(settings, /settings\.vision\.title/);
  assert.match(settings, /setToolResultAging\(/);
  assert.match(settings, /setNativeToolResultAging\(/);
  assert.match(settings, /setToolResultRetentionTtl\(/);
  assert.match(settings, /setVisionBridgeEnabled\(/);
  assert.match(settings, /setVisionBridgeEngine\(/);
  assert.match(settings, /setVisionBridgeEffort\(/);
  assert.doesNotMatch(settings, /runMaintenance/);
  assert.doesNotMatch(settings, /setLoginFree/);
  // Repair used to be terminal-only. It is an in-app button now, but it still
  // reinstalls and restarts the service, so it stays behind a confirmation and
  // it must not become a one-click control that fires on the first press.
  assert.match(settings, /api\.repairInstall\(\)/);
  assert.match(settings, /setConfirmRepair\(true\)/);
  assert.match(settings, /settings\.maintenance\.confirm\.body/);
  assert.doesNotMatch(settings, /controlService\("(?:stop|restart)"\)/);

  const i18n = await readFile(new URL("../apps/control-center/src/i18n.ts", import.meta.url), "utf8");
  assert.match(i18n, /settings\.language\.title/);
  assert.match(i18n, /settings\.context\.enable\.title/);
  assert.match(i18n, /settings\.vision\.title/);
  assert.doesNotMatch(i18n, /settings\.routing\.modelNote/);
  // Every locale is an overlay over EN, so a repair string that only exists in
  // English silently renders English inside an otherwise translated dialog.
  for (const key of [
    "settings.maintenance.fixRunning",
    "settings.maintenance.fixDone",
    "settings.maintenance.fixIncomplete",
    "settings.maintenance.confirm.title",
    "settings.maintenance.confirm.body",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
  }
  // Sharing is an authorization to spend the user's subscription, so its
  // confirmation and live state cannot silently fall back to English.
  for (const key of [
    "settings.chatgptSession.title",
    "settings.chatgptSession.detail",
    "settings.chatgptSession.confirm.title",
    "settings.chatgptSession.confirm.description",
    "settings.chatgptSession.confirm.body",
    "settings.chatgptSession.confirm.enable",
    "settings.chatgptSession.status.sharingEnabled",
    "settings.chatgptSession.status.sharingDisabled",
    "settings.chatgptSession.status.unavailable",
    "settings.chatgptSession.status.loginUsable",
    "settings.chatgptSession.status.loginUsableHours",
    "settings.chatgptSession.status.loginExpired",
    "settings.chatgptSession.status.loginUnavailableDetected",
    "settings.chatgptSession.status.loginUnavailableLogin",
    "settings.chatgptSession.action.enable",
    "settings.chatgptSession.action.disable",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
  }
  for (const key of [
    "settings.desktop.unavailable.title",
    "settings.desktop.unavailable.body",
  ]) {
    const occurrences = i18n.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 6, `${key} must be translated in all six locales`);
    assert.ok(settings.includes(`t("${key}")`), `${key} must be rendered through the translator`);
  }
  assert.doesNotMatch(settings, /["`]Sharing (?:enabled|disabled|status unavailable)/);
  assert.doesNotMatch(settings, /["`]Login (?:usable|expired|unavailable)/);
  assert.doesNotMatch(settings, /Tray supervision controls unavailable|no supported OS supervision contract/);
});

test("the model directory groups picker models by provider and keeps live curation provider-scoped", async () => {
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const catalogSearch = await readFile(new URL("../apps/control-center/src/model-catalog-search.mjs", import.meta.url), "utf8");
  const providerModelsCss = await readFile(new URL("../apps/control-center/src/pages/providers-models.css", import.meta.url), "utf8");
  assert.match(models, /aria-expanded=\{expanded\}/);
  assert.match(models, /aria-controls=\{panelId\}/);
  assert.match(models, /hidden=\{!expanded\}/);
  assert.match(models, /setExpandedFamilyId\(expandedFamilyId === family\.id \? null : family\.id\)/);
  assert.match(models, /saveProviderCredential/);
  assert.match(models, /setProviderEnabled/);
  assert.match(models, /setPickerModel/);
  assert.match(models, /"Show all router models", \(\) => api\.setPickerModels\(true\)/);
  assert.match(models, /<span>Turn all on<\/span>/);
  assert.match(models, /<span>Turn all off<\/span>/);
  assert.match(models, /invalidateCatalogs\(\);[\s\S]{0,180}try \{[\s\S]*finally \{\s*invalidateCatalogs\(\)/);
  assert.match(models, /const generation = beginCatalogRequest/);
  assert.match(models, /catalogRequestIsCurrent\(catalogRequestGenerations\.current, sourceId, generation\)/);

  // One page, one list. Provider accounts live in a connections strip whose
  // chips open the credential controls, so nothing competes with the models
  // for the reader's attention.
  assert.match(models, /className="panel-section pm-connections"/);
  assert.match(models, /className="pm-chip"/);
  assert.match(models, /className="pm-connection-menu"/);
  assert.match(models, /\{connected\.length\} of \{directory\.length\} connected/);
  assert.match(models, /Connect provider/);
  assert.doesNotMatch(models, /className="pm-provider-row"|className="pm-provider-summary"/);
  assert.doesNotMatch(models, /<StatStrip/);
  assert.match(providerModelsCss, /\.pm-connections\s*\{/);
  assert.match(providerModelsCss, /\.pm-chip\s*\{/);
  assert.match(providerModelsCss, /\.pm-connection-menu\s*\{/);

  // Provider identity is a Control Center grouping boundary rather than part
  // of Codex model displayName. Protocol variants fold into their canonical
  // provider section, while row order remains independent of toggle state.
  assert.match(models, /function providerGroupId\(/);
  assert.match(models, /const providerGroups = useMemo<PickerProviderGroup\[\]>/);
  assert.match(models, /groupModelFamilies\(routes\)/);
  assert.match(models, /const rows = useMemo\(\(\) => filteredFamilies\.map/);
  assert.match(models, /const visibleProviderGroups = useMemo/);
  assert.match(models, /className="pm-picker-provider-group"/);
  assert.match(models, /data-provider=\{group\.id\}/);
  assert.match(providerModelsCss, /\.pm-provider-picker-groups\s*\{/);
  assert.match(providerModelsCss, /\.pm-picker-provider-heading\s*\{/);

  // The switch states its own value, and the disclosure sits at the far left
  // so it cannot read as part of that switch.
  assert.match(models, /className="pm-family-state" aria-hidden>\{on \? "On" : "Off"\}/);
  assert.match(models, /<ChevronDown className="pm-accordion-chevron"[\s\S]{0,80}<BrandLogo/);
  assert.match(providerModelsCss, /\.pm-family-open \{[^}]*grid-template-columns: 14px 38px/s);

  // A short list reads whole; filters and bulk switches only appear once it
  // is long enough to need them.
  assert.match(models, /const CROWDED_LIST = 8/);
  assert.match(models, /const crowded = rows\.length > CROWDED_LIST/);
  // The count describes the visible list, not the whole catalogue.
  assert.match(models, /modelSearch \|\| statusFilter !== "all"[\s\S]{0,120}visibleRows\.length/);
  assert.match(models, /\{crowded \? \(/);
  assert.match(models, /aria-label="More model actions"/);

  // The provider chip follows the same judgement, counted in providers rather
  // than rows, and composes with the search and status filters instead of
  // replacing them.
  assert.match(models, /const CROWDED_PROVIDERS = 3/);
  assert.match(models, /const providerCrowded = filterProviders\.length > CROWDED_PROVIDERS/);
  assert.match(models, /\{providerCrowded \? \([\s\S]{0,400}className="pm-filter-trigger"/);
  assert.match(models, /aria-label="Filter models by provider"/);
  assert.match(models, /role="menuitemradio"\s*aria-checked=\{activeProviderFilter === entry\.id\}/);
  assert.match(models, /activeProviderFilter !== "all" && family\.providerGroupId !== activeProviderFilter/);
  assert.match(models, /modelSearch \|\| statusFilter !== "all" \|\| activeProviderFilter !== "all"[\s\S]{0,120}visibleRows\.length/);
  // A chip that is no longer rendered must not keep the list narrowed.
  assert.match(models, /const activeProviderFilter = providerCrowded && filterProviders\.some/);
  assert.match(providerModelsCss, /\.pm-provider-filter-menu\s*\{/);

  // Nothing to connect means nothing to browse, so the page asks for that
  // first instead of showing an empty list behind a disabled button.
  assert.match(models, /title="Connect a provider to get started"/);

  // A single-route model already showed its identity in the row above, so the
  // panel carries only what the summary left out.
  assert.match(models, /function ModelDetails\(/);
  // Two cells, so a route stays one row: stacking the switch and the effort
  // menu doubled every row's height and repeated "Thinking" down the list.
  assert.match(models, /function SubagentToggle\(/);
  assert.match(models, /function SubagentEffort\(/);
  assert.match(models, /<span>Thinking<\/span>/);
  assert.match(providerModelsCss, /grid-template-columns: minmax\(0, 1fr\) 78px 92px 70px 74px 104px/);
  // The effort control uses this page's own menu: a native select's popup is
  // shifted by the macOS checkmark gutter, which reads as misaligned in a table.
  assert.match(providerModelsCss, /\.pm-effort-menu \{/);
  assert.match(models, /className="pm-effort-trigger"/);
  assert.doesNotMatch(models, /<select[\s\S]{0,200}subagent thinking effort/);
  assert.match(models, /<dt>Model id<\/dt>/);
  assert.match(providerModelsCss, /\.pm-model-details\s*\{/);

  // Adding republishes the whole catalog to every installed client and is the
  // slowest thing this page starts. Placeholder rows carrying the chosen slugs
  // stand in meanwhile, or the click reads as having done nothing at all.
  assert.match(models, /setPendingModels\(\(current\) => addPendingCatalogModels\(current, entry\.id, selected\)\)/);
  assert.match(models, /<PendingModelRows slugs=\{pendingSlugs\} \/>/);
  assert.match(models, /<small>Adding…<\/small>/);
  // Cleared in a finally: a placeholder surviving a failed add would claim the
  // model arrived.
  assert.match(models, /\} finally \{[\s\S]{0,400}setPendingModels\(/);
  // A slug already in the picker gets no ghost row beside its real one.
  assert.match(models, /pendingCatalogModelIds\(pendingModels, entry\.id\)[\s\S]{0,160}!entry\.models\.some/);
  assert.match(models, /removePendingCatalogModels\(current, entry\.id, selected\)/);
  // The placeholder must hold the real row's geometry so the list does not jump
  // when the add lands.
  assert.match(providerModelsCss, /\.pm-model-row-pending/);
  assert.match(providerModelsCss, /\.pm-pending-control/);
  assert.match(models, /setSubagentModel/);
  assert.match(models, /setSubagentEffort/);
  // The registry is the only thing that can make a route a subagent, so the
  // page offers the switch or says nothing -- never a test that cannot change
  // the outcome.
  assert.match(models, /function subagentControl\(/);
  // One switch, one meaning, for every route: use this as a subagent or do
  // not. No certification state to decode in front of a model choice.
  // The certification states are gone; the muted dash survives as the empty
  // Thinking cell, which is a different thing entirely.
  assert.doesNotMatch(models, /kind: "certifiable"|kind: "unsupported"/);
  assert.doesNotMatch(models, /"Test v2"|>v1 only<|Test subagents|Untested|Awaiting certification|Certification candidate/);
  assert.doesNotMatch(models, /proof\?\.status/);

  // Turning the switch on adds the route to the subagent selection; the
  // router publishes it as v2 with an agent definition Codex can spawn. There
  // is no certification run behind the switch.
  assert.match(models, /function subagentControl\(/);
  assert.match(models, /checked: selectedInSettings/);
  assert.doesNotMatch(models, /certifySubagentModels\(slugs\)/);
  assert.doesNotMatch(models, /certifyBatch/);
  assert.doesNotMatch(models, /Couldn't check/);

  // Adding is provider-first: opening the dialog must not fan out to every
  // account. The operator picks one provider, refreshes that catalog, and can
  // add a compatible model directly or keep the batch path.
  assert.match(models, /function AddModelsDialog\(/);
  assert.match(models, /loadedCatalogModels\(providerDirectory, catalogStates\)/);
  assert.match(models, /className="pm-add-models-provider-tab"/);
  assert.match(models, /Fetch model list/);
  assert.match(models, /Refresh model list/);
  assert.match(models, /const CATALOG_ADD_BATCH_LIMIT = 200/);
  assert.match(models, /selected\.length >= CATALOG_ADD_BATCH_LIMIT/);
  assert.match(models, /const blocked = !model\.registered && !model\.addable/);
  assert.match(models, /Verify & add/);
  assert.match(models, /verifyProviderModel\(model\.sourceId, model\.modelId\)/);
  assert.match(models, /pm-catalog-block-reason/);
  assert.match(models, /onAdd\(\[model\]\)/);
  assert.match(models, /Show 120 more/);
  assert.doesNotMatch(models, /Search every connected provider|Load connected catalogs/);
  // Provider discovery is scoped to the chosen account and explicit refresh.
  assert.match(models, /const loadProviderCatalogs = async/);
  assert.match(models, /const entry = directoryById\.get\(providerId\)/);
  assert.match(models, /refresh \|\| \(catalogStates\[sourceId\]\?\.status \?\? "idle"\) === "idle"/);
  assert.match(models, /discoverProviderModels\(sourceId, \{ refresh \}\)/);
  assert.match(models, /onLoadProvider=\{\(providerId, options\) => void loadProviderCatalogs\(providerId, options\)\}/);
  // A stored list can be a day old, so the selected provider says when it was read.
  assert.match(models, /read \$\{formatDateTime\(lastRead\)\}/);
  assert.match(models, /Select one provider at a time/);
  assert.match(providerModelsCss, /\.pm-add-models\s*\{/);
  assert.match(providerModelsCss, /\.pm-add-models-providers\s*\{/);
  assert.match(providerModelsCss, /\.dialog-panel:has\(\.pm-add-models\)/);
  assert.match(providerModelsCss, /\.pm-filter-menu-wrap\s*\{/);
  assert.match(providerModelsCss, /\.pm-filter-menu\s*\{/);
  assert.doesNotMatch(providerModelsCss, /\.pm-model-layout\s*\{/);
  // The removed provider accordion must not leave its styles behind.
  assert.doesNotMatch(providerModelsCss, /\.pm-live-catalog|\.pm-catalog-search-row|\.pm-provider-detail/);
  assert.match(models, /const effortOptions = model\.reasoningLevels \?\? \[\]/);
  assert.doesNotMatch(models, /reasoningLevels\?\.map\(\(level\) => level\.effort\)/);
  assert.doesNotMatch(models, /<dt>Available<\/dt>/);
  assert.match(catalogSearch, /export function catalogModelName\(modelId\)/);
  assert.doesNotMatch(catalogSearch, /if \(modelId === "x-preview-f-free"\)/);

  const components = await readFile(new URL("../apps/control-center/src/components.tsx", import.meta.url), "utf8");
  assert.match(components, /export function SkeletonBlock/);
  assert.match(components, /export function CatalogSkeleton/);
  assert.match(components, /export function PanelSkeleton/);
  assert.match(components, /app-loading-skeleton/);
  assert.match(components, /createPortal\([\s\S]*document\.body\)/);
  assert.match(components, /element\.inert = true/);
  assert.match(components, /panel\.focus\(\{ preventScroll: true \}\)/);
  assert.match(components, /event\.key === "Escape"/);
  assert.match(components, /event\.key !== "Tab"/);
  assert.match(components, /previouslyFocused\?\.isConnected/);
  const appStyles = await readFile(new URL("../apps/control-center/src/styles.css", import.meta.url), "utf8");
  assert.match(appStyles, /\.skeleton-block::after/);
  assert.match(appStyles, /@keyframes skeleton-sweep/);
  assert.match(appStyles, /prefers-reduced-motion:[\s\S]*\.skeleton-block::after/);

  const branding = await readFile(new URL("../apps/control-center/src/provider-branding.tsx", import.meta.url), "utf8");
  assert.match(branding, /assets\/providers\/commandcode\.svg/);
  assert.match(branding, /commandcode:[^\n]+logoMode: "artwork"/);
  for (const asset of ["cognition", "deepreinforce", "kilo", "lmstudio", "poolside", "tencent"]) {
    assert.match(branding, new RegExp(`assets/providers/${asset}\\.svg`), `${asset} logo is not bundled`);
  }
  for (const providerId of [
    "devin-cli", "kilo-free", "kimi-api-cn", "opencode-free",
    "xiaomi-mimo", "zai-api",
  ]) {
    assert.match(branding, new RegExp(`"${providerId}":`), `${providerId} falls back to a monogram`);
  }
  assert.match(branding, /"lmstudio": "lmstudio"/);
  assert.match(branding, /ornith[^\n]+BRANDS\.deepreinforce/);
  assert.match(branding, /hy3[^\n]+BRANDS\.tencent/);
  assert.match(branding, /laguna[^\n]+BRANDS\.poolside/);
  assert.match(branding, /export function brandForLocalModel/);
  const sources = await readFile(new URL("../apps/control-center/src/assets/providers/SOURCES.md", import.meta.url), "utf8");
  assert.match(sources, /commandcode\.ai\/brand/);
  assert.match(sources, /CommandCodeAI\/command-code[^\s|]+\/symbol\.svg/);
  assert.match(sources, /lmstudio\.ai\/brand/);
  assert.match(sources, /CognitionAI\/devin-extension[^|]+devin-full-color\.png/);
  assert.match(sources, /ornith-ai\/Ornith-1[^|]+ornith_logo\.png/);
  assert.doesNotMatch(sources, /avatars\.githubusercontent\.com/);
  assert.match(branding, /cognition:[^\n]+name: "Devin"/);
  assert.match(branding, /deepreinforce:[^\n]+name: "Ornith"/);
  const local = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  assert.match(local, /brandForLocalModel/);
  assert.match(local, /<BrandLogo brand=\{brandForLocalModel\(model\)\}/);
  assert.match(local, /<BrandLogo brand=\{maker\} size="medium" \/>/);
  assert.match(local, /<span>\{maker\.name\}<\/span>/);
  assert.match(local, /<small>\{`local\/\$\{model\.tag\}`\}<\/small>/);
});

test("persisted Electron toggles render optimistic intent and reconcile failures", async () => {
  const helper = await readFile(new URL("../apps/control-center/src/useOptimisticValues.ts", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const local = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");

  // Paint intent before entering the serialized durable-write queue. The
  // wrapped action distinguishes a rejected save even though App.runAction
  // converts failures into a toast instead of rethrowing them.
  assert.ok(helper.indexOf("setOverrides((current) => new Map([...current, ...desired]))") < helper.indexOf("queue.current.catch"));
  assert.match(helper, /let saved = false;[\s\S]*await action\(\);[\s\S]*saved = true;/);
  assert.match(helper, /revisions\.current\.get\(key\) !== revision/);
  assert.match(helper, /Object\.is\(authoritative\.get\(key\), optimistic\)/);

  assert.match(models, /optimisticProviders\.mutate\(/);
  assert.match(models, /optimisticPicker\.mutateMany\(/);
  assert.match(models, /optimisticSubagents\.mutate\(/);
  assert.match(local, /optimisticLocalModels\.mutate\(/);
  assert.match(local, /optimisticVision\.mutate\(/);
  for (const key of ["signed-routing", "tool-result-aging", "native-tool-result-aging", "vision-bridge"]) {
    assert.match(settings, new RegExp(`optimisticToggles\\.mutate\\(\\"${key}\\"`));
  }
});

test("providers and models share one provider-first Models destination without tabs", async () => {
  const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const types = await readFile(new URL("../apps/control-center/src/types.ts", import.meta.url), "utf8");
  const viewType = types.match(/export type ViewId =[\s\S]*?;/)?.[0] || "";

  assert.match(app, /case "models": return <ModelsPage/);
  assert.doesNotMatch(app, /case "providers"|ProvidersModelsPage|ProvidersPage/);
  assert.match(viewType, /\| "models"/);
  assert.doesNotMatch(viewType, /\| "providers"/);
  assert.doesNotMatch(models, /role="tablist"|role="tabpanel"|pm-section-switcher/);
  assert.match(app, /stored === "models" \|\| stored === "providers"/);
  assert.match(app, /focusRequest=\{modelFocusRequest\}/);
  assert.match(models, /model-provider-directory/);
  assert.match(models, /model-catalog-controls/);
  const dashboard = await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(dashboard, /onNavigate\("models", "providers"\)/);
  assert.doesNotMatch(dashboard, /onNavigate\("models", "models"\)/);
});

test("control center focus feedback uses state changes without focus rings", async () => {
  const styleUrls = [
    "../apps/control-center/src/styles.css",
    "../apps/control-center/src/pages/dashboard.css",
    "../apps/control-center/src/pages/providers-models.css",
    "../apps/control-center/src/pages/usage-status.css",
    "../apps/control-center/src/search-dialog.css",
  ];
  const styles = (await Promise.all(styleUrls.map((url) => readFile(new URL(url, import.meta.url), "utf8")))).join("\n");

  assert.doesNotMatch(styles, /outline:\s*2px/);
  assert.doesNotMatch(styles, /box-shadow:\s*0 0 0/);
  assert.match(styles, /:where\(button, \[tabindex\]\):focus-visible[\s\S]*?background-color/);
  assert.match(styles, /:where\(input, select, textarea\):focus-visible[\s\S]*?border-color/);
  assert.match(styles, /\.toggle input:focus-visible \+ span[\s\S]*?border-color/);
  assert.match(styles, /\.db-trend-slot:focus-visible[\s\S]*?background/);
});

test("harness and context IPC remain fixed and session-scoped", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const HARNESS_IDS = \["codex", "deepcode"\]/);
  assert.match(source, /const HARNESS_SURFACES = \["app", "terminal"\]/);
  assert.match(source, /const SESSION_UUID = \/\^\[0-9a-f\]/);
  assert.match(source, /const DEEPCODE_PACKAGE = "@vegamo\/deepcode-cli"/);
  assert.match(source, /oneOf\(harnessId, HARNESS_IDS, "Harness"\)/);
  assert.match(source, /stringValue\(sessionId, "Session", SESSION_UUID\)/);
  assert.match(source, /codex:\/\/threads\/\$\{id\}/);
  assert.doesNotMatch(source, /readFileSync\(deepcodeSettings/);
});

test("Antigravity Control Center sign-in uses router browser OAuth and persists its client secret over stdin", async () => {
  const ipc = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("../src/provider-onboarding.mjs", import.meta.url), "utf8");

  const connect = ipc.match(/handleAction\("connectProvider"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(connect, "connectProvider handler should be readable");
  assert.match(connect, /id === "antigravity-oauth"/);
  assert.match(connect, /runControl\(\["login", id\]/);
  assert.match(connect, /CODEX_ROUTER_BROWSER_OPEN: "0"/);
  assert.match(connect, /onStdout:/);
  assert.match(connect, /accounts\\\.google\\\.com/);
  assert.match(connect, /Antigravity OAuth callback ready\./);
  assert.match(connect, /shell\.openExternal\(authorizationHref\)/);
  assert.ok(connect.indexOf('id === "antigravity-oauth"') < connect.indexOf("terminalAvailable()"));
  assert.doesNotMatch(connect.match(/if \(id === "antigravity-oauth"\)[\s\S]*?\n    }/)?.[0] || "", /install-cli/);

  const save = ipc.match(/handleAction\("saveProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(save, "credential-save handler should be readable");
  assert.match(save, /antigravity-client-secret\.mjs/);
  assert.match(save, /stdin: credential/);

  assert.match(onboarding, /clientSecretConfigured: clientSecret\.configured/);
  assert.match(models, /entry\.id === "antigravity-oauth" && !entry\.setup\.clientSecretConfigured/);
  assert.match(models, /credentialLabel: "OAuth client secret"/);
  assert.match(models, /await api\.saveProviderCredential\(provider\.id, secret\);[\s\S]*await api\.connectProvider\(provider\.id\);/);
  assert.match(models, /platform !== "darwin" && entry\.id !== "antigravity-oauth"/);
  const modelRowConnect = models.match(/onConnect=\{\(providerId\) => \{[\s\S]*?\n      \}\}/)?.[0] || "";
  assert.match(modelRowConnect, /entry\.id === "antigravity-oauth"/);
  assert.match(modelRowConnect, /!entry\.setup\.clientSecretConfigured[\s\S]*setCredentialProvider/);
  assert.match(modelRowConnect, /runProviderCredentialAction\([\s\S]*api\.connectProvider\(entry\.id\)/);
  assert.ok(modelRowConnect.indexOf('entry.id === "antigravity-oauth"') < modelRowConnect.indexOf("openProviderMenu(entry.id)"));

  const runner = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /onStdout/);
  assert.match(runner, /observed\.catch/);
});

test("credential input stays off argv and is delivered over stdin", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "router-control-center-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const secret = "test-only-secret-value";
  try {
    await mkdir(path.join(temporaryRoot, "src"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "bin"), { recursive: true });
    await writeFile(
      path.join(temporaryRoot, "src", "control.mjs"),
      "let input = ''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(temporaryRoot, "bin", "control"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.join(temporaryRoot, "bin", "control"), 0o700);
    process.env.CODEX_ROUTER_SOURCE_ROOT = temporaryRoot;
    const result = await runControlJson(["credential", "demo"], { stdin: secret });
    assert.deepEqual(result.argv, ["credential", "demo"]);
    assert.equal(result.input, secret);
    assert.equal(result.argv.includes(secret), false);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("provider writes republish all installed targets and roll selection back on apply failure", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /updateProviderSelection\(id, enabled/);
  const toggle = source.match(/async function updateProviderSelection[\s\S]*?\n}/)?.[0];
  assert.ok(toggle, "provider toggle helper should be readable");
  assert.match(toggle, /\["set-apply", id, enabled \? "on" : "off"\]/);
  assert.match(toggle, /shared by every installed[\s\S]*client/);
  assert.match(toggle, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.doesNotMatch(toggle, /\["set"|\["apply"|before\.has/);
  assert.match(source, /runJson\(\["credential", id\], \{[\s\S]{0,80}stdin: credential/);
  const save = source.match(/handleAction\("saveProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(save, "credential-save handler should be readable");
  assert.doesNotMatch(save, /updateProviderSelection/);
  assert.match(save, /CATALOG_MUTATION_TIMEOUT_MS/);
  const removal = source.match(/handleAction\("removeProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(removal, "credential-removal handler should be readable");
  assert.doesNotMatch(removal, /updateProviderSelection/);
  assert.match(removal, /\["credential", id, "--remove"\]/);
  assert.match(removal, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /if \(requiresCompatibleRouter\) assertMutationCompatibility\(\)/);

  // Repair runs the CLI's own `doctor --fix` and takes no renderer arguments,
  // so the installer decides what is rewritten. It must stay exempt from the
  // compatibility gate: a protocol mismatch is the damage repair undoes, and
  // gating it there would withhold the fix exactly when it is needed. It also
  // must tolerate a non-zero exit, which means "repaired, checks still fail"
  // and carries the report the page needs to name them.
  const repair = source.match(/handleAction\("repairInstall"[\s\S]*?\n  \}, \{[^}]*\}\);/)?.[0];
  assert.ok(repair, "repair handler should be readable");
  assert.match(repair, /runRouterScript\("doctor\.mjs", \["--fix", "--json"\]/);
  assert.match(repair, /allowNonZero: true/);
  assert.match(repair, /REPAIR_TIMEOUT_MS/);
  assert.match(repair, /CODEX_ROUTER_DEFER_TRAY_REBUILD: "1"/);
  assert.match(repair, /\} finally \{[\s\S]*await runControlDetached/);
  assert.match(repair, /runControlDetached\(\["tray", "refresh"\]\)/);
  assert.doesNotMatch(repair, /setTimeout/);
  assert.ok(
    repair.indexOf('await runControlDetached(["tray", "refresh"])') < repair.indexOf("return response"),
    "the detached refresh must start before repair releases its mutation drain",
  );
  assert.match(repair, /requiresCompatibleRouter: false/);

  assert.doesNotMatch(source, /apply\s*=/);
  assert.doesNotMatch(source, /handleAction\("setLoginFree"/);

  // Browsing a provider is answered from its stored list, but committing a
  // model to the picker is checked against what the provider serves now: a
  // stored list old enough to name a withdrawn model would otherwise curate a
  // route that fails on its first real request.
  const add = source.match(/handleAction\("addProviderModels"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(add, "model-add handler should be readable");
  assert.match(add, /\[id, "--models", unique\.join\(","\), "--refresh", "--apply"\]/);
  assert.match(add, /CATALOG_MUTATION_TIMEOUT_MS/);

  // Replacing a credential can mean a different account with a different
  // entitlement, so neither save nor removal may leave the old list behind.
  const control = await readFile(new URL("../src/control.mjs", import.meta.url), "utf8");
  for (const handler of ["saveProviderCredential", "deleteProviderCredential"]) {
    const body = control.match(new RegExp(`async function ${handler}[\\s\\S]*?\\n}`))?.[0];
    assert.ok(body, `${handler} should be readable`);
    assert.match(body, /withProviderCatalogCacheTransaction/);
    assert.match(body, /catalog\.forget\(providerCatalogFamilyCacheIds\(providerId\)\)/);
  }
});

test("catalog-backed mutations outlive the publication-lock wait", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const CATALOG_MUTATION_TIMEOUT_MS = 330_000/);
  assert.match(source, /\["set-apply"[\s\S]{0,180}timeoutMs: CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSubagentMode"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSubagentEffort"[\s\S]{0,320}\["subagents", "effort", model, effort\][\s\S]{0,120}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setPickerModel"[\s\S]{0,320}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setVisionBridgeEnabled"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSignedRouting"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
});

test("service IPC exposes only safe beta actions and start covers readiness", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const SERVICE_COMMANDS = \["status", "start"\]/);
  assert.match(source, /value === "start" \? 330_000 : 120_000/);
  assert.match(source, /runControl\(\["service", value\], \{ timeoutMs \}\)/);
  const api = await readFile(new URL("../apps/control-center/electron/api.d.ts", import.meta.url), "utf8");
  assert.match(api, /type ServiceAction = "status" \| "start"/);
  assert.doesNotMatch(api, /type ServiceAction =[^;]*(?:stop|restart)/);
});

test("tray mutations detach before the GUI releases its mutation drain", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  const handler = source.match(/handleAction\("controlTray"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "controlTray handler should be readable");
  assert.match(handler, /runControlJson\(\["tray", "status"\]/);
  assert.match(handler, /status\?\.supported === false[\s\S]*throw new Error/);
  assert.match(handler, /await runControlDetached\(\["tray", value\]\)/);
  assert.match(handler, /accepted: true/);
  assert.ok(
    handler.indexOf('value === "status"') < handler.indexOf('runControlDetached(["tray", value])'),
    "only status may use the awaited tray path",
  );
});

test("detached tray acceptance is labeled started, never completed", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const action = source.slice(source.indexOf("const runAction"), source.indexOf("const t = useCallback"));
  assert.match(action, /accepted[^\n]+=== true/);
  assert.match(action, /`\$\{label\} started\.`/);
  const accepted = action.slice(action.indexOf("accepted"), action.indexOf("return;", action.indexOf("accepted")));
  assert.doesNotMatch(accepted, /status: "completed"/);
  assert.match(source, /<Badge tone="neutral">Started<\/Badge>/);
});

test("local model mutations cover service readiness and validate consent flags", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /typeof yes !== "boolean"/);
  assert.match(source, /typeof force !== "boolean"/);
  assert.match(source, /local-models", "install"[\s\S]{0,260}timeoutMs: 330_000/);
  assert.match(source, /local-models", "uninstall"[\s\S]{0,180}timeoutMs: 330_000/);
  assert.match(source, /local-models", "set"[\s\S]{0,240}timeoutMs: 330_000/);
});

test("one-click MLX setup stays on fixed IPC commands and polls background stages", async () => {
  const ipc = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(ipc, /handleAction\("installLocalMlx"[\s\S]{0,300}yes !== true[\s\S]{0,220}\["local-models", "mlx-install", "--yes"\]/);
  assert.match(ipc, /handleAction\("cancelLocalMlx"[\s\S]{0,180}\["local-models", "mlx-cancel"\]/);

  const app = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /ACTIVE_MLX_STATES = new Set\(\["preparing", "downloading", "loading", "starting-server", "verifying", "publishing"\]\)/);
  assert.match(app, /localDownloadActive \|\| mlxOperationActive \? api\.getLocalModels\(\)/);

  const page = await readFile(new URL("../apps/control-center/src/pages/LocalPage.tsx", import.meta.url), "utf8");
  assert.match(page, /title="Qwen 3\.8 27B · MLX"/);
  assert.match(page, /api\.installLocalMlx\(\)/);
  assert.match(page, /api\.cancelLocalMlx\(\)/);
  assert.match(page, /about 15 GB/);
  assert.match(page, /runtime installation, model download, and local proxy publication/);
  assert.match(page, /mlxPublished && mlx\?\.runtime\?\.served === true/);
  assert.match(page, /mlx\?\.host\?\.supported !== false/);
  assert.match(page, /Reduced guardrails; local access only/);
  assert.match(page, /progressMode === "indeterminate"/);
  assert.match(page, /ollamaMutationActive/);
  assert.doesNotMatch(page, /token.*(?:input|textarea)|(?:input|textarea).*token/i);
});

for (const mode of ["timeout", "overflow"]) {
  test(`command ${mode} terminates its full descendant process tree`, async () => {
    const root = await makeProcessTreeControlRoot();
    const pidFile = path.join(root, `${mode}.pid`);
    const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
    let descendantPid;
    try {
      process.env.CODEX_ROUTER_SOURCE_ROOT = root;
      const command = runControl(
        [pidFile, mode],
        mode === "timeout" ? { timeoutMs: 250 } : { timeoutMs: 5_000, maxOutputBytes: 32 },
      );
      await assert.rejects(command, mode === "timeout" ? /timed out/ : /output exceeded/);
      descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      await waitForProcessExit(descendantPid);
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
      else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

function accountTestToken(subject, expiresAtSeconds = Math.floor(Date.now() / 1000) + 86_400) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: subject, exp: expiresAtSeconds })}.sig`;
}

function accountTestAuth(accountId, tokenTag) {
  return {
    auth_mode: "chatgpt",
    tokens: {
      access_token: accountTestToken(tokenTag),
      refresh_token: `refresh-${tokenTag}`,
      account_id: accountId,
    },
    last_refresh: "2026-09-20T08:00:00.000Z",
  };
}

test("Codex Desktop detection ignores CLI/app-server executables and recognizes the Windows app package", () => {
  assert.equal(
    isWindowsCodexDesktopExecutable("C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe"),
    false,
  );
  assert.equal(
    isWindowsCodexDesktopExecutable("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe"),
    false,
  );
  assert.equal(
    isWindowsCodexDesktopExecutable("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\Codex.exe"),
    true,
  );
  assert.equal(
    isWindowsCodexDesktopExecutable("C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe"),
    true,
  );

  const cliOnly = codexDesktopRunning({
    platform: "win32",
    spawnSyncImpl: () => ({
      status: 0,
      stdout: [
        "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\bin\\codex.exe",
        "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe",
      ].join("\r\n"),
    }),
  });
  assert.equal(cliOnly, false);

  const desktopPresent = codexDesktopRunning({
    platform: "win32",
    spawnSyncImpl: () => ({
      status: 0,
      stdout: "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0\\app\\Codex.exe\r\n",
    }),
  });
  assert.equal(desktopPresent, true);

  const unreadableIdentity = codexDesktopRunning({
    platform: "win32",
    spawnSyncImpl: () => ({ status: 0, stdout: "__CODEX_PATH_UNREADABLE__\r\n" }),
  });
  assert.equal(unreadableIdentity, true);

  const failedProbe = codexDesktopRunning({
    platform: "win32",
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "probe failed" }),
  });
  assert.equal(failedProbe, true);
});

test("Codex browser-login prompt parser extracts the authorization URL, state, and callback port", () => {
  const authorizationUrl = "https://auth.openai.com/oauth/authorize?client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=state-123";
  assert.deepEqual(parseCodexBrowserLoginOutput(`Open this URL: ${authorizationUrl}\n`), {
    authorizationUrl,
    expectedState: "state-123",
    callbackPort: 1455,
  });
});

test("Codex browser login accepts a CLIProxyAPI-style manual localhost callback and saves the isolated profile", async () => {
  const { createServer } = await import("node:http");
  const home = await mkdtemp(path.join(os.tmpdir(), "router-codex-browser-login-"));
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let spawned;
  let receivedPath = "";
  const server = createServer(async (request, response) => {
    receivedPath = request.url || "";
    await writeFile(
      path.join(spawned.options.env.CODEX_HOME, "auth.json"),
      JSON.stringify(accountTestAuth("acct-b", "b-browser")),
    );
    response.statusCode = 200;
    response.end("Authentication successful");
    setImmediate(() => child.emit("exit", 0));
  });
  try {
    await mkdir(liveHome, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-live")));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    const state = "state-browser-123";
    const authorizationUrl = "https://auth.openai.com/oauth/authorize?client_id=test"
      + `&redirect_uri=${encodeURIComponent(`http://localhost:${port}/auth/callback`)}`
      + `&state=${state}`;

    const started = startCodexAccountBrowserLogin("无痕账号 B", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
      binary: "/usr/bin/codex",
      loginTimeoutMs: 30_000,
      spawnImpl(command, args, options) {
        spawned = { command, args, options };
        return child;
      },
    });
    assert.equal(started.loginSession?.mode, "browser");
    assert.equal(started.loginSession?.status, "starting");
    assert.deepEqual(spawned.args, ["login"]);
    assert.match(spawned.options.env.CODEX_HOME, /native-accounts[\\/]profiles[\\/]/);

    child.stdout.emit("data", Buffer.from(`Open this URL: ${authorizationUrl}\n`));
    const waiting = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(waiting.loginSession?.status, "waiting");
    assert.equal(waiting.loginSession?.authorizationUrl, authorizationUrl);

    await assert.rejects(
      () => submitCodexAccountCallback(
        `http://localhost:${port}/auth/callback?code=wrong&state=wrong-state`,
        { home, env: {}, platform: "linux", desktopRunning: false },
      ),
      /state.*不匹配/,
    );
    assert.equal(receivedPath, "");

    const submitted = await submitCodexAccountCallback(
      `http://localhost:${port}/auth/callback?code=auth-code-123&state=${state}`,
      { home, env: {}, platform: "linux", desktopRunning: false },
    );
    assert.match(submitted.report || "", /回调已转交/);
    assert.match(receivedPath, /code=auth-code-123/);
    assert.match(receivedPath, /state=state-browser-123/);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const completed = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(completed.loginSession?.status, "completed");
    assert.equal(completed.profiles.length, 2);
    assert.equal(completed.profiles.find((profile) => profile.label === "无痕账号 B")?.active, false);
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-a");

    const cleared = cancelCodexAccountLogin({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(cleared.loginSession, undefined);
  } finally {
    cancelCodexAccountLogin({ home, env: {}, platform: "linux", desktopRunning: false });
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex device-login prompt parser extracts the official verification URL and one-time code", () => {
  const parsed = parseCodexDeviceLoginOutput(
    "\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n"
    + "2. Enter this one-time code (expires in 15 minutes)\n"
    + "\u001b[94mCODE-12345\u001b[0m\n",
  );
  assert.deepEqual(parsed, {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "CODE-12345",
  });
});

test("Codex device login exposes a nonblocking incognito flow and saves the isolated profile on completion", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-codex-device-login-"));
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let spawned;
  try {
    await mkdir(liveHome, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-live")));

    const started = startCodexAccountDeviceLogin("无痕账号 B", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
      binary: "/usr/bin/codex",
      deviceLoginTimeoutMs: 30_000,
      spawnImpl(command, args, options) {
        spawned = { command, args, options };
        return child;
      },
    });

    assert.equal(started.loginSession?.status, "starting");
    assert.deepEqual(spawned.args, ["login", "--device-auth"]);
    assert.match(spawned.options.env.CODEX_HOME, /native-accounts[\\/]profiles[\\/]/);

    child.stdout.emit(
      "data",
      Buffer.from(
        "1. Open this link in your browser and sign in to your account\n"
        + "https://auth.openai.com/codex/device\n"
        + "2. Enter this one-time code (expires in 15 minutes)\n"
        + "CODE-12345\n",
      ),
    );
    const waiting = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(waiting.loginSession?.status, "waiting");
    assert.equal(waiting.loginSession?.verificationUrl, "https://auth.openai.com/codex/device");
    assert.equal(waiting.loginSession?.userCode, "CODE-12345");

    await writeFile(
      path.join(spawned.options.env.CODEX_HOME, "auth.json"),
      JSON.stringify(accountTestAuth("acct-b", "b-device")),
    );
    child.emit("exit", 0);

    const completed = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(completed.loginSession?.status, "completed");
    assert.equal(completed.profiles.length, 2);
    assert.equal(completed.profiles.find((profile) => profile.label === "无痕账号 B")?.active, false);
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-a");

    const cleared = cancelCodexAccountLogin({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(cleared.loginSession, undefined);
  } finally {
    cancelCodexAccountLogin({ home, env: {}, platform: "linux", desktopRunning: false });
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex account switching is auth-only and contains no Router lifecycle or config mutation path", async () => {
  const source = await readFile(
    new URL("../apps/control-center/electron/codex-account-profiles.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /controlService|runControl|controlTray|service\s*(?:stop|start|restart)/);
  assert.doesNotMatch(source, /config\.toml|model_provider|merged-models|model_catalog/i);
  assert.match(source, /routerRestartRequired:\s*false/);
  assert.match(source, /configMutationRequired:\s*false/);
});

test("Codex account profiles add a second official-login profile without changing the live account", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-codex-accounts-add-"));
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  try {
    await mkdir(liveHome, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-initial")));

    const result = await addCodexAccount("工作账号 B", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
      loginRunner: async (isolatedHome) => {
        await mkdir(isolatedHome, { recursive: true });
        await writeFile(path.join(isolatedHome, "auth.json"), JSON.stringify(accountTestAuth("acct-b", "b-login")));
      },
    });

    assert.equal(result.profiles.length, 2);
    assert.equal(result.routerRestartRequired, false);
    assert.equal(result.configMutationRequired, false);
    assert.equal(result.liveManaged, true);
    assert.equal(result.profiles.find((profile) => profile.active)?.label, "当前 Codex 账号");
    assert.equal(result.profiles.find((profile) => profile.label === "工作账号 B")?.active, false);
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-a");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex account switching refuses an open Desktop, syncs refreshed auth, and leaves Router/config sentinels untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-codex-accounts-switch-"));
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  const config = path.join(liveHome, "config.toml");
  const routerSentinel = path.join(home, "router.pid");
  try {
    await mkdir(liveHome, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-initial")));
    await writeFile(config, 'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:4202/_codex-router/redacted/v1"\n');
    await writeFile(routerSentinel, "4242\n");

    const added = await addCodexAccount("账号 B", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
      loginRunner: async (isolatedHome) => {
        await mkdir(isolatedHome, { recursive: true });
        await writeFile(path.join(isolatedHome, "auth.json"), JSON.stringify(accountTestAuth("acct-b", "b-login")));
      },
    });
    const accountA = added.profiles.find((profile) => profile.active);
    const accountB = added.profiles.find((profile) => profile.label === "账号 B");
    assert.ok(accountA);
    assert.ok(accountB);

    const refreshedA = accountTestAuth("acct-a", "a-refreshed");
    await writeFile(liveAuth, JSON.stringify(refreshedA));
    const configBefore = await readFile(config, "utf8");
    const routerBefore = await readFile(routerSentinel, "utf8");

    assert.throws(
      () => switchCodexAccount(accountB.id, {
        home,
        env: {},
        platform: "linux",
        desktopRunning: true,
      }),
      /退出 Codex Desktop/,
    );
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-a");

    const switched = switchCodexAccount(accountB.id, {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(switched.activeAccountId, accountB.id);
    assert.equal(switched.routerRestartRequired, false);
    assert.equal(switched.configMutationRequired, false);
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-b");
    assert.equal(await readFile(config, "utf8"), configBefore);
    assert.equal(await readFile(routerSentinel, "utf8"), routerBefore);
    const identityContext = getCodexAccountIdentityContext({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(identityContext.activeProfileId, accountB.id);
    assert.equal(identityContext.activeAccountFingerprint, accountB.identityFingerprint);
    assert.equal(identityContext.activations.some((entry) => entry.profileId === accountA.id), true);
    assert.equal(identityContext.activations.some((entry) => entry.profileId === accountB.id), true);

    const storedA = JSON.parse(await readFile(
      path.join(switched.root, "profiles", accountA.id, "auth.json"),
      "utf8",
    ));
    assert.equal(storedA.tokens.access_token, refreshedA.tokens.access_token);

    // Re-selecting the already-active account must preserve a newer token that
    // Codex refreshed in live auth.json instead of restoring the older Profile
    // copy that existed before the switch call began.
    const refreshedB = accountTestAuth("acct-b", "b-refreshed");
    await writeFile(liveAuth, JSON.stringify(refreshedB));
    const sameAccount = switchCodexAccount(accountB.id, {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(sameAccount.activeAccountId, accountB.id);
    assert.equal(
      JSON.parse(await readFile(liveAuth, "utf8")).tokens.access_token,
      refreshedB.tokens.access_token,
    );
    assert.equal(
      JSON.parse(await readFile(
        path.join(sameAccount.root, "profiles", accountB.id, "auth.json"),
        "utf8",
      )).tokens.access_token,
      refreshedB.tokens.access_token,
    );

    assert.throws(
      () => deleteCodexAccount(accountB.id, { home, env: {}, platform: "linux", desktopRunning: false }),
      /active ChatGPT account/,
    );
    const renamed = renameCodexAccount(accountA.id, "备用账号 A", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(renamed.profiles.find((profile) => profile.id === accountA.id)?.label, "备用账号 A");
    const snapshot = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(snapshot.profiles.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex account switching accepts a refreshable profile whose access token expired", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "router-codex-accounts-refresh-"));
  const liveHome = path.join(home, ".codex");
  const liveAuth = path.join(liveHome, "auth.json");
  try {
    await mkdir(liveHome, { recursive: true });
    await writeFile(liveAuth, JSON.stringify(accountTestAuth("acct-a", "a-live")));

    const added = await addCodexAccount("备用账号 B", {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
      loginRunner: async (isolatedHome) => {
        await mkdir(isolatedHome, { recursive: true });
        await writeFile(path.join(isolatedHome, "auth.json"), JSON.stringify(accountTestAuth("acct-b", "b-login")));
      },
    });
    const accountB = added.profiles.find((profile) => profile.label === "备用账号 B");
    assert.ok(accountB);

    const expiredB = accountTestAuth("acct-b", "b-expired");
    expiredB.tokens.access_token = accountTestToken("b-expired", Math.floor(Date.now() / 1000) - 3600);
    await writeFile(
      path.join(added.root, "profiles", accountB.id, "auth.json"),
      JSON.stringify(expiredB),
    );

    const before = getCodexAccountProfilesSnapshot({
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    const staleProfile = before.profiles.find((profile) => profile.id === accountB.id);
    assert.equal(staleProfile?.expired, true);
    assert.equal(staleProfile?.refreshRequired, true);
    assert.equal(staleProfile?.usable, true);

    const switched = switchCodexAccount(accountB.id, {
      home,
      env: {},
      platform: "linux",
      desktopRunning: false,
    });
    assert.equal(switched.activeAccountId, accountB.id);
    assert.equal(JSON.parse(await readFile(liveAuth, "utf8")).tokens.account_id, "acct-b");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("router children inherit the proxy opt-in this install recorded", async () => {
  const runner = await readFile(
    new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url),
    "utf8",
  );
  // The app is launched by the desktop session, so it inherits a proxy address
  // but nothing saying Node may use it. Without the recorded opt-in a router
  // child dials a proxied host directly and the connect timeout is reported as
  // the provider failing -- a reachable Venice catalog came back as "fetch
  // failed" that way.
  assert.match(runner, /recordedInstall\.proxyOptIn === "1"/);
  assert.match(runner, /childEnvironment\.NODE_USE_ENV_PROXY === undefined/);
  assert.match(runner, /childEnvironment\.NODE_USE_ENV_PROXY = "1"/);
  assert.match(runner, /recordedProxy\.NODE_USE_ENV_PROXY === "1"/);
  // Only the opt-in is restored. Supplying an address the environment does not
  // name is inheritedProxyEnvironment's decision to defer, and AGENTS.md says
  // not to widen that trigger.
  assert.doesNotMatch(runner, /childEnvironment\.HTTPS?_PROXY = /);
  // It applies only to the install that recorded it.
  assert.match(runner, /recordedInstall\?\.sourceRoot === sourceRoot\s*&&\s*recordedInstall\.proxyOptIn/);
});
