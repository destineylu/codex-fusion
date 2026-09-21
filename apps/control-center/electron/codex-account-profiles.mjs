import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const MANIFEST_VERSION = 1;
const ACTIVE_VERSION = 1;
const SWITCH_HISTORY_VERSION = 1;
const SWITCH_HISTORY_LIMIT = 256;
const LABEL_MAX_LENGTH = 64;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let activeBrowserLoginSession;
let activeDeviceLoginSession;

function cleanLabel(value) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LABEL_MAX_LENGTH);
  if (!label) throw new Error("Account name is required.");
  return label;
}

function readJsonObject(file) {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function readAuth(file) {
  if (!existsSync(file)) return undefined;
  try {
    const buffer = readFileSync(file);
    const parsed = JSON.parse(buffer.toString("utf8"));
    const accessToken = typeof parsed?.tokens?.access_token === "string"
      ? parsed.tokens.access_token
      : "";
    if (!accessToken) return undefined;
    const accountId = typeof parsed?.tokens?.account_id === "string"
      ? parsed.tokens.account_id
      : "";
    const refreshable = typeof parsed?.tokens?.refresh_token === "string"
      && parsed.tokens.refresh_token.length > 0;
    const expiresAtMs = tokenExpiryMs(accessToken);
    const expired = expiresAtMs !== undefined && expiresAtMs <= Date.now() + 120_000;
    const identityFingerprint = accountId
      ? createHash("sha256").update(`account:${accountId}`).digest("hex").slice(0, 12)
      : undefined;
    const credentialFingerprint = createHash("sha256")
      .update(accountId ? `account:${accountId}` : `token:${accessToken}`)
      .digest("hex");
    return {
      buffer,
      identityFingerprint,
      credentialFingerprint,
      expiresAtMs,
      expired,
      refreshable,
      lastRefresh: typeof parsed?.last_refresh === "string" ? parsed.last_refresh : undefined,
    };
  } catch {
    return undefined;
  }
}

function privateAclScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$path = $env:CODEX_ROUTER_PRIVATE_FILE",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = [System.Security.AccessControl.FileSecurity]::new()",
    "[void]$acl.SetAccessRuleProtection($true, $false)",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)",
    "[void]$acl.AddAccessRule($rule)",
    "[System.IO.File]::SetAccessControl($path, $acl)",
  ].join("; ");
}

function protectPrivateFile(file, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  chmodSync(file, 0o600);
  if (platform !== "win32") return;
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", privateAclScript()],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: file },
      windowsHide: true,
      shell: false,
      timeout: 10_000,
    },
  );
  if (result?.error || result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || result?.error?.message || "").trim();
    throw new Error(detail ? `Failed to protect account file: ${detail}` : "Failed to protect account file.");
  }
}

function writePrivateBuffer(file, buffer, options = {}) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (options.platform !== "win32") {
    try { chmodSync(directory, 0o700); } catch { /* best effort for an existing parent */ }
  }
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, buffer, { mode: 0o600 });
    protectPrivateFile(temporary, options);
    renameSync(temporary, file);
    if (options.platform !== "win32") chmodSync(file, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writePrivateJson(file, value, options = {}) {
  writePrivateBuffer(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), options);
  return value;
}

function codexHome({ env = process.env, home = os.homedir() } = {}) {
  const override = String(env.CODEX_HOME || "").trim();
  return override && path.isAbsolute(override) ? path.resolve(override) : path.join(home, ".codex");
}

export function codexAccountProfilesRoot({
  env = process.env,
  home = os.homedir(),
} = {}) {
  const override = String(env.CODEX_ROUTER_CODEX_ACCOUNT_ROOT || "").trim();
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(codexHome({ env, home }), "codex-router", "native-accounts");
}

function accountPaths(options = {}) {
  const root = options.root || codexAccountProfilesRoot(options);
  return {
    root,
    profilesDir: path.join(root, "profiles"),
    manifest: path.join(root, "accounts.json"),
    active: path.join(root, "active-account.json"),
    history: path.join(root, "switch-history.json"),
    rollback: path.join(root, "last-switch-backup.json"),
    liveAuth: path.join(codexHome(options), "auth.json"),
  };
}

function profileHome(root, id) {
  if (!UUID.test(String(id || ""))) throw new Error("Invalid account profile id.");
  return path.join(root, "profiles", id);
}

function profileAuth(root, id) {
  return path.join(profileHome(root, id), "auth.json");
}

function readManifest(paths) {
  const value = readJsonObject(paths.manifest);
  const rows = value?.version === MANIFEST_VERSION && Array.isArray(value.profiles)
    ? value.profiles
    : [];
  return {
    version: MANIFEST_VERSION,
    profiles: rows.filter((row) => row && UUID.test(String(row.id || ""))).map((row) => ({
      id: row.id,
      label: cleanLabel(row.label || "ChatGPT account"),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
      identityFingerprint: typeof row.identityFingerprint === "string" ? row.identityFingerprint : undefined,
    })),
  };
}

function readActive(paths) {
  const value = readJsonObject(paths.active);
  if (value?.version !== ACTIVE_VERSION || !UUID.test(String(value.id || ""))) return undefined;
  return {
    version: ACTIVE_VERSION,
    id: value.id,
    switchedAt: typeof value.switchedAt === "string" ? value.switchedAt : undefined,
  };
}

function saveManifest(paths, manifest, options) {
  return writePrivateJson(paths.manifest, manifest, options);
}

function readSwitchHistory(paths) {
  const value = readJsonObject(paths.history);
  const rows = value?.version === SWITCH_HISTORY_VERSION && Array.isArray(value.activations)
    ? value.activations
    : [];
  return {
    version: SWITCH_HISTORY_VERSION,
    activations: rows
      .filter((row) => (
        row
        && UUID.test(String(row.profileId || ""))
        && /^[a-f0-9]{12}$/i.test(String(row.accountFingerprint || ""))
        && Number.isFinite(Date.parse(String(row.activatedAt || "")))
      ))
      .map((row) => ({
        profileId: row.profileId,
        accountFingerprint: String(row.accountFingerprint).toLowerCase(),
        activatedAt: new Date(Date.parse(row.activatedAt)).toISOString(),
      }))
      .sort((left, right) => Date.parse(left.activatedAt) - Date.parse(right.activatedAt)),
  };
}

function profileFingerprint(paths, id) {
  const auth = readAuth(profileAuth(paths.root, id));
  return auth?.identityFingerprint;
}

function appendActivation(history, activation) {
  if (!activation?.profileId || !activation?.accountFingerprint || !activation?.activatedAt) return history;
  const previous = history.activations.at(-1);
  if (
    previous
    && previous.profileId === activation.profileId
    && previous.accountFingerprint === activation.accountFingerprint
  ) {
    return history;
  }
  return {
    version: SWITCH_HISTORY_VERSION,
    activations: [...history.activations, activation].slice(-SWITCH_HISTORY_LIMIT),
  };
}

function saveActive(paths, id, options) {
  const previous = readActive(paths);
  let history = readSwitchHistory(paths);

  if (previous?.id && previous.switchedAt) {
    const previousFingerprint = profileFingerprint(paths, previous.id);
    if (previousFingerprint) {
      history = appendActivation(history, {
        profileId: previous.id,
        accountFingerprint: previousFingerprint,
        activatedAt: previous.switchedAt,
      });
    }
  }

  const sameProfile = previous?.id === id;
  const switchedAt = sameProfile && previous?.switchedAt
    ? previous.switchedAt
    : new Date().toISOString();
  const result = writePrivateJson(paths.active, {
    version: ACTIVE_VERSION,
    id,
    switchedAt,
  }, options);

  const targetFingerprint = profileFingerprint(paths, id);
  if (targetFingerprint) {
    history = appendActivation(history, {
      profileId: id,
      accountFingerprint: targetFingerprint,
      activatedAt: switchedAt,
    });
    writePrivateJson(paths.history, history, options);
  }
  return result;
}

function updateProfileMetadata(manifest, id, auth) {
  const now = new Date().toISOString();
  return {
    ...manifest,
    profiles: manifest.profiles.map((row) => row.id === id ? {
      ...row,
      updatedAt: now,
      ...(auth?.identityFingerprint ? { identityFingerprint: auth.identityFingerprint } : {}),
    } : row),
  };
}

function addProfileMetadata(manifest, { id, label, auth }) {
  const now = new Date().toISOString();
  return {
    ...manifest,
    profiles: [
      ...manifest.profiles,
      {
        id,
        label: cleanLabel(label),
        createdAt: now,
        updatedAt: now,
        ...(auth?.identityFingerprint ? { identityFingerprint: auth.identityFingerprint } : {}),
      },
    ],
  };
}

function requireProfile(manifest, id) {
  const row = manifest.profiles.find((profile) => profile.id === id);
  if (!row) throw new Error("ChatGPT account profile was not found.");
  return row;
}

function profileStatus(paths, row, active, liveAuth) {
  const auth = readAuth(profileAuth(paths.root, row.id));
  const markedActive = active?.id === row.id;
  const liveMatches = Boolean(
    markedActive
    && auth
    && liveAuth
    && auth.credentialFingerprint === liveAuth.credentialFingerprint
  );
  return {
    ...row,
    active: liveMatches,
    markedActive,
    liveMatches,
    usable: Boolean(auth) && (!auth.expired || auth.refreshable),
    expired: Boolean(auth?.expired),
    refreshRequired: Boolean(auth?.expired && auth?.refreshable),
    ...(auth?.expiresAtMs !== undefined
      ? { expiresInHours: Math.round(((auth.expiresAtMs - Date.now()) / 36e5) * 10) / 10 }
      : {}),
    ...(auth?.identityFingerprint ? { identityFingerprint: auth.identityFingerprint } : {}),
  };
}

export function isWindowsCodexDesktopExecutable(file) {
  const normalized = String(file || "").replaceAll("/", "\\");
  return [
    /\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:Codex|ChatGPT)\.exe$/i,
    /\\AppData\\Local\\Programs\\(?:OpenAI\\)?Codex\\(?:Codex|ChatGPT)\.exe$/i,
    /\\Program Files(?: \(x86\))?\\OpenAI\\Codex\\(?:Codex|ChatGPT)\.exe$/i,
  ].some((pattern) => pattern.test(normalized));
}

export function codexDesktopRunning({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform === "win32") {
    // Codex Desktop and Codex CLI both use a process named Codex.exe. A plain
    // tasklist name check therefore treats npm CLI/app-server processes as the
    // Desktop app and permanently blocks account switching. Ask Windows for
    // executable paths and only count known Desktop installation roots.
    const result = spawnSyncImpl(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch { '__CODEX_PATH_UNREADABLE__' } }",
      ],
      { encoding: "utf8", windowsHide: true, shell: false, timeout: 3_000 },
    );
    if (result?.error || result?.status !== 0) return true;
    const paths = String(result.stdout || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (paths.includes("__CODEX_PATH_UNREADABLE__")) return true;
    return paths.some(isWindowsCodexDesktopExecutable);
  }
  if (platform === "darwin") {
    for (const name of ["Codex", "ChatGPT"]) {
      const result = spawnSyncImpl("pgrep", ["-x", name], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 3_000,
      });
      if (!result?.error && result?.status === 0) return true;
    }
  }
  return false;
}

function newestDesktopCodex(localAppData) {
  const directory = localAppData && path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!directory || !existsSync(directory)) return undefined;
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

export function findCodexLoginBinary({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnSyncImpl = spawnSync,
} = {}) {
  const candidates = [];
  const explicit = String(env.CODEX_BIN || "").trim();
  if (explicit && path.isAbsolute(explicit)) candidates.push(explicit);
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    candidates.push(
      newestDesktopCodex(localAppData),
      path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
      path.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    );
  } else {
    candidates.push("/usr/local/bin/codex", path.join(home, ".local", "bin", "codex"));
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (existsSync(candidate)) return path.resolve(candidate);
  }

  const finder = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncImpl(finder, ["codex"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 3_000,
  });
  if (result?.error || result?.status !== 0) return undefined;
  const found = String(result.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (platform === "win32") {
    return found.find((value) => /\.(?:exe|com|cmd|bat)$/i.test(value));
  }
  return found[0];
}

function spawnLoginProcess(binary, profileHomePath, {
  platform = process.platform,
  env = process.env,
  spawnImpl = spawn,
  loginArgs = ["login"],
  stdio = "ignore",
} = {}) {
  const childEnv = { ...env, CODEX_HOME: profileHomePath };
  delete childEnv.OPENAI_BASE_URL;
  delete childEnv.OPENAI_API_BASE;
  delete childEnv.OPENAI_API_KEY;
  let command = binary;
  let args = [...loginArgs];
  let options = {};
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)) {
    if (/["<>|?*\u0000-\u001f]/.test(binary)) {
      throw new Error("Refusing to run an invalid Codex CLI path.");
    }
    command = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const escapedArgs = loginArgs.map((value) => {
      if (/["\r\n]/.test(value)) throw new Error("Refusing to run invalid Codex login arguments.");
      return value;
    }).join(" ");
    args = ["/d", "/s", "/c", `"\"${binary}\" ${escapedArgs}"`];
    options = { windowsVerbatimArguments: true };
  }
  return spawnImpl(command, args, {
    ...options,
    env: childEnv,
    stdio,
    windowsHide: true,
    shell: false,
  });
}

export async function runOfficialCodexLogin(profileHomePath, options = {}) {
  const binary = options.binary || findCodexLoginBinary(options);
  if (!binary) {
    throw new Error("The official Codex CLI was not found. Install or update Codex, then retry.");
  }
  mkdirSync(profileHomePath, { recursive: true, mode: 0o700 });
  const child = spawnLoginProcess(binary, profileHomePath, options);
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error("Codex login timed out before browser sign-in completed."));
    }, options.loginTimeoutMs || LOGIN_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Codex login exited with code ${code ?? "unknown"}.`));
    });
  });
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function parseCodexBrowserLoginOutput(value) {
  const text = stripAnsi(value);
  const authorizationUrl = text.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s<>"']+/i)?.[0];
  if (!authorizationUrl) return {};
  try {
    const parsed = new URL(authorizationUrl);
    const redirect = parsed.searchParams.get("redirect_uri");
    const redirectUrl = redirect ? new URL(redirect) : undefined;
    return {
      authorizationUrl,
      expectedState: parsed.searchParams.get("state") || undefined,
      callbackPort: redirectUrl?.port ? Number(redirectUrl.port) : 1455,
    };
  } catch {
    return { authorizationUrl };
  }
}

function publicBrowserLoginSession() {
  if (!activeBrowserLoginSession) return undefined;
  const session = activeBrowserLoginSession;
  return {
    id: session.id,
    label: session.label,
    mode: "browser",
    status: session.status,
    startedAt: session.startedAt,
    ...(session.authorizationUrl ? { authorizationUrl: session.authorizationUrl } : {}),
    ...(session.callbackSubmittedAt ? { callbackSubmittedAt: session.callbackSubmittedAt } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.report ? { report: session.report } : {}),
  };
}

function updateBrowserLoginOutput(session, chunk) {
  if (!session || session.status === "cancelled") return;
  session.output = `${session.output || ""}${String(chunk || "")}`.slice(-32_768);
  const parsed = parseCodexBrowserLoginOutput(session.output);
  if (parsed.authorizationUrl) session.authorizationUrl = parsed.authorizationUrl;
  if (parsed.expectedState) session.expectedState = parsed.expectedState;
  if (parsed.callbackPort) session.callbackPort = parsed.callbackPort;
  if (session.status === "starting") session.status = "waiting";
}

function finishBrowserLoginSession(session, code, options = {}) {
  if (!session || activeBrowserLoginSession !== session || session.status === "cancelled") return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = undefined;
  if (code !== 0) {
    session.status = "failed";
    const cleanOutput = stripAnsi(session.output || "");
    const errorLine = cleanOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0];
    session.error = errorLine || `Codex browser login exited with code ${code ?? "unknown"}.`;
    rmSync(session.home, { recursive: true, force: true });
    return;
  }

  try {
    const paths = accountPaths(options);
    let manifest = readManifest(paths);
    const auth = normalizeStoredProfile(paths, session.profileId, options);
    if (manifest.profiles.some((row) => {
      const existing = readAuth(profileAuth(paths.root, row.id));
      return existing && existing.credentialFingerprint === auth.credentialFingerprint;
    })) {
      rmSync(session.home, { recursive: true, force: true });
      throw new Error("This ChatGPT account is already saved in Control Center.");
    }
    manifest = addProfileMetadata(manifest, {
      id: session.profileId,
      label: session.label,
      auth,
    });
    saveManifest(paths, manifest, options);
    session.status = "completed";
    session.report = "浏览器 OAuth 已完成，新账号已保存；当前活动账号未改变，Router 未重启。";
  } catch (error) {
    session.status = "failed";
    session.error = error instanceof Error ? error.message : "Codex browser login could not be saved.";
    rmSync(session.home, { recursive: true, force: true });
  }
}

export function startCodexAccountBrowserLogin(label, options = {}) {
  if (
    (activeBrowserLoginSession && ["starting", "waiting"].includes(activeBrowserLoginSession.status))
    || (activeDeviceLoginSession && ["starting", "waiting"].includes(activeDeviceLoginSession.status))
  ) {
    throw new Error("已有 ChatGPT 登录正在进行，请先完成或取消。");
  }

  const paths = accountPaths(options);
  mkdirSync(paths.profilesDir, { recursive: true, mode: 0o700 });
  let manifest = readManifest(paths);
  ({ manifest } = captureUnmanagedLiveAccount(paths, manifest, options));

  const binary = options.binary || findCodexLoginBinary(options);
  if (!binary) {
    throw new Error("The official Codex CLI was not found. Install or update Codex, then retry.");
  }

  const profileId = randomUUID();
  const home = profileHome(paths.root, profileId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const session = {
    id: randomUUID(),
    profileId,
    label: cleanLabel(label),
    home,
    status: "starting",
    startedAt: new Date().toISOString(),
    output: "",
    callbackPort: 1455,
    child: undefined,
    timer: undefined,
  };
  activeBrowserLoginSession = session;

  try {
    const child = spawnLoginProcess(binary, home, {
      ...options,
      loginArgs: ["login"],
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    child.stdout?.on?.("data", (chunk) => updateBrowserLoginOutput(session, chunk));
    child.stderr?.on?.("data", (chunk) => updateBrowserLoginOutput(session, chunk));
    child.once("error", (error) => {
      if (activeBrowserLoginSession !== session || session.status === "cancelled") return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = undefined;
      session.status = "failed";
      session.error = error instanceof Error ? error.message : "Could not start Codex browser login.";
      rmSync(session.home, { recursive: true, force: true });
    });
    child.once("exit", (code) => finishBrowserLoginSession(session, code, options));
    session.timer = setTimeout(() => {
      if (activeBrowserLoginSession !== session || !["starting", "waiting"].includes(session.status)) return;
      session.status = "failed";
      session.error = "Codex browser login timed out before OAuth callback completed.";
      try { session.child?.kill(); } catch { /* ignore */ }
      rmSync(session.home, { recursive: true, force: true });
    }, options.loginTimeoutMs || LOGIN_TIMEOUT_MS);
    queueMicrotask(() => {
      if (activeBrowserLoginSession === session && session.status === "starting") session.status = "waiting";
    });
  } catch (error) {
    activeBrowserLoginSession = undefined;
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "官方 Codex 浏览器 OAuth 已启动。可在无痕窗口完成登录；若 localhost 回调打不开，把完整回调 URL 粘贴回 Control Center。",
  };
}

function validateCodexCallbackUrl(value, session) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("回调 URL 格式无效。请粘贴浏览器地址栏中完整的 localhost URL。");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error("只接受 http://localhost 或 http://127.0.0.1 的 Codex OAuth 回调。");
  }
  if (parsed.pathname !== "/auth/callback") {
    throw new Error("回调路径必须是 /auth/callback。");
  }
  const port = Number(parsed.port || 80);
  const expectedPort = Number(session?.callbackPort || 1455);
  if (port !== expectedPort) {
    throw new Error(`回调端口不匹配；当前登录会话正在等待 localhost:${expectedPort}。`);
  }
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  if (!code || !state) {
    throw new Error("回调 URL 缺少 code 或 state，请复制浏览器最终跳转后的完整地址。");
  }
  if (session?.expectedState && state !== session.expectedState) {
    throw new Error("OAuth state 与当前登录会话不匹配。请重新从本次 Control Center 登录窗口完成授权。");
  }
  return { parsed, port };
}

export async function submitCodexAccountCallback(callbackUrl, options = {}) {
  const session = activeBrowserLoginSession;
  if (!session || !["starting", "waiting"].includes(session.status)) {
    throw new Error("当前没有等待 localhost 回调的 ChatGPT 浏览器登录。");
  }
  const { parsed, port } = validateCodexCallbackUrl(callbackUrl, session);
  await new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      method: "GET",
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        Host: `localhost:${port}`,
        Connection: "close",
      },
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if ((response.statusCode || 500) >= 400) {
          reject(new Error(`Codex OAuth callback was rejected with HTTP ${response.statusCode || "unknown"}.`));
        } else {
          resolve();
        }
      });
    });
    req.once("timeout", () => {
      req.destroy(new Error("Timed out delivering the OAuth callback to the local Codex listener."));
    });
    req.once("error", (error) => reject(error));
    req.end();
  });
  session.callbackSubmittedAt = new Date().toISOString();
  session.report = "localhost 回调已转交给官方 Codex 登录进程，正在等待认证文件写入。";
  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: session.report,
  };
}

export function parseCodexDeviceLoginOutput(value) {
  const text = stripAnsi(value);
  const verificationUrl = text.match(/https:\/\/[^\s<>"']+\/codex\/device\b[^\s<>"']*/i)?.[0];
  const userCode = text.match(/one-time code[\s\S]{0,240}?\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)/i)?.[1]
    || text.match(/\b([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\b/)?.[1];
  return {
    ...(verificationUrl ? { verificationUrl } : {}),
    ...(userCode ? { userCode } : {}),
  };
}

function publicDeviceLoginSession() {
  if (!activeDeviceLoginSession) return undefined;
  const session = activeDeviceLoginSession;
  return {
    id: session.id,
    label: session.label,
    mode: "device",
    status: session.status,
    startedAt: session.startedAt,
    ...(session.verificationUrl ? { verificationUrl: session.verificationUrl } : {}),
    ...(session.userCode ? { userCode: session.userCode } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.report ? { report: session.report } : {}),
  };
}

function updateDeviceLoginOutput(session, chunk) {
  if (!session || session.status === "cancelled") return;
  session.output = `${session.output || ""}${String(chunk || "")}`.slice(-16_384);
  const parsed = parseCodexDeviceLoginOutput(session.output);
  if (parsed.verificationUrl) session.verificationUrl = parsed.verificationUrl;
  if (parsed.userCode) session.userCode = parsed.userCode;
  if (session.verificationUrl && session.userCode && session.status === "starting") {
    session.status = "waiting";
  }
}

function finishDeviceLoginSession(session, code, options = {}) {
  if (!session || activeDeviceLoginSession !== session || session.status === "cancelled") return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = undefined;
  if (code !== 0) {
    session.status = "failed";
    const cleanOutput = stripAnsi(session.output || "");
    const errorLine = cleanOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-1)[0];
    session.error = errorLine || `Codex device login exited with code ${code ?? "unknown"}.`;
    rmSync(session.home, { recursive: true, force: true });
    return;
  }

  try {
    const paths = accountPaths(options);
    let manifest = readManifest(paths);
    const auth = normalizeStoredProfile(paths, session.profileId, options);
    if (manifest.profiles.some((row) => {
      const existing = readAuth(profileAuth(paths.root, row.id));
      return existing && existing.credentialFingerprint === auth.credentialFingerprint;
    })) {
      rmSync(session.home, { recursive: true, force: true });
      throw new Error("This ChatGPT account is already saved in Control Center.");
    }
    manifest = addProfileMetadata(manifest, {
      id: session.profileId,
      label: session.label,
      auth,
    });
    saveManifest(paths, manifest, options);
    session.status = "completed";
    session.report = "设备代码登录已完成，新账号已保存；当前活动账号未改变，Router 未重启。";
  } catch (error) {
    session.status = "failed";
    session.error = error instanceof Error ? error.message : "Codex device login could not be saved.";
    rmSync(session.home, { recursive: true, force: true });
  }
}

export function startCodexAccountDeviceLogin(label, options = {}) {
  if (
    (activeBrowserLoginSession && ["starting", "waiting"].includes(activeBrowserLoginSession.status))
    || (activeDeviceLoginSession && ["starting", "waiting"].includes(activeDeviceLoginSession.status))
  ) {
    throw new Error("已有 ChatGPT 登录正在进行，请先完成或取消。");
  }

  const paths = accountPaths(options);
  mkdirSync(paths.profilesDir, { recursive: true, mode: 0o700 });
  let manifest = readManifest(paths);
  ({ manifest } = captureUnmanagedLiveAccount(paths, manifest, options));

  const binary = options.binary || findCodexLoginBinary(options);
  if (!binary) {
    throw new Error("The official Codex CLI was not found. Install or update Codex, then retry.");
  }

  const profileId = randomUUID();
  const home = profileHome(paths.root, profileId);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const session = {
    id: randomUUID(),
    profileId,
    label: cleanLabel(label),
    home,
    status: "starting",
    startedAt: new Date().toISOString(),
    output: "",
    child: undefined,
    timer: undefined,
  };
  activeDeviceLoginSession = session;

  try {
    const child = spawnLoginProcess(binary, home, {
      ...options,
      loginArgs: ["login", "--device-auth"],
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    child.stdout?.on?.("data", (chunk) => updateDeviceLoginOutput(session, chunk));
    child.stderr?.on?.("data", (chunk) => updateDeviceLoginOutput(session, chunk));
    child.once("error", (error) => {
      if (activeDeviceLoginSession !== session || session.status === "cancelled") return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = undefined;
      session.status = "failed";
      session.error = error instanceof Error ? error.message : "Could not start Codex device login.";
      rmSync(session.home, { recursive: true, force: true });
    });
    child.once("exit", (code) => finishDeviceLoginSession(session, code, options));
    session.timer = setTimeout(() => {
      if (activeDeviceLoginSession !== session || !["starting", "waiting"].includes(session.status)) return;
      session.status = "failed";
      session.error = "Codex device login timed out after 15 minutes.";
      try { session.child?.kill(); } catch { /* ignore */ }
      rmSync(session.home, { recursive: true, force: true });
    }, options.deviceLoginTimeoutMs || DEVICE_LOGIN_TIMEOUT_MS);
  } catch (error) {
    activeDeviceLoginSession = undefined;
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "设备代码登录已启动。请在无痕窗口打开登录地址并输入一次性代码；Router 保持运行。",
  };
}

export function cancelCodexAccountLogin(options = {}) {
  const session = activeBrowserLoginSession || activeDeviceLoginSession;
  if (!session) {
    return {
      ...getCodexAccountProfilesSnapshot(options),
      report: "当前没有 ChatGPT 登录状态需要关闭。",
    };
  }
  if (session.timer) clearTimeout(session.timer);
  session.timer = undefined;
  if (["starting", "waiting"].includes(session.status)) {
    session.status = "cancelled";
    try { session.child?.kill(); } catch { /* ignore */ }
    rmSync(session.home, { recursive: true, force: true });
  }
  if (activeBrowserLoginSession === session) activeBrowserLoginSession = undefined;
  if (activeDeviceLoginSession === session) activeDeviceLoginSession = undefined;
  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "ChatGPT 登录状态已关闭；当前 Codex 账号和 Router 均未改变。",
  };
}

function normalizeStoredProfile(paths, id, options) {
  const authFile = profileAuth(paths.root, id);
  const auth = readAuth(authFile);
  if (!auth || auth.expired) {
    throw new Error("The ChatGPT login did not produce a usable Codex auth profile.");
  }
  const buffer = auth.buffer;
  rmSync(profileHome(paths.root, id), { recursive: true, force: true });
  writePrivateBuffer(authFile, buffer, options);
  return readAuth(authFile);
}

function captureUnmanagedLiveAccount(paths, manifest, options) {
  const active = readActive(paths);
  if (active && manifest.profiles.some((row) => row.id === active.id)) {
    return { manifest, active };
  }
  const liveAuth = readAuth(paths.liveAuth);
  if (!liveAuth) return { manifest, active: undefined };
  const id = randomUUID();
  writePrivateBuffer(profileAuth(paths.root, id), liveAuth.buffer, options);
  const nextManifest = addProfileMetadata(manifest, {
    id,
    label: "当前 Codex 账号",
    auth: liveAuth,
  });
  saveManifest(paths, nextManifest, options);
  saveActive(paths, id, options);
  return { manifest: nextManifest, active: { version: ACTIVE_VERSION, id } };
}

function syncActiveProfile(paths, manifest, options) {
  const active = readActive(paths);
  const liveAuth = readAuth(paths.liveAuth);
  if (!active || !manifest.profiles.some((row) => row.id === active.id)) {
    return captureUnmanagedLiveAccount(paths, manifest, options);
  }
  if (!liveAuth) return { manifest, active };
  writePrivateBuffer(profileAuth(paths.root, active.id), liveAuth.buffer, options);
  const nextManifest = updateProfileMetadata(manifest, active.id, liveAuth);
  saveManifest(paths, nextManifest, options);
  return { manifest: nextManifest, active };
}

export function getCodexAccountIdentityContext(options = {}) {
  const paths = accountPaths(options);
  const manifest = readManifest(paths);
  const active = readActive(paths);
  const liveAuth = readAuth(paths.liveAuth);
  const profiles = manifest.profiles.map((row) => profileStatus(paths, row, active, liveAuth));
  const activeProfile = profiles.find((row) => row.active);
  const history = readSwitchHistory(paths);
  const activations = [...history.activations];

  if (activeProfile?.identityFingerprint && active?.switchedAt) {
    const synthetic = {
      profileId: activeProfile.id,
      accountFingerprint: activeProfile.identityFingerprint.toLowerCase(),
      activatedAt: active.switchedAt,
    };
    const last = activations.at(-1);
    if (
      !last
      || last.profileId !== synthetic.profileId
      || last.accountFingerprint !== synthetic.accountFingerprint
    ) {
      activations.push(synthetic);
    }
  }

  return {
    activeProfileId: activeProfile?.id,
    // Auto Resume can safely scope a single unmanaged native login by the same
    // irreversible account fingerprint without copying credentials into a
    // Profile. Multi-account switching still requires managed Profiles.
    activeAccountFingerprint: (
      activeProfile?.identityFingerprint
      || liveAuth?.identityFingerprint
    )?.toLowerCase(),
    activeSince: activeProfile ? active?.switchedAt : undefined,
    profiles: profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      identityFingerprint: profile.identityFingerprint?.toLowerCase(),
      active: profile.active,
    })),
    activations: activations
      .filter((entry) => Number.isFinite(Date.parse(entry.activatedAt)))
      .sort((left, right) => Date.parse(left.activatedAt) - Date.parse(right.activatedAt)),
  };
}

export function getCodexAccountProfilesSnapshot(options = {}) {
  const paths = accountPaths(options);
  const manifest = readManifest(paths);
  const active = readActive(paths);
  const liveAuth = readAuth(paths.liveAuth);
  const profiles = manifest.profiles.map((row) => profileStatus(paths, row, active, liveAuth));
  const activeProfile = profiles.find((row) => row.active);
  return {
    supported: true,
    root: paths.root,
    profiles,
    activeAccountId: activeProfile?.id,
    markedActiveAccountId: active?.id,
    liveAuthPresent: Boolean(liveAuth),
    liveManaged: Boolean(activeProfile),
    desktopRunning: options.desktopRunning === undefined
      ? codexDesktopRunning(options)
      : Boolean(options.desktopRunning),
    routerRestartRequired: false,
    configMutationRequired: false,
    loginSession: publicBrowserLoginSession() || publicDeviceLoginSession(),
    why: active?.id && !activeProfile && liveAuth
      ? "The live Codex login no longer matches the account profile marked active. Another tool may have changed auth.json."
      : undefined,
  };
}

export async function addCodexAccount(label, options = {}) {
  if (
    (activeBrowserLoginSession && ["starting", "waiting"].includes(activeBrowserLoginSession.status))
    || (activeDeviceLoginSession && ["starting", "waiting"].includes(activeDeviceLoginSession.status))
  ) {
    throw new Error("已有 ChatGPT 登录正在进行，请先完成或取消。");
  }
  const paths = accountPaths(options);
  mkdirSync(paths.profilesDir, { recursive: true, mode: 0o700 });
  let manifest = readManifest(paths);
  ({ manifest } = captureUnmanagedLiveAccount(paths, manifest, options));

  const id = randomUUID();
  const home = profileHome(paths.root, id);
  const loginRunner = options.loginRunner || runOfficialCodexLogin;
  try {
    await loginRunner(home, options);
    const auth = normalizeStoredProfile(paths, id, options);
    if (manifest.profiles.some((row) => {
      const existing = readAuth(profileAuth(paths.root, row.id));
      return existing && existing.credentialFingerprint === auth.credentialFingerprint;
    })) {
      rmSync(home, { recursive: true, force: true });
      throw new Error("This ChatGPT account is already saved in Control Center.");
    }
    manifest = addProfileMetadata(manifest, { id, label, auth });
    saveManifest(paths, manifest, options);
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "账号已通过官方 Codex 登录保存。当前活动账号未改变，Router 未重启。",
  };
}

export function renameCodexAccount(id, label, options = {}) {
  const paths = accountPaths(options);
  const manifest = readManifest(paths);
  requireProfile(manifest, id);
  const next = {
    ...manifest,
    profiles: manifest.profiles.map((row) => row.id === id ? { ...row, label: cleanLabel(label) } : row),
  };
  saveManifest(paths, next, options);
  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "账号名称已更新；认证身份和 Router 配置均未改变。",
  };
}

export function deleteCodexAccount(id, options = {}) {
  const paths = accountPaths(options);
  const manifest = readManifest(paths);
  requireProfile(manifest, id);
  if (readActive(paths)?.id === id) {
    throw new Error("Cannot delete the active ChatGPT account. Switch to another account first.");
  }
  rmSync(profileHome(paths.root, id), { recursive: true, force: true });
  saveManifest(paths, {
    ...manifest,
    profiles: manifest.profiles.filter((row) => row.id !== id),
  }, options);
  return {
    ...getCodexAccountProfilesSnapshot(options),
    report: "账号 Profile 已删除；当前 Codex 登录和 Router 均未改变。",
  };
}

export function switchCodexAccount(id, options = {}) {
  const paths = accountPaths(options);
  const isDesktopRunning = options.desktopRunning === undefined
    ? codexDesktopRunning(options)
    : Boolean(options.desktopRunning);
  if (isDesktopRunning) {
    throw new Error("请先完全退出 Codex Desktop，再切换 ChatGPT 账号。Router 不需要退出或重启。");
  }

  let manifest = readManifest(paths);
  requireProfile(manifest, id);

  // Sync the current live auth first. This matters even when the caller asks
  // to "switch" to the already-active profile: Codex may have refreshed its
  // token since the profile was last stored, and reading the target before
  // this sync would write the stale profile copy back over the fresher live
  // auth.
  ({ manifest } = syncActiveProfile(paths, manifest, options));
  const targetAuth = readAuth(profileAuth(paths.root, id));
  if (!targetAuth || (targetAuth.expired && !targetAuth.refreshable)) {
    throw new Error("Target ChatGPT account login is unavailable. Add/login that account again first.");
  }
  const currentAuth = readAuth(paths.liveAuth);
  const activeBeforeBuffer = existsSync(paths.active) ? readFileSync(paths.active) : undefined;
  const historyBeforeBuffer = existsSync(paths.history) ? readFileSync(paths.history) : undefined;
  if (currentAuth) {
    writePrivateBuffer(paths.rollback, currentAuth.buffer, options);
  } else {
    // A previous successful switch may have left a useful historical backup.
    // It is not the rollback source for this transaction when live auth was
    // absent at entry, so remove it rather than ever restoring the wrong user.
    rmSync(paths.rollback, { force: true });
  }

  try {
    writePrivateBuffer(paths.liveAuth, targetAuth.buffer, options);
    const liveAfter = readAuth(paths.liveAuth);
    if (!liveAfter || liveAfter.credentialFingerprint !== targetAuth.credentialFingerprint) {
      throw new Error("The live Codex auth identity did not match the selected account after switching.");
    }
    saveActive(paths, id, options);
    manifest = updateProfileMetadata(manifest, id, liveAfter);
    saveManifest(paths, manifest, options);
  } catch (error) {
    try {
      if (currentAuth) writePrivateBuffer(paths.liveAuth, currentAuth.buffer, options);
      else rmSync(paths.liveAuth, { force: true });
    } catch { /* preserve original error */ }
    try {
      if (activeBeforeBuffer) writePrivateBuffer(paths.active, activeBeforeBuffer, options);
      else rmSync(paths.active, { force: true });
    } catch { /* preserve original error */ }
    try {
      if (historyBeforeBuffer) writePrivateBuffer(paths.history, historyBeforeBuffer, options);
      else rmSync(paths.history, { force: true });
    } catch { /* preserve original error */ }
    throw error;
  }

  return {
    ...getCodexAccountProfilesSnapshot({ ...options, desktopRunning: false }),
    report: "账号已切换。Router 全程保持运行；请重新打开 Codex Desktop 使用新账号。",
  };
}
