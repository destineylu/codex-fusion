import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_CHATGPT_WEB_REPOSITORY = "https://github.com/miuuyy/codex-chatgpt-web";
export const CODEX_CHATGPT_WEB_AUDITED_VERSION = "5.0.8";
export const CODEX_CHATGPT_WEB_PROVIDER_ID = "chatgpt-web";
export const CODEX_CHATGPT_WEB_BASE_URL = "http://127.0.0.1:17841/v1";

const WINDOWS_ASSET = `codex-web-gpt-${CODEX_CHATGPT_WEB_AUDITED_VERSION}-win-x64.exe`;
const WINDOWS_ASSET_URL =
  `${CODEX_CHATGPT_WEB_REPOSITORY}/releases/download/v${CODEX_CHATGPT_WEB_AUDITED_VERSION}/${WINDOWS_ASSET}`;
const WINDOWS_ASSET_SHA256 = "83224d59506462ab2976f437bfaea96b046d4ed55caa7e1cfd6a3d61de0a8ff3";
const WINDOWS_LAUNCHER_ASAR_SHA256_ORIGINAL = "cde52e0be0ae8618e65813587ca3ac153961512b8be30725fcd4f6b6d53d0e05";
const WINDOWS_LAUNCHER_ASAR_SHA256_PATCHED = "d993d21285c0a5a092a0f924cc3685722f1b682221bfec762c21ee49eac3baa2";
const PREFLIGHT_TIMEOUT_15S = Buffer.from("timeoutMs: Math.min(options.timeoutMs || 15_000, 15_000)", "utf8");
const PREFLIGHT_TIMEOUT_60S = Buffer.from("timeoutMs: Math.min(options.timeoutMs || 60_000, 60_000)", "utf8");
const WINDOWS_INSTALL_REGISTRY = "HKCU\\Software\\d1a6026a-6210-588e-9a2b-da3936f94e02";
const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const RUNTIME_MATERIALIZATION_TIMEOUT_MS = 45_000;
const BRIDGE_PROBE_TIMEOUT_MS = 1_500;
const MANAGED_START_GUARD_MS = 5_000;
const MANAGED_LAUNCHER_START_TIMEOUT_MS = 120_000;
const WINDOWS_RUN_KEYS = [
  "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run",
  "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\RunOnce",
];

function cleanText(value, limit = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function codexChatGptWebManagedRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const override = String(env.CODEX_ROUTER_CHATGPT_WEB_MANAGED_ROOT || "").trim();
  if (override && path.isAbsolute(override)) return path.resolve(override);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "codex-router-sidecars", "codex-chatgpt-web");
  }
  return path.join(home, ".local", "share", "codex-router-sidecars", "codex-chatgpt-web");
}

function appHome(env = process.env, home = os.homedir(), platform = process.platform) {
  return codexChatGptWebManagedRoot({ platform, env, home });
}

function managedCodexHome(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(codexChatGptWebManagedRoot({ platform, env, home }), "codex-home");
}

function managedLauncherDataDir(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(codexChatGptWebManagedRoot({ platform, env, home }), "launcher");
}

function managedRuntimeRoot(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(
    codexChatGptWebManagedRoot({ platform, env, home }),
    "versions",
    `${CODEX_CHATGPT_WEB_AUDITED_VERSION}-win32-x64`,
  );
}

function managedConfigPath(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(codexChatGptWebManagedRoot({ platform, env, home }), "config.json");
}

function codexHome(env = process.env, home = os.homedir()) {
  const override = String(env.CODEX_HOME || "").trim();
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(home, ".codex");
}

function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function registryInstallLocation(spawnImpl = spawnSync) {
  const result = spawnImpl(
    "reg.exe",
    ["query", WINDOWS_INSTALL_REGISTRY, "/v", "InstallLocation"],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 3_000,
    },
  );
  if (result?.error || result?.status !== 0) return undefined;
  const match = String(result.stdout || "").match(/InstallLocation\s+REG_\w+\s+(.+)$/mi);
  return match?.[1]?.trim();
}

export function codexChatGptWebLauncherPath({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnImpl = spawnSync,
} = {}) {
  const override = String(env.CODEX_CHATGPT_WEB_LAUNCHER_PATH || "").trim();
  if (override && path.isAbsolute(override) && existsSync(override)) return path.resolve(override);
  if (platform !== "win32") return undefined;
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const registry = registryInstallLocation(spawnImpl);
  const candidates = [
    registry ? path.join(registry, "Codex Web GPT.exe") : undefined,
    path.join(localAppData, "Programs", "Codex Web GPT", "Codex Web GPT.exe"),
    path.join(localAppData, "Programs", "codex-web-gpt-launcher", "Codex Web GPT.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function realCodexConfigPath(env = process.env, home = os.homedir()) {
  return path.join(codexHome(env, home), "config.toml");
}

function readCodexOpenAiBaseUrl(env = process.env, home = os.homedir()) {
  const file = realCodexConfigPath(env, home);
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    const match = text.match(/^\s*openai_base_url\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/m);
    return match?.[1] || match?.[2] || undefined;
  } catch {
    return undefined;
  }
}

function loopbackHost(hostname) {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(String(hostname || "").toLowerCase());
}

export function classifyCodexRoute(value) {
  if (!value) return { owner: "native", display: "Native Codex route" };
  try {
    const url = new URL(value);
    if (loopbackHost(url.hostname) && url.pathname.includes("/_codex-router/")) {
      return { owner: "router", display: "Codex Router (loopback, capability path redacted)" };
    }
    if (loopbackHost(url.hostname) && url.port === "17841") {
      return { owner: "chatgpt-web", display: "ChatGPT Web direct route (127.0.0.1:17841)" };
    }
    return { owner: "other", display: "Another configured Codex route" };
  } catch {
    return { owner: "unknown", display: "Unreadable Codex route" };
  }
}

function configFingerprint(file) {
  if (!existsSync(file)) return undefined;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminateManagedRuntime(supervisor, spawnImpl = spawnSync, extraPids = []) {
  if (process.platform !== "win32") return;
  const ownerPid = Number(supervisor?.ownerPid);
  const daemonPid = Number(supervisor?.daemonPid);
  const pids = [...new Set([ownerPid, daemonPid, ...extraPids].filter((pid) => Number.isInteger(pid) && pid > 0))];
  for (const pid of pids) {
    spawnImpl("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 5_000,
    });
  }
}

function removeLauncherAutostart(launcherPath, spawnImpl = spawnSync) {
  if (process.platform !== "win32" || !launcherPath) return [];
  const removed = [];
  const needle = path.resolve(launcherPath).toLowerCase();
  for (const key of WINDOWS_RUN_KEYS) {
    const query = spawnImpl("reg.exe", ["query", key], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 3_000,
    });
    if (query?.error || query?.status !== 0) continue;
    for (const line of String(query.stdout || "").split(/\\r?\\n/)) {
      const match = line.match(/^\\s*([^\\s].*?)\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$/i);
      if (!match) continue;
      const valueName = match[1].trim();
      const command = match[2].trim().toLowerCase();
      if (!command.includes(needle)) continue;
      const deleted = spawnImpl("reg.exe", ["delete", key, "/v", valueName, "/f"], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 3_000,
      });
      if (!deleted?.error && deleted?.status === 0) removed.push(key + "\\\\" + valueName);
    }
  }
  return removed;
}

function normalizeLoopbackProxy(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const keyed = new Map();
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    keyed.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  }
  let candidate = keyed.get("https") || keyed.get("http") || (keyed.size === 0 ? raw : "");
  if (!candidate) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return undefined;
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `${parsed.protocol}//${parsed.host}`;
}

export function windowsInternetProxyUrl(spawnImpl = spawnSync) {
  if (process.platform !== "win32") return undefined;
  const queryValue = (name) => {
    const result = spawnImpl("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 3_000,
    });
    if (result?.error || result?.status !== 0) return undefined;
    const match = String(result.stdout || "").match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)$`, "mi"));
    return match?.[1]?.trim();
  };
  const enabled = queryValue("ProxyEnable");
  if (!enabled || !/(?:0x)?1$/i.test(enabled)) return undefined;
  return normalizeLoopbackProxy(queryValue("ProxyServer"));
}

function ensureManagedLauncherNoAutostart(env = process.env, home = os.homedir(), platform = process.platform) {
  const launcherDir = managedLauncherDataDir(env, home, platform);
  mkdirSync(launcherDir, { recursive: true });
  const statePath = path.join(launcherDir, "launcher-state.json");
  const current = readJson(statePath) || { version: 1 };
  const next = { ...current, version: 1, autoStart: false };
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next;
}

function managedLauncherEnvironment(env = process.env, home = os.homedir(), platform = process.platform) {
  const managedRoot = codexChatGptWebManagedRoot({ platform, env, home });
  const shadowCodexHome = managedCodexHome(env, home, platform);
  const launcherDataDir = managedLauncherDataDir(env, home, platform);
  mkdirSync(managedRoot, { recursive: true });
  mkdirSync(shadowCodexHome, { recursive: true });
  mkdirSync(launcherDataDir, { recursive: true });
  ensureManagedLauncherNoAutostart(env, home, platform);
  const proxyUrl = platform === "win32" ? windowsInternetProxyUrl() : undefined;
  return {
    ...env,
    ...(proxyUrl ? {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
    } : {}),
    CODEX_CHATGPT_WEB_HOME: managedRoot,
    CODEX_HOME: shadowCodexHome,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherDataDir,
  };
}

async function waitForManagedRuntime(
  env = process.env,
  home = os.homedir(),
  platform = process.platform,
  timeoutMs = MANAGED_LAUNCHER_START_TIMEOUT_MS,
) {
  const runtimeRoot = managedRuntimeRoot(env, home, platform);
  const required = [
    path.join(runtimeRoot, "manifest.json"),
    path.join(runtimeRoot, "runtime", "bun.exe"),
    path.join(runtimeRoot, "app", "cli.js"),
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (required.every((file) => existsSync(file))) {
      return {
        root: runtimeRoot,
        bun: required[1],
        cli: required[2],
      };
    }
    await sleep(250);
  }
  throw new Error("Managed Codex Web GPT runtime did not finish materializing.");
}

function managedCliEnvironment(env = process.env, home = os.homedir(), platform = process.platform) {
  return managedLauncherEnvironment(env, home, platform);
}

async function runManagedCli(args, { timeoutMs = 120_000 } = {}) {
  const runtime = await waitForManagedRuntime();
  const result = spawnSync(runtime.bun, [runtime.cli, ...args], {
    encoding: "utf8",
    env: managedCliEnvironment(),
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(cleanText(result.stderr || result.stdout, 1_800) || `codex-chatgpt-web CLI exited with code ${result.status}.`);
  }
  return cleanText(result.stdout || result.stderr, 4_000);
}

async function probeBridge(fetchImpl = fetch) {
  for (const target of ["http://127.0.0.1:17841/health", `${CODEX_CHATGPT_WEB_BASE_URL}/models`]) {
    try {
      const response = await fetchImpl(target, {
        method: "GET",
        signal: AbortSignal.timeout(BRIDGE_PROBE_TIMEOUT_MS),
      });
      if (response.status < 500) return true;
    } catch {
      // Try the next fixed loopback probe.
    }
  }
  return false;
}

export async function getCodexChatGptWebSnapshot(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const launcherPath = codexChatGptWebLauncherPath({
    platform,
    env,
    home,
    spawnImpl: options.spawnImpl || spawnSync,
  });
  const homeDir = appHome(env, home, platform);
  const supervisor = readJson(path.join(homeDir, "runtime", "launcher-supervisor.json"));
  const browserDescriptor = readJson(path.join(homeDir, "runtime", "launcher-browser.json"));
  const launcherState = readJson(path.join(managedLauncherDataDir(env, home, platform), "launcher-state.json"));
  const ownerPid = Number(supervisor?.ownerPid);
  const browserPid = Number(browserDescriptor?.pid);
  const upstreamDaemonPid = Number(supervisor?.daemonPid);
  const running = processRunning(browserPid) || processRunning(ownerPid);
  const upstreamDaemonRunning = processRunning(upstreamDaemonPid);
  const daemonRunning = upstreamDaemonRunning;
  const route = classifyCodexRoute(readCodexOpenAiBaseUrl(env, home));
  const bridgeReachable = daemonRunning
    ? await probeBridge(options.fetchImpl || fetch)
    : false;
  const directRouteConflict = route.owner === "chatgpt-web";
  const safeToDiscover =
    Boolean(launcherPath) &&
    daemonRunning &&
    bridgeReachable &&
    route.owner === "router" &&
    !directRouteConflict;

  return {
    supported: platform === "win32" && process.arch === "x64",
    installed: Boolean(launcherPath),
    repository: CODEX_CHATGPT_WEB_REPOSITORY,
    auditedVersion: CODEX_CHATGPT_WEB_AUDITED_VERSION,
    providerId: CODEX_CHATGPT_WEB_PROVIDER_ID,
    launcherPath,
    home: homeDir,
    shadowCodexHome: managedCodexHome(env, home, platform),
    launcherDataDir: managedLauncherDataDir(env, home, platform),
    running,
    daemonRunning,
    bridgeReachable,
    daemonEndpoint: CODEX_CHATGPT_WEB_BASE_URL,
    supervisorStatus: cleanText(supervisor?.status, 80) || undefined,
    browserReady: processRunning(browserPid) && browserDescriptor?.profile === "production",
    onboardingComplete: launcherState?.onboardingComplete === true,
    browserSmokePassed: launcherState?.browserSmokePassed === true,
    configured: existsSync(managedConfigPath(env, home, platform)),
    daemonOwner: upstreamDaemonRunning ? "upstream" : "none",
    routeOwner: route.owner,
    routeDisplay: route.display,
    directRouteConflict,
    safeToDiscover,
    upstreamExternalProviderSupported: false,
    why: platform !== "win32"
      ? "This guarded Control Center integration currently installs the audited Windows launcher only."
      : process.arch !== "x64"
        ? "The audited Windows launcher requires x64 Windows."
        : undefined,
  };
}

async function downloadAuditedWindowsInstaller(fetchImpl = fetch) {
  const response = await fetchImpl(WINDOWS_ASSET_URL, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Could not download audited Codex Web GPT v${CODEX_CHATGPT_WEB_AUDITED_VERSION}: HTTP ${response.status}.`);
  }
  const announced = Number(response.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_INSTALLER_BYTES) {
    throw new Error("Codex Web GPT installer exceeds the guarded download limit.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_INSTALLER_BYTES) {
    throw new Error("Codex Web GPT installer has an invalid size.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== WINDOWS_ASSET_SHA256) {
    throw new Error("Codex Web GPT installer SHA-256 does not match the audited v5.0.8 release.");
  }
  return bytes;
}

async function waitForInstalledRuntime(launcherPath, timeoutMs = RUNTIME_MATERIALIZATION_TIMEOUT_MS) {
  const installRoot = path.dirname(launcherPath);
  const required = [
    path.join(installRoot, "resources", "runtime", "manifest.json"),
    path.join(installRoot, "resources", "runtime", "runtime", "bun.exe"),
    path.join(installRoot, "resources", "runtime", "LICENSES", "Bun-1.4.0.md"),
    path.join(installRoot, "resources", "runtime", "app", "cli.js"),
  ];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (required.every((file) => existsSync(file))) return required;
    await sleep(250);
  }
  const missing = required.filter((file) => !existsSync(file)).map((file) => path.basename(file));
  throw new Error(`Codex Web GPT runtime did not finish materializing: ${missing.join(", ")}.`);
}

export function patchCodexChatGptWebPreflightBytes(bytes) {
  const source = Buffer.from(bytes);
  const first = source.indexOf(PREFLIGHT_TIMEOUT_15S);
  if (first < 0) return { changed: false, bytes: source };
  if (source.indexOf(PREFLIGHT_TIMEOUT_15S, first + PREFLIGHT_TIMEOUT_15S.length) >= 0) {
    throw new Error("Audited ChatGPT Web preflight signature is not unique.");
  }
  const patched = Buffer.from(source);
  PREFLIGHT_TIMEOUT_60S.copy(patched, first);
  return { changed: true, bytes: patched };
}

function ensureAuditedWindowsLauncherPatch(launcherPath) {
  const asar = path.join(path.dirname(launcherPath), "resources", "app.asar");
  if (!existsSync(asar)) throw new Error("Codex Web GPT app.asar is missing after installation.");
  const original = readFileSync(asar);
  const digest = createHash("sha256").update(original).digest("hex");
  if (digest === WINDOWS_LAUNCHER_ASAR_SHA256_PATCHED) return "preflight timeout patch already verified";
  if (digest !== WINDOWS_LAUNCHER_ASAR_SHA256_ORIGINAL) {
    throw new Error("Codex Web GPT app.asar does not match the audited v5.0.8 build; refusing to patch an unknown launcher.");
  }
  const patched = patchCodexChatGptWebPreflightBytes(original);
  if (!patched.changed) throw new Error("Audited ChatGPT Web preflight signature was not found.");
  const patchedDigest = createHash("sha256").update(patched.bytes).digest("hex");
  if (patchedDigest !== WINDOWS_LAUNCHER_ASAR_SHA256_PATCHED) {
    throw new Error("ChatGPT Web preflight patch produced an unexpected digest.");
  }
  const backupDir = path.join(appHome(), "patch-backups", `v${CODEX_CHATGPT_WEB_AUDITED_VERSION}`);
  const backup = path.join(backupDir, "app.asar.before-preflight-timeout-patch");
  mkdirSync(backupDir, { recursive: true });
  if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600 });
  writeFileSync(asar, patched.bytes);
  return "verified preflight timeout patch applied (15s → 60s)";
}

function installWindowsLauncher(bytes) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-"));
  const installer = path.join(temporary, WINDOWS_ASSET);
  try {
    writeFileSync(installer, bytes, { mode: 0o600 });
    const result = spawnSync(installer, ["/S", "/currentuser"], {
      encoding: "utf8",
      env: process.env,
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(cleanText(result.stderr || result.stdout, 1_200) || `Codex Web GPT installer exited with code ${result.status}.`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function restoreRealCodexConfig(file, bytes) {
  if (bytes === undefined) rmSync(file, { force: true });
  else writeFileSync(file, bytes);
}

function assertRealCodexRoutePreserved(file, fingerprint, bytes, message) {
  const route = classifyCodexRoute(readCodexOpenAiBaseUrl());
  if (route.owner === "router" && configFingerprint(file) === fingerprint) return;
  restoreRealCodexConfig(file, bytes);
  throw new Error(message);
}

async function configureManagedBrowserOnly() {
  const snapshot = await getCodexChatGptWebSnapshot();
  if (!snapshot.browserReady) {
    throw new Error("Managed launcher browser is not ready.");
  }
  if (!snapshot.browserSmokePassed) {
    throw new Error("Complete ChatGPT sign-in and the browser smoke test in the managed launcher first.");
  }
  if (snapshot.configured) return "Managed browser-only configuration already exists.";

  const realConfig = realCodexConfigPath();
  const beforeBytes = existsSync(realConfig) ? readFileSync(realConfig) : undefined;
  const beforeFingerprint = configFingerprint(realConfig);
  const root = appHome();
  const descriptor = path.join(root, "runtime", "launcher-browser.json");
  let report;
  try {
    report = await runManagedCli([
      "--home", root,
      "setup",
      "--browser-only",
      "--browser-host-descriptor", descriptor,
      "--automatic-browser-interaction",
      "--acknowledge-unofficial",
    ], { timeoutMs: 120_000 });
  } finally {
    assertRealCodexRoutePreserved(
      realConfig,
      beforeFingerprint,
      beforeBytes,
      "Managed ChatGPT Web setup touched the real Codex route. The pre-setup config was restored.",
    );
  }
  if (!existsSync(managedConfigPath())) {
    throw new Error("Managed ChatGPT Web setup completed without creating its isolated config.");
  }
  return report || "Managed browser-only configuration created without replacing the Codex route.";
}

async function stopManagedSidecar() {
  const root = appHome();
  const supervisor = readJson(path.join(root, "runtime", "launcher-supervisor.json"));
  const browser = readJson(path.join(root, "runtime", "launcher-browser.json"));
  terminateManagedRuntime(supervisor, spawnSync, [Number(browser?.pid)]);
  const launcher = codexChatGptWebLauncherPath();
  if (launcher) removeLauncherAutostart(launcher);
  await sleep(300);
  return getCodexChatGptWebSnapshot();
}

async function ensureUpstreamManagedDaemon() {
  const before = await getCodexChatGptWebSnapshot();
  if (before.routeOwner !== "router") {
    throw new Error("17841 start blocked: Codex Router must own the real Codex route.");
  }
  if (!before.browserReady) throw new Error("Managed launcher browser is not ready.");
  if (!before.browserSmokePassed) {
    throw new Error("Complete ChatGPT sign-in and the browser smoke test in the managed launcher first.");
  }
  if (before.daemonRunning && before.bridgeReachable) return before;

  await configureManagedBrowserOnly();
  if (!before.launcherPath) throw new Error("Codex Web GPT launcher is not installed.");

  await stopManagedSidecar();
  const started = await startManagedLauncher(before.launcherPath);
  const deadline = Date.now() + 45_000;
  let snapshot = started;
  while (Date.now() < deadline) {
    snapshot = await getCodexChatGptWebSnapshot();
    if (snapshot.bridgeReachable && snapshot.daemonOwner === "upstream") return snapshot;
    await sleep(500);
  }
  throw new Error("Upstream-managed ChatGPT Web daemon did not become reachable on 127.0.0.1:17841.");
}

function showManagedLauncherWindow(launcherPath) {
  const child = spawn(launcherPath, [], {
    detached: true,
    stdio: "ignore",
    env: managedLauncherEnvironment(),
    windowsHide: false,
    shell: false,
  });
  child.unref();
}

async function startManagedLauncher(launcherPath) {
  await waitForInstalledRuntime(launcherPath);
  const realConfig = realCodexConfigPath();
  const beforeBytes = existsSync(realConfig) ? readFileSync(realConfig) : undefined;
  const beforeFingerprint = configFingerprint(realConfig);
  const beforeRoute = classifyCodexRoute(readCodexOpenAiBaseUrl());
  if (beforeRoute.owner !== "router") {
    throw new Error("Managed start blocked: Codex Router must own the real Codex route.");
  }

  const env = managedLauncherEnvironment();
  const managedUserData = managedLauncherDataDir();
  const existingSupervisor = readJson(path.join(appHome(), "runtime", "launcher-supervisor.json"));
  if (!processRunning(Number(existingSupervisor?.ownerPid))) {
    rmSync(path.join(managedUserData, "lockfile"), { force: true });
  }
  const child = spawn(launcherPath, [], {
    detached: true,
    stdio: "ignore",
    env,
    windowsHide: false,
    shell: false,
  });
  child.unref();

  const managedHome = appHome(process.env, os.homedir(), process.platform);
  const supervisorPath = path.join(managedHome, "runtime", "launcher-supervisor.json");
  const browserDescriptorPath = path.join(managedHome, "runtime", "launcher-browser.json");
  const deadline = Date.now() + Math.max(MANAGED_START_GUARD_MS, MANAGED_LAUNCHER_START_TIMEOUT_MS);
  let supervisor;
  let browserDescriptor;
  while (Date.now() < deadline) {
    await sleep(250);
    supervisor = readJson(supervisorPath);
    browserDescriptor = readJson(browserDescriptorPath);
    const currentRoute = classifyCodexRoute(readCodexOpenAiBaseUrl());
    const currentFingerprint = configFingerprint(realConfig);
    if (currentRoute.owner !== "router" || currentFingerprint !== beforeFingerprint) {
      terminateManagedRuntime(supervisor, spawnSync, [child.pid]);
      if (beforeBytes !== undefined) writeFileSync(realConfig, beforeBytes);
      throw new Error("Managed ChatGPT Web start touched the real Codex configuration. The launcher was terminated and the pre-launch config was restored.");
    }
    if (browserDescriptor?.profile === "production" && processRunning(Number(browserDescriptor?.pid))) break;
    if (!processRunning(child.pid) && !processRunning(Number(browserDescriptor?.pid))) break;
  }

  if (!(browserDescriptor?.profile === "production" && processRunning(Number(browserDescriptor?.pid)))) {
    terminateManagedRuntime(supervisor, spawnSync, [child.pid]);
    throw new Error("Managed ChatGPT Web launcher did not publish a live browser descriptor.");
  }

  removeLauncherAutostart(launcherPath);
  const finalRoute = classifyCodexRoute(readCodexOpenAiBaseUrl());
  const finalFingerprint = configFingerprint(realConfig);
  if (finalRoute.owner !== "router" || finalFingerprint !== beforeFingerprint) {
    terminateManagedRuntime(supervisor);
    if (beforeBytes !== undefined) writeFileSync(realConfig, beforeBytes);
    throw new Error("Managed ChatGPT Web failed the route-owner guard. The launcher was terminated and the pre-launch config was restored.");
  }

  return getCodexChatGptWebSnapshot();
}

export async function controlCodexChatGptWeb(action) {
  if (!["install", "start-managed", "show-managed", "start-daemon", "stop-managed", "verify-isolation"].includes(action)) {
    throw new Error("Unsupported Codex ChatGPT Web action.");
  }

  const before = await getCodexChatGptWebSnapshot();
  if (!before.supported) throw new Error(before.why || "Codex ChatGPT Web is unsupported on this host.");

  if (action === "install") {
    if (before.routeOwner !== "router") {
      throw new Error("Install blocked: Codex Router must be the current Codex route owner.");
    }
    if (!before.installed) {
      const bytes = await downloadAuditedWindowsInstaller();
      installWindowsLauncher(bytes);
    }
    const after = await getCodexChatGptWebSnapshot();
    if (!after.installed || !after.launcherPath) throw new Error("Codex Web GPT installer completed but the launcher could not be located.");
    await waitForInstalledRuntime(after.launcherPath);
    const patchReport = ensureAuditedWindowsLauncherPatch(after.launcherPath);
    if (after.routeOwner !== "router") {
      throw new Error("Codex Web GPT installed, but Codex Router is no longer the Codex route owner. The launcher was not started.");
    }
    return {
      ...after,
      report: `Audited v${CODEX_CHATGPT_WEB_AUDITED_VERSION} launcher installed without starting it; ${patchReport}. Codex Router remains the route owner.`,
    };
  }

  if (action === "start-managed") {
    if (!before.installed || !before.launcherPath) {
      throw new Error("Codex Web GPT is not installed.");
    }
    if (before.routeOwner !== "router") {
      throw new Error("Managed start blocked: Codex Router is not the current Codex route owner.");
    }
    if (before.running) {
      ensureManagedLauncherNoAutostart();
      removeLauncherAutostart(before.launcherPath);
      showManagedLauncherWindow(before.launcherPath);
      return {
        ...before,
        report: "Managed ChatGPT Web launcher is already running with Router still owning the real Codex route.",
      };
    }
    const started = await startManagedLauncher(before.launcherPath);
    return {
      ...started,
      report: "Managed launcher started with an isolated CODEX_HOME. Upstream route-connect writes are confined to the shadow Codex home; the real Codex route remains owned by Router.",
    };
  }

  if (action === "show-managed") {
    if (!before.installed || !before.launcherPath || !before.running) {
      throw new Error("Managed ChatGPT Web launcher is not running.");
    }
    showManagedLauncherWindow(before.launcherPath);
    return {
      ...before,
      report: "Managed ChatGPT Web window requested in the foreground. The isolated CODEX_HOME remains in effect.",
    };
  }

  if (action === "start-daemon") {
    const started = await ensureUpstreamManagedDaemon();
    return {
      ...started,
      report: "17841 is running under the isolated upstream launcher. The real Codex route remains on Router; setup did not use --replace-codex-route.",
    };
  }

  if (action === "stop-managed") {
    const stopped = await stopManagedSidecar();
    return {
      ...stopped,
      report: "Managed ChatGPT Web launcher and its upstream-owned 17841 daemon were stopped. Codex Router configuration was left unchanged.",
    };
  }

  if (before.routeOwner !== "router") {
    return {
      ...before,
      report: "Isolation check blocked: Codex Router is not the current Codex route owner. No launcher action was taken.",
    };
  }

  const verified = await getCodexChatGptWebSnapshot();
  return {
    ...verified,
    report: verified.safeToDiscover
      ? "Isolation verified: Codex still routes through Router and the ChatGPT Web bridge is reachable on loopback."
      : "Isolation is not ready. Keep ChatGPT Web unpublished until Router owns the Codex route and the 17841 bridge is reachable.",
  };
}
