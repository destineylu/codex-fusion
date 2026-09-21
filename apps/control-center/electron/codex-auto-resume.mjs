import { spawn, spawnSync } from "node:child_process";
import {
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
import { getCodexAccountIdentityContext } from "./codex-account-profiles.mjs";

export const CODEX_AUTO_RESUME_REPOSITORY = "https://github.com/feifeigong/codex-auto-resume.git";
export const CODEX_AUTO_RESUME_AUDITED_COMMIT = "1b2dae9d862573adc727b8d273d2760785344351";
const WINDOWS_TASK_NAME = "VibcodingCodexAutoResume";
const MACOS_LAUNCH_AGENT = "com.vibcoding.codex-auto-resume";
const RUN_TIMEOUT_MS = 60_000;
const ACCOUNT_BINDINGS_VERSION = 1;
const ACCOUNT_SCOPE_VERSION = 1;
const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_FINGERPRINT = /^[a-f0-9]{12}$/i;

function dataRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") {
    return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return env.XDG_DATA_HOME || path.join(home, ".local", "share");
}

export function codexAutoResumeRoot({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const override = String(env.CODEX_AUTO_RESUME_ROOT || "").trim();
  if (override && path.isAbsolute(override)) return path.resolve(override);
  return path.join(dataRoot(platform, env, home), "codex-router-sidecars", "codex-auto-resume");
}

export function codexAutoResumeStateDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "vibcoding", "codex-auto-resume");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "vibcoding", "codex-auto-resume");
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "vibcoding", "codex-auto-resume");
}

function accountStateDir(controlDir, fingerprint) {
  if (!ACCOUNT_FINGERPRINT.test(String(fingerprint || ""))) {
    throw new Error("Native ChatGPT account fingerprint is unavailable.");
  }
  return path.join(controlDir, "accounts", String(fingerprint).toLowerCase());
}

function bindingsPath(controlDir) {
  return path.join(controlDir, "account-bindings.json");
}

function scopePath(stateDir) {
  return path.join(stateDir, "codex-fusion-account.json");
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readBindings(controlDir) {
  const value = readJson(bindingsPath(controlDir));
  const threads = value?.version === ACCOUNT_BINDINGS_VERSION && value.threads && typeof value.threads === "object"
    ? value.threads
    : {};
  const clean = {};
  for (const [threadId, row] of Object.entries(threads)) {
    if (!THREAD_UUID.test(threadId) || !row || typeof row !== "object") continue;
    const accountFingerprint = cleanText(row.accountFingerprint, 32).toLowerCase();
    if (!ACCOUNT_FINGERPRINT.test(accountFingerprint)) continue;
    clean[threadId] = {
      accountFingerprint,
      profileId: cleanText(row.profileId, 80) || undefined,
      boundAt: cleanText(row.boundAt, 80) || undefined,
      source: cleanText(row.source, 80) || undefined,
    };
  }
  return { version: ACCOUNT_BINDINGS_VERSION, threads: clean };
}

function writeBindings(controlDir, bindings) {
  writeJsonAtomic(bindingsPath(controlDir), {
    version: ACCOUNT_BINDINGS_VERSION,
    threads: bindings.threads,
  });
}

function configuredStateDir(controlDir, config) {
  const candidate = cleanText(config?.state_dir, 1_000);
  return candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : controlDir;
}

function emptySidecarState() {
  return {
    version: 1,
    last_status: "idle",
    last_quota_source: "",
    last_checked_at: 0,
    last_quota: {},
    last_reset_credit_at: 0,
    last_reset_credit_id: "",
    last_reset_credit_note: "",
    threads: {},
  };
}

function mergeThreadState(target, legacyThread) {
  const current = target && typeof target === "object" ? target : {};
  const legacy = legacyThread && typeof legacyThread === "object" ? legacyThread : {};
  // Legacy state is migration input only. Once an account-scoped state exists,
  // its handled/resume/phase fields are newer and must never be rolled back by
  // the pre-account-aware copy.
  return { ...legacy, ...current };
}

function profileLabel(context, fingerprint) {
  return context.profiles.find((profile) => profile.identityFingerprint === fingerprint)?.label;
}

function fingerprintAt(context, timestampSeconds) {
  if (!Number.isFinite(Number(timestampSeconds)) || Number(timestampSeconds) <= 0) return undefined;
  const timestamp = Number(timestampSeconds) * 1000;
  let match;
  for (const activation of context.activations) {
    const activatedAt = Date.parse(activation.activatedAt);
    if (!Number.isFinite(activatedAt) || activatedAt > timestamp) break;
    match = activation.accountFingerprint;
  }
  return ACCOUNT_FINGERPRINT.test(String(match || "")) ? String(match).toLowerCase() : undefined;
}

function findRolloutFile(root, threadId) {
  if (!existsSync(root) || !THREAD_UUID.test(threadId)) return undefined;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
      } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
        return candidate;
      }
    }
  }
  return undefined;
}

function threadObservedAtSeconds(threadId, thread, {
  env = process.env,
  home = os.homedir(),
} = {}) {
  const observed = Number(thread?.observed_at);
  if (Number.isFinite(observed) && observed > 0) return observed;
  const codexHome = String(env.CODEX_HOME || "").trim() || path.join(home, ".codex");
  const rollout = findRolloutFile(path.join(codexHome, "sessions"), threadId);
  if (!rollout) return undefined;
  try {
    return statSync(rollout).mtimeMs / 1000;
  } catch {
    return undefined;
  }
}

function parseWaitingThreadIds(report) {
  const ids = new Set();
  const pattern = /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi;
  for (const match of String(report || "").matchAll(pattern)) ids.add(match[1]);
  return [...ids];
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

function readText(file, limit = 4_000) {
  if (!existsSync(file)) return "";
  try {
    return String(readFileSync(file, "utf8")).slice(0, limit);
  } catch {
    return "";
  }
}

function cleanText(value, limit = 800) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function readVersion(root) {
  const init = path.join(root, "src", "codex_auto_resume", "__init__.py");
  if (!existsSync(init)) return undefined;
  try {
    return readFileSync(init, "utf8").match(/__version__\s*=\s*["']([^"']+)["']/)?.[1];
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

function spawnChecked(command, args, { cwd, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = cleanText(result.stderr || result.stdout, 1_200);
    throw new Error(detail || `${path.basename(command)} exited with code ${result.status}.`);
  }
  return cleanText(result.stdout || result.stderr, 4_000);
}

function accountStateFiles(controlDir) {
  const root = path.join(controlDir, "accounts");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ACCOUNT_FINGERPRINT.test(entry.name))
      .map((entry) => ({
        accountFingerprint: entry.name.toLowerCase(),
        stateDir: path.join(root, entry.name),
        state: readJson(path.join(root, entry.name, "state.json")),
      }));
  } catch {
    return [];
  }
}

function bindThread(bindings, threadId, accountFingerprint, context, source) {
  if (!THREAD_UUID.test(threadId) || !ACCOUNT_FINGERPRINT.test(String(accountFingerprint || ""))) return;
  const fingerprint = String(accountFingerprint).toLowerCase();
  bindings.threads[threadId] = {
    accountFingerprint: fingerprint,
    profileId: context.profiles.find((profile) => profile.identityFingerprint === fingerprint)?.id,
    boundAt: new Date().toISOString(),
    source,
  };
}

function reconcileBindings(controlDir, context, options = {}) {
  const bindings = readBindings(controlDir);

  // Account-scoped states are authoritative for threads first discovered while
  // that account was active. They never need to infer ownership from quota.
  for (const row of accountStateFiles(controlDir)) {
    const threads = row.state?.threads && typeof row.state.threads === "object" ? row.state.threads : {};
    for (const [threadId, thread] of Object.entries(threads)) {
      if (
        !bindings.threads[threadId]
        && !["account-mismatch", "account-unbound"].includes(cleanText(thread?.status, 80))
      ) {
        bindThread(bindings, threadId, row.accountFingerprint, context, "account-state");
      }
    }
  }

  // Legacy pre-account-aware state can only be attributed when the observed
  // timestamp falls inside a recorded native-account activation interval.
  const legacy = readJson(path.join(controlDir, "state.json"));
  const legacyThreads = legacy?.threads && typeof legacy.threads === "object" ? legacy.threads : {};
  for (const [threadId, thread] of Object.entries(legacyThreads)) {
    if (bindings.threads[threadId]) continue;
    const observedAt = threadObservedAtSeconds(threadId, thread, options);
    const inferred = fingerprintAt(context, observedAt);
    if (inferred) bindThread(bindings, threadId, inferred, context, "activation-timeline");
  }

  writeBindings(controlDir, bindings);
  return bindings;
}

function mergeLegacyThreadsIntoAccounts(controlDir, bindings) {
  const legacy = readJson(path.join(controlDir, "state.json"));
  const legacyThreads = legacy?.threads && typeof legacy.threads === "object" ? legacy.threads : {};
  for (const [threadId, thread] of Object.entries(legacyThreads)) {
    const fingerprint = bindings.threads[threadId]?.accountFingerprint;
    if (!fingerprint) continue;
    const stateDir = accountStateDir(controlDir, fingerprint);
    const stateFile = path.join(stateDir, "state.json");
    const state = readJson(stateFile) || emptySidecarState();
    state.threads = state.threads && typeof state.threads === "object" ? state.threads : {};
    state.threads[threadId] = mergeThreadState(state.threads[threadId], thread);
    writeJsonAtomic(stateFile, state);
  }
}

function findThreadRecord(controlDir, threadId) {
  const legacy = readJson(path.join(controlDir, "state.json"));
  const legacyThread = legacy?.threads?.[threadId];
  if (legacyThread && typeof legacyThread === "object") return legacyThread;
  for (const row of accountStateFiles(controlDir)) {
    const thread = row.state?.threads?.[threadId];
    if (thread && typeof thread === "object") return thread;
  }
  return undefined;
}

function maskForeignWaitingThreads(stateDir, waitingIds, bindings, activeFingerprint) {
  const stateFile = path.join(stateDir, "state.json");
  const state = readJson(stateFile) || emptySidecarState();
  state.threads = state.threads && typeof state.threads === "object" ? state.threads : {};
  for (const threadId of waitingIds) {
    const owner = bindings.threads[threadId]?.accountFingerprint;
    if (owner === activeFingerprint) continue;
    const current = state.threads[threadId] && typeof state.threads[threadId] === "object"
      ? state.threads[threadId]
      : { thread_id: threadId };
    state.threads[threadId] = {
      ...current,
      thread_id: threadId,
      enabled: false,
      status: owner ? "account-mismatch" : "account-unbound",
      last_error: owner
        ? `Bound to native account ${owner}; current account is ${activeFingerprint}.`
        : "Native account ownership is unknown; bind this thread explicitly before auto-resume.",
    };
  }
  writeJsonAtomic(stateFile, state);
}

function setScopedConfig(controlDir, stateDir) {
  const file = path.join(controlDir, "config.json");
  const config = readJson(file) || {};
  writeJsonAtomic(file, { ...config, state_dir: stateDir });
}

function ensureAccountScope(root, options = {}) {
  const controlDir = codexAutoResumeStateDir(options);
  const context = getCodexAccountIdentityContext(options);
  const activeFingerprint = context.activeAccountFingerprint;
  if (!activeFingerprint) {
    throw new Error("Auto Resume requires a live Codex account with a stable identity fingerprint.");
  }

  mkdirSync(controlDir, { recursive: true });
  const bindings = reconcileBindings(controlDir, context, options);
  mergeLegacyThreadsIntoAccounts(controlDir, bindings);

  const stateDir = accountStateDir(controlDir, activeFingerprint);
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(path.join(stateDir, "state.json"))) {
    writeJsonAtomic(path.join(stateDir, "state.json"), emptySidecarState());
  }
  writeJsonAtomic(scopePath(stateDir), {
    version: ACCOUNT_SCOPE_VERSION,
    profileId: context.activeProfileId || null,
    accountFingerprint: activeFingerprint,
    label: profileLabel(context, activeFingerprint),
    activatedAt: context.activeSince,
  });
  setScopedConfig(controlDir, stateDir);

  const python = pythonCommand();
  const dryRun = spawnChecked(python, ["run.py", "once", "--dry-run"], {
    cwd: root,
    timeoutMs: 45_000,
  });
  const waitingIds = parseWaitingThreadIds(dryRun);

  // Any new waiting thread first observed during the current activation can be
  // bound to the current account. Earlier unbound legacy threads stay blocked.
  for (const threadId of waitingIds) {
    if (bindings.threads[threadId]) continue;
    const observedAt = threadObservedAtSeconds(threadId, undefined, options);
    const inferred = fingerprintAt(context, observedAt);
    if (inferred) bindThread(bindings, threadId, inferred, context, "activation-timeline");
  }
  writeBindings(controlDir, bindings);
  mergeLegacyThreadsIntoAccounts(controlDir, bindings);
  maskForeignWaitingThreads(stateDir, waitingIds, bindings, activeFingerprint);

  return {
    context,
    activeFingerprint,
    activeLabel: profileLabel(context, activeFingerprint),
    stateDir,
    bindings,
    waitingIds,
    dryRun,
  };
}

function stopWatcherLifecycle(root) {
  const python = pythonCommand();
  return spawnChecked(python, ["run.py", "uninstall-autostart"], { cwd: root, timeoutMs: 90_000 });
}

function startWatcherOnly(root) {
  const python = pythonCommand();
  const child = spawn(python, ["run.py", "watch", "--quiet"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
    shell: false,
  });
  child.unref();
}

function restoreWatcherLifecycle(root, continuation) {
  if (!continuation?.installed) return;
  if (continuation.autostart) {
    const python = pythonCommand();
    spawnChecked(python, ["run.py", "install-autostart"], { cwd: root, timeoutMs: 90_000 });
  } else if (continuation.running) {
    startWatcherOnly(root);
  }
}

function pythonCommand() {
  const candidates = process.platform === "win32" ? ["python.exe", "python"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      env: process.env,
      timeout: 2_000,
      windowsHide: true,
      shell: false,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Python 3.10+ is required by codex-auto-resume.");
}

function autostartStatus(platform, home) {
  if (platform === "win32") {
    const startup = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "codex-auto-resume.vbs",
    );
    const task = spawnSync("schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME], {
      encoding: "utf8",
      timeout: 2_500,
      windowsHide: true,
      shell: false,
    });
    return (!task.error && task.status === 0) || existsSync(startup);
  }
  if (platform === "darwin") {
    return existsSync(path.join(home, "Library", "LaunchAgents", `${MACOS_LAUNCH_AGENT}.plist`));
  }
  return false;
}

function threadRows(state, bindings, context, scopeFingerprint) {
  const threads = state?.threads && typeof state.threads === "object" ? state.threads : {};
  const currentFingerprint = context.activeAccountFingerprint;
  return Object.values(threads)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const threadId = cleanText(entry.thread_id, 80);
      const status = cleanText(entry.status, 80) || "unknown";
      const accountFingerprint = bindings?.threads?.[threadId]?.accountFingerprint
        || (
          ACCOUNT_FINGERPRINT.test(String(scopeFingerprint || ""))
          && !["account-mismatch", "account-unbound"].includes(status)
            ? String(scopeFingerprint).toLowerCase()
            : undefined
        );
      return {
        threadId,
        enabled: entry.enabled !== false,
        status,
        resumes: Number.isFinite(Number(entry.resumes)) ? Number(entry.resumes) : 0,
        lastError: cleanText(entry.last_error, 240) || undefined,
        accountFingerprint,
        accountLabel: accountFingerprint ? profileLabel(context, accountFingerprint) : undefined,
        accountBinding: !accountFingerprint
          ? "unbound"
          : accountFingerprint === currentFingerprint
            ? "current"
            : "other",
      };
    });
}

export function getCodexAutoResumeSnapshot(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const root = codexAutoResumeRoot({ platform, env, home });
  const controlDir = codexAutoResumeStateDir({ platform, env, home });
  const runPy = path.join(root, "run.py");
  const installed = existsSync(runPy);
  const config = readJson(path.join(controlDir, "config.json"));
  const stateDir = configuredStateDir(controlDir, config);
  const state = readJson(path.join(stateDir, "state.json"));
  const context = getCodexAccountIdentityContext({ platform, env, home });
  const bindings = readBindings(controlDir);
  const scope = readJson(scopePath(stateDir));
  const pid = Number.parseInt(cleanText(readText(path.join(stateDir, "watch.pid"), 32), 32), 10);
  const allThreads = threadRows(state, bindings, context, scope?.accountFingerprint);
  const threads = allThreads.slice(0, 12);
  const activeFingerprint = context.activeAccountFingerprint;
  const accountGuarded = Boolean(
    activeFingerprint
    && scope?.accountFingerprint === activeFingerprint
    && path.resolve(stateDir) === path.resolve(accountStateDir(controlDir, activeFingerprint))
  );

  return {
    supported: platform === "win32" || platform === "darwin",
    installed,
    root,
    stateDir,
    repository: CODEX_AUTO_RESUME_REPOSITORY,
    version: installed ? readVersion(root) : undefined,
    running: processRunning(pid),
    autostart: autostartStatus(platform, home),
    enabled: typeof config?.enabled === "boolean" ? config.enabled : undefined,
    autoRedeemWeeklyReset: typeof config?.auto_redeem_weekly_reset === "boolean"
      ? config.auto_redeem_weekly_reset
      : undefined,
    accountFingerprint: activeFingerprint,
    accountLabel: activeFingerprint ? profileLabel(context, activeFingerprint) : undefined,
    accountGuarded,
    unboundThreads: allThreads.filter((thread) => thread.accountBinding === "unbound").length,
    mismatchedThreads: allThreads.filter((thread) => thread.accountBinding === "other").length,
    lastStatus: cleanText(state?.last_status, 120) || undefined,
    lastCheckedAt: Number.isFinite(Number(state?.last_checked_at)) ? Number(state.last_checked_at) : undefined,
    trackedThreads: allThreads.length,
    activeThreads: allThreads.filter((thread) => thread.enabled).length,
    threads,
    why: platform === "win32" || platform === "darwin"
      ? installed
        ? activeFingerprint
          ? undefined
          : "Native ChatGPT account identity is unavailable; account-aware auto-resume is fail-closed."
        : "Sidecar is not installed yet."
      : "codex-auto-resume upstream currently supports Windows and macOS autostart.",
  };
}

function setAutoRedeemWeeklyReset(enabled, options = {}) {
  const stateDir = codexAutoResumeStateDir(options);
  const file = path.join(stateDir, "config.json");
  const current = readJson(file) || {};
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ ...current, auto_redeem_weekly_reset: Boolean(enabled) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function requireInstalled(root) {
  if (!existsSync(path.join(root, "run.py"))) {
    throw new Error("codex-auto-resume is not installed. Install the sidecar first.");
  }
}

function installSidecar(root) {
  if (existsSync(root)) {
    if (existsSync(path.join(root, "run.py"))) return;
    throw new Error(`Refusing to overwrite existing directory: ${root}`);
  }
  mkdirSync(path.dirname(root), { recursive: true });
  const temporary = `${root}.install-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    spawnChecked("git", ["init", temporary]);
    spawnChecked("git", ["-C", temporary, "remote", "add", "origin", CODEX_AUTO_RESUME_REPOSITORY]);
    spawnChecked("git", ["-C", temporary, "fetch", "--depth", "1", "origin", CODEX_AUTO_RESUME_AUDITED_COMMIT], {
      timeoutMs: 120_000,
    });
    spawnChecked("git", ["-C", temporary, "checkout", "--detach", "FETCH_HEAD"]);
    if (!existsSync(path.join(temporary, "run.py"))) {
      throw new Error("The audited codex-auto-resume checkout is incomplete.");
    }
    renameSync(temporary, root);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function pauseCodexAutoResumeForAccountSwitch(options = {}) {
  const root = codexAutoResumeRoot(options);
  const snapshot = getCodexAutoResumeSnapshot(options);
  const continuation = {
    installed: snapshot.installed,
    running: snapshot.running,
    autostart: snapshot.autostart,
  };
  if (snapshot.installed && (snapshot.running || snapshot.autostart)) {
    stopWatcherLifecycle(root);
  }
  return continuation;
}

export function restoreCodexAutoResumeAfterAccountSwitch(continuation, options = {}) {
  const root = codexAutoResumeRoot(options);
  if (!continuation?.installed || !existsSync(path.join(root, "run.py"))) {
    return getCodexAutoResumeSnapshot(options);
  }
  const scope = ensureAccountScope(root, options);
  restoreWatcherLifecycle(root, continuation);
  return {
    ...getCodexAutoResumeSnapshot(options),
    report: `Auto Resume account scope switched to ${scope.activeLabel || scope.activeFingerprint} (${scope.activeFingerprint}).`,
  };
}

export function bindCodexAutoResumeThreadToCurrentAccount(threadId, options = {}) {
  const normalized = cleanText(threadId, 80);
  if (!THREAD_UUID.test(normalized)) throw new Error("Invalid Codex thread id.");
  const root = codexAutoResumeRoot(options);
  requireInstalled(root);
  const continuation = pauseCodexAutoResumeForAccountSwitch(options);
  try {
    const scope = ensureAccountScope(root, options);
    const controlDir = codexAutoResumeStateDir(options);
    const bindings = readBindings(controlDir);
    bindThread(bindings, normalized, scope.activeFingerprint, scope.context, "explicit-user-bind");
    writeBindings(controlDir, bindings);

    const stateFile = path.join(scope.stateDir, "state.json");
    const state = readJson(stateFile) || emptySidecarState();
    state.threads = state.threads && typeof state.threads === "object" ? state.threads : {};
    const source = findThreadRecord(controlDir, normalized) || { thread_id: normalized };
    state.threads[normalized] = {
      ...source,
      thread_id: normalized,
      enabled: true,
      status: "watching",
      last_error: "",
    };
    writeJsonAtomic(stateFile, state);

    for (const row of accountStateFiles(controlDir)) {
      if (row.accountFingerprint === scope.activeFingerprint || !row.state?.threads?.[normalized]) continue;
      const other = row.state;
      other.threads[normalized] = {
        ...other.threads[normalized],
        enabled: false,
        status: "account-mismatch",
        last_error: `Bound to native account ${scope.activeFingerprint}.`,
      };
      writeJsonAtomic(path.join(row.stateDir, "state.json"), other);
    }

    restoreWatcherLifecycle(root, continuation);
    return {
      ...getCodexAutoResumeSnapshot(options),
      report: `Thread ${normalized} is now bound to ${scope.activeLabel || scope.activeFingerprint} (${scope.activeFingerprint}).`,
    };
  } catch (error) {
    try { restoreWatcherLifecycle(root, continuation); } catch { /* preserve original error */ }
    throw error;
  }
}

export function controlCodexAutoResume(action, options = {}) {
  const root = codexAutoResumeRoot(options);
  if (action === "install") {
    installSidecar(root);
    setAutoRedeemWeeklyReset(false, options);
    const scope = ensureAccountScope(root, options);
    return {
      ...getCodexAutoResumeSnapshot(options),
      report: `Sidecar installed for ${scope.activeLabel || scope.activeFingerprint} (${scope.activeFingerprint}); weekly reset-credit auto-redeem is disabled and autostart remains off.`,
    };
  }

  requireInstalled(root);
  const python = pythonCommand();
  if (action === "doctor") {
    const scope = ensureAccountScope(root, options);
    const report = spawnChecked(python, ["run.py", "doctor"], { cwd: root, timeoutMs: 45_000 });
    return {
      ...getCodexAutoResumeSnapshot(options),
      report: `${report} account_guard ${scope.activeLabel || scope.activeFingerprint} fingerprint=${scope.activeFingerprint}`.trim(),
    };
  }
  if (action === "dry-run") {
    const scope = ensureAccountScope(root, options);
    const currentWaiting = scope.waitingIds.filter((threadId) => scope.bindings.threads[threadId]?.accountFingerprint === scope.activeFingerprint);
    const blocked = scope.waitingIds.length - currentWaiting.length;
    const report = [
      `account ${scope.activeLabel || scope.activeFingerprint} fingerprint=${scope.activeFingerprint}`,
      `dry-run waiting=${currentWaiting.length} blocked=${blocked}`,
      ...currentWaiting.map((threadId) => `  ${threadId} usage-limit`),
    ].join("\n");
    return { ...getCodexAutoResumeSnapshot(options), report };
  }
  if (action === "enable-autostart") {
    const scope = ensureAccountScope(root, options);
    setAutoRedeemWeeklyReset(false, options);
    const report = spawnChecked(python, ["run.py", "install-autostart"], { cwd: root, timeoutMs: 90_000 });
    return {
      ...getCodexAutoResumeSnapshot(options),
      report: `${report} account_guard=${scope.activeFingerprint}`.trim(),
    };
  }
  if (action === "enable-reset-credit") {
    setAutoRedeemWeeklyReset(true, options);
    return { ...getCodexAutoResumeSnapshot(options), report: "Weekly reset-credit auto-redeem enabled explicitly." };
  }
  if (action === "disable-reset-credit") {
    setAutoRedeemWeeklyReset(false, options);
    return { ...getCodexAutoResumeSnapshot(options), report: "Weekly reset-credit auto-redeem disabled." };
  }
  if (action === "disable-autostart") {
    const report = stopWatcherLifecycle(root);
    return { ...getCodexAutoResumeSnapshot(options), report };
  }
  throw new Error("Unsupported codex-auto-resume action.");
}
