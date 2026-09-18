import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_AUTO_RESUME_REPOSITORY = "https://github.com/feifeigong/codex-auto-resume.git";
export const CODEX_AUTO_RESUME_AUDITED_COMMIT = "1b2dae9d862573adc727b8d273d2760785344351";
const WINDOWS_TASK_NAME = "VibcodingCodexAutoResume";
const MACOS_LAUNCH_AGENT = "com.vibcoding.codex-auto-resume";
const RUN_TIMEOUT_MS = 60_000;

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

function threadRows(state) {
  const threads = state?.threads && typeof state.threads === "object" ? state.threads : {};
  return Object.values(threads)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      threadId: cleanText(entry.thread_id, 80),
      enabled: entry.enabled !== false,
      status: cleanText(entry.status, 80) || "unknown",
      resumes: Number.isFinite(Number(entry.resumes)) ? Number(entry.resumes) : 0,
      lastError: cleanText(entry.last_error, 240) || undefined,
    }));
}

export function getCodexAutoResumeSnapshot(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const root = codexAutoResumeRoot({ platform, env, home });
  const stateDir = codexAutoResumeStateDir({ platform, env, home });
  const runPy = path.join(root, "run.py");
  const installed = existsSync(runPy);
  const config = readJson(path.join(stateDir, "config.json"));
  const state = readJson(path.join(stateDir, "state.json"));
  const pid = Number.parseInt(cleanText(readText(path.join(stateDir, "watch.pid"), 32), 32), 10);
  const allThreads = threadRows(state);
  const threads = allThreads.slice(0, 12);

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
    lastStatus: cleanText(state?.last_status, 120) || undefined,
    lastCheckedAt: Number.isFinite(Number(state?.last_checked_at)) ? Number(state.last_checked_at) : undefined,
    trackedThreads: allThreads.length,
    activeThreads: allThreads.filter((thread) => thread.enabled).length,
    threads,
    why: platform === "win32" || platform === "darwin"
      ? installed ? undefined : "Sidecar is not installed yet."
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

export function controlCodexAutoResume(action) {
  const root = codexAutoResumeRoot();
  if (action === "install") {
    installSidecar(root);
    setAutoRedeemWeeklyReset(false);
    return { ...getCodexAutoResumeSnapshot(), report: "Sidecar installed with weekly reset-credit auto-redeem disabled. Autostart remains disabled until explicitly enabled." };
  }

  requireInstalled(root);
  const python = pythonCommand();
  if (action === "doctor") {
    const report = spawnChecked(python, ["run.py", "doctor"], { cwd: root, timeoutMs: 45_000 });
    return { ...getCodexAutoResumeSnapshot(), report };
  }
  if (action === "dry-run") {
    const report = spawnChecked(python, ["run.py", "once", "--dry-run"], { cwd: root, timeoutMs: 45_000 });
    return { ...getCodexAutoResumeSnapshot(), report };
  }
  if (action === "enable-autostart") {
    setAutoRedeemWeeklyReset(false);
    const report = spawnChecked(python, ["run.py", "install-autostart"], { cwd: root, timeoutMs: 90_000 });
    return { ...getCodexAutoResumeSnapshot(), report };
  }
  if (action === "enable-reset-credit") {
    setAutoRedeemWeeklyReset(true);
    return { ...getCodexAutoResumeSnapshot(), report: "Weekly reset-credit auto-redeem enabled explicitly." };
  }
  if (action === "disable-reset-credit") {
    setAutoRedeemWeeklyReset(false);
    return { ...getCodexAutoResumeSnapshot(), report: "Weekly reset-credit auto-redeem disabled." };
  }
  if (action === "disable-autostart") {
    const report = spawnChecked(python, ["run.py", "uninstall-autostart"], { cwd: root, timeoutMs: 90_000 });
    return { ...getCodexAutoResumeSnapshot(), report };
  }
  throw new Error("Unsupported codex-auto-resume action.");
}
