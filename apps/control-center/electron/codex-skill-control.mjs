import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_NAME = "switch-codex-mode.ps1";
const ACTIONS = new Set(["status", "skills", "preview", "light", "full", "skill-on", "skill-off"]);
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_DISCOVERED_SKILLS = 512;
const LIGHT_DEFAULT_MARKER = "control-center-light-default-v1";
const CORE_AGENT_PATTERNS = [
  /^code-/i,
  /^architecture-designer-/i,
  /^brainstorming-/i,
  /^executing-plans-/i,
  /^find-skills$/i,
  /^frontend-design/i,
  /^git-essentials-/i,
  /^memory-/i,
  /^security-auditor-/i,
  /^session-logs-/i,
  /^ui-ux-pro-max-/i,
  /^writing-plans-/i,
];
const REMOTE_APP_PLUGIN_IDS = new Set(["canva", "notion", "supabase", "heygen"]);

function normalizeSkillPath(value) {
  return path.resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

function sourceLabel(filePath, home) {
  const normalizedHome = path.resolve(home);
  const relative = path.relative(normalizedHome, filePath).replaceAll("\\", "/");
  return relative.startsWith("..") ? path.basename(path.dirname(filePath)) : `~/${relative}`;
}

function boundedSkillFiles(root, limit = MAX_DISCOVERED_SKILLS) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const candidate = path.join(current, entry.name);
      let stat;
      try { stat = lstatSync(candidate); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name === "SKILL.md" && stat.size <= MAX_SKILL_FILE_BYTES) files.push(candidate);
    }
  }
  return files;
}

function unquoteYamlScalar(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function inspectSkillDocument(contents = "", fallbackName = "skill") {
  const text = String(contents).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { valid: false, name: fallbackName, description: "", error: "Missing YAML frontmatter" };
  }
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) {
    return { valid: false, name: fallbackName, description: "", error: "Unterminated YAML frontmatter" };
  }
  const frontmatter = lines.slice(1, closing + 1);
  let name = "";
  let description = "";
  let collectingDescription = false;
  const descriptionLines = [];
  for (const line of frontmatter) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(line);
    if (collectingDescription && indented) {
      descriptionLines.push(line.trim());
      continue;
    }
    if (indented) continue;
    collectingDescription = false;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) {
      return { valid: false, name: name || fallbackName, description, error: "Invalid YAML frontmatter" };
    }
    const [, key, rawValue] = match;
    if (key === "name") name = unquoteYamlScalar(rawValue);
    if (key === "description") {
      const value = rawValue.trim();
      if (/^[>|][-+]?\s*$/.test(value)) collectingDescription = true;
      else description = unquoteYamlScalar(value);
    }
  }
  if (descriptionLines.length) description = descriptionLines.join(" ").trim();
  if (!name || !description) {
    return {
      valid: false,
      name: name || fallbackName,
      description,
      error: !name ? "Frontmatter is missing name" : "Frontmatter is missing description",
    };
  }
  return { valid: true, name, description };
}

function inspectSkillFile(filePath) {
  const fallbackName = path.basename(path.dirname(filePath));
  try {
    return inspectSkillDocument(readFileSync(filePath, "utf8"), fallbackName);
  } catch (error) {
    return {
      valid: false,
      name: fallbackName,
      description: "",
      error: cleanLine(error?.message || "Skill file could not be read", 180),
    };
  }
}

function estimateSkillPromptTokens(name, description, source) {
  const characters = String(name || "").length + String(description || "").length + String(source || "").length + 48;
  return Math.max(8, Math.min(96, Math.ceil(characters / 4)));
}

function pluginActivationState(configText = "") {
  const enabledPlugins = new Set();
  let currentPlugin;
  let currentApp;
  const disabledApps = new Set();
  for (const line of String(configText).split(/\r?\n/)) {
    const plugin = line.match(/^\s*\[plugins\."([^"]+)"\]\s*$/);
    const app = line.match(/^\s*\[apps\.([A-Za-z0-9_.-]+)\]\s*$/);
    if (plugin) {
      currentPlugin = plugin[1].toLowerCase();
      currentApp = undefined;
      continue;
    }
    if (app) {
      currentPlugin = undefined;
      currentApp = app[1].toLowerCase();
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentPlugin = undefined;
      currentApp = undefined;
      continue;
    }
    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/i);
    if (!enabled) continue;
    if (currentPlugin && enabled[1].toLowerCase() === "true") enabledPlugins.add(currentPlugin);
    if (currentApp && enabled[1].toLowerCase() === "false") disabledApps.add(currentApp);
  }
  return { enabledPlugins, disabledApps };
}

function pluginCacheIdentity(filePath, pluginRoot) {
  const relative = path.relative(pluginRoot, filePath).split(path.sep);
  if (relative.length < 2) return {};
  const marketplace = relative[0].toLowerCase();
  const plugin = relative[1].toLowerCase();
  return { marketplace, plugin, id: `${plugin}@${marketplace}` };
}

function isPluginPromptEligible(identity, activation, mode) {
  if (!identity?.plugin) return false;
  if (activation.enabledPlugins.has(identity.id)) return true;
  if (REMOTE_APP_PLUGIN_IDS.has(identity.plugin)) {
    if (mode === "light" && activation.disabledApps.has(identity.plugin)) return false;
    return !activation.disabledApps.has(identity.plugin);
  }
  return false;
}

function lightDefaultMarkerPath(home) {
  return path.join(home, ".codex", "codex-router", LIGHT_DEFAULT_MARKER);
}

function rememberLightDefaultInitialized(home) {
  const marker = lightDefaultMarkerPath(home);
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // The mode switch itself is authoritative; a marker write failure should
    // not make the Harness page unusable.
  }
}

function fixedScriptPath(home = os.homedir()) {
  const codexHome = path.resolve(home, ".codex");
  const candidate = path.join(codexHome, SCRIPT_NAME);
  if (!existsSync(candidate)) return undefined;
  try {
    const resolvedDirectory = realpathSync(codexHome);
    const resolved = realpathSync(candidate);
    if (path.dirname(resolved) !== resolvedDirectory || !statSync(resolved).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function fixedPowerShellPath(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.SYSTEMROOT || "C:\\Windows";
  const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : undefined;
}

function safeSkillName(value) {
  if (typeof value !== "string" || !SKILL_NAME.test(value)) {
    throw new Error("Skill name is invalid.");
  }
  return value;
}

function cleanLine(value, limit = 240) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);
}

export function parseCodexModeStatus(stdout = "") {
  const lines = String(stdout).split(/\r?\n/);
  const field = (label) => {
    const prefix = `${label}:`;
    const line = lines.find((entry) => entry.startsWith(prefix));
    return line ? cleanLine(line.slice(prefix.length)) : undefined;
  };
  const modeLabel = field("Codex context mode") || "Unknown";
  const mode = /^LIGHT/i.test(modeLabel) ? "light" : /^FULL/i.test(modeLabel) ? "full" : "unknown";
  const temporaryExceptions = Number.parseInt(field("Temporary skill exceptions") || "0", 10);
  const disabledEntries = Number.parseInt(field("LIGHT v2 skill disable entries in config") || "0", 10);
  const specializedCandidates = Number.parseInt(field("Current specialized skill candidates") || "0", 10);
  return {
    mode,
    modeLabel,
    model: field("Model"),
    modelProvider: field("Model provider"),
    temporaryExceptions: Number.isFinite(temporaryExceptions) ? temporaryExceptions : 0,
    disabledEntries: Number.isFinite(disabledEntries) ? disabledEntries : 0,
    specializedCandidates: Number.isFinite(specializedCandidates) ? specializedCandidates : 0,
  };
}

export function parseCodexSkills(stdout = "") {
  const skills = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s+([^\s]+)\s+([^\s]+)\s*$/);
    if (!match) continue;
    const state = cleanLine(match[1], 40);
    const name = cleanLine(match[2], 128);
    const source = cleanLine(match[3], 180);
    if (!SKILL_NAME.test(name)) continue;
    skills.push({
      name,
      source,
      state,
      enabled: !/^OFF$/i.test(state),
      temporary: /TEMP/i.test(state),
    });
  }
  return skills;
}

export function parseCodexSkillPreview(stdout = "") {
  const skills = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s+([^\s]+)\s+(.+?SKILL\.md)\s*$/i);
    if (!match) continue;
    const name = cleanLine(match[2], 128);
    if (!SKILL_NAME.test(name)) continue;
    skills.push({ name, path: match[3].trim(), previewState: cleanLine(match[1], 40) });
  }
  return skills;
}

function skillInventory({ home, mode, listedSkills, previewSkills }) {
  const agentsRoot = path.join(home, ".agents", "skills");
  const codexRoot = path.join(home, ".codex", "skills");
  const pluginRoot = path.join(home, ".codex", "plugins", "cache");
  const configPath = path.join(home, ".codex", "config.toml");
  let configText = "";
  try { configText = readFileSync(configPath, "utf8"); } catch { /* optional */ }
  const activation = pluginActivationState(configText);
  const listedByName = new Map(listedSkills.map((skill) => [skill.name.toLowerCase(), skill]));
  const specializedByPath = new Map(
    previewSkills.map((skill) => [normalizeSkillPath(skill.path), skill]),
  );
  const candidates = [
    ...boundedSkillFiles(agentsRoot).map((filePath) => ({ filePath, rootKind: "agents" })),
    ...boundedSkillFiles(codexRoot).map((filePath) => ({ filePath, rootKind: "codex" })),
    ...boundedSkillFiles(pluginRoot).map((filePath) => ({ filePath, rootKind: "plugin-cache" })),
  ];
  const seen = new Set();
  const entries = [];
  for (const candidate of candidates) {
    const normalized = normalizeSkillPath(candidate.filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const inspected = inspectSkillFile(candidate.filePath);
    const preview = specializedByPath.get(normalized);
    const listed = preview ? listedByName.get(preview.name.toLowerCase()) : undefined;
    let category;
    if (!inspected.valid) category = "invalid";
    else if (preview) category = "specialized";
    else if (candidate.rootKind === "plugin-cache") category = "plugin-cache";
    else category = "core";

    const source = sourceLabel(candidate.filePath, home);
    const estimatedEnabledPromptTokens = inspected.valid
      ? estimateSkillPromptTokens(inspected.name, inspected.description, source)
      : 0;
    let promptEligible = inspected.valid;
    let enabled = inspected.valid;
    let state = "On";
    let temporary = false;
    let pluginId;
    if (category === "specialized") {
      enabled = mode === "full" || Boolean(listed?.enabled);
      temporary = Boolean(listed?.temporary);
      promptEligible = enabled;
      state = mode === "full" ? "FULL" : temporary ? "TEMP ON" : "OFF";
    } else if (category === "plugin-cache") {
      const identity = pluginCacheIdentity(candidate.filePath, pluginRoot);
      pluginId = identity.id;
      enabled = isPluginPromptEligible(identity, activation, mode);
      promptEligible = enabled;
      state = enabled ? "Active plugin" : "Cache only";
    } else if (category === "invalid") {
      enabled = false;
      promptEligible = false;
      state = "Invalid";
    }

    entries.push({
      name: inspected.name || preview?.name || path.basename(path.dirname(candidate.filePath)),
      source,
      path: candidate.filePath,
      description: inspected.description || "",
      category,
      state,
      enabled,
      temporary,
      promptEligible,
      estimatedPromptTokens: promptEligible ? estimatedEnabledPromptTokens : 0,
      estimatedEnabledPromptTokens,
      ...(pluginId ? { pluginId } : {}),
      ...(inspected.error ? { validationMessage: inspected.error } : {}),
    });
  }
  const categoryRank = new Map([["core", 0], ["specialized", 1], ["invalid", 2], ["plugin-cache", 3]]);
  entries.sort((left, right) =>
    (categoryRank.get(left.category) - categoryRank.get(right.category)) ||
    left.name.localeCompare(right.name) ||
    left.source.localeCompare(right.source)
  );
  return entries;
}

function runFixedPowerShell(action, skillName, {
  platform = process.platform,
  environment = process.env,
  home = os.homedir(),
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Codex Light/Full skill control is available on Windows only.");
  if (!ACTIONS.has(action)) throw new Error("Codex skill action is not allowed.");
  if ((action === "skill-on" || action === "skill-off") && !skillName) {
    throw new Error("A skill name is required.");
  }
  if (skillName !== undefined) safeSkillName(skillName);
  const script = fixedScriptPath(home);
  if (!script) throw new Error(`Codex mode script is unavailable at ~/.codex/${SCRIPT_NAME}.`);
  const powershell = fixedPowerShellPath(environment);
  if (!powershell) throw new Error("Windows PowerShell is unavailable.");
  const args = [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    action,
    ...(skillName ? [skillName] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershell, args, {
      cwd: path.dirname(script),
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish(reject, new Error("Codex skill command timed out."));
    }, Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 60_000)));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        try { child.kill(); } catch { /* already exited */ }
        finish(reject, new Error("Codex skill command output exceeded its limit."));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
    });
    child.on("error", (error) => finish(reject, new Error(cleanLine(error.message, 500) || "Codex skill command failed.")));
    child.on("close", (code) => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(cleanLine(stderr, 500) || `Codex skill command failed (${code}).`));
    });
  });
}

export async function getCodexSkillControlSnapshot(options = {}) {
  if ((options.platform || process.platform) !== "win32") {
    return { supported: false, why: "Codex Light/Full skill control is available on Windows only.", skills: [] };
  }
  const home = options.home || os.homedir();
  if (!fixedScriptPath(home)) {
    return { supported: false, why: `~/.codex/${SCRIPT_NAME} was not found.`, skills: [] };
  }
  try {
    let statusResult = await runFixedPowerShell("status", undefined, { ...options, home });
    let status = parseCodexModeStatus(statusResult.stdout);
    let defaultedToLight = false;
    if (!existsSync(lightDefaultMarkerPath(home)) && status.mode !== "unknown") {
      if (status.mode === "full") {
        await runFixedPowerShell("light", undefined, { ...options, home });
        statusResult = await runFixedPowerShell("status", undefined, { ...options, home });
        status = parseCodexModeStatus(statusResult.stdout);
        defaultedToLight = status.mode === "light";
      }
      rememberLightDefaultInitialized(home);
    }
    const [skillsResult, previewResult] = await Promise.all([
      runFixedPowerShell("skills", undefined, { ...options, home }),
      runFixedPowerShell("preview", undefined, { ...options, home }),
    ]);
    const listedSkills = parseCodexSkills(skillsResult.stdout);
    const previewSkills = parseCodexSkillPreview(previewResult.stdout);
    const skills = skillInventory({ home, mode: status.mode, listedSkills, previewSkills });
    const count = (category) => skills.filter((skill) => skill.category === category).length;
    const estimatedPromptTokens = skills.reduce((sum, skill) => sum + skill.estimatedPromptTokens, 0);
    return {
      supported: true,
      scriptPath: `~/.codex/${SCRIPT_NAME}`,
      defaultMode: "light",
      defaultedToLight,
      ...status,
      coreSkills: count("core"),
      specializedSkills: count("specialized"),
      invalidSkills: count("invalid"),
      pluginCacheSkills: count("plugin-cache"),
      estimatedPromptTokens,
      skills,
    };
  } catch (error) {
    return {
      supported: false,
      why: error instanceof Error ? cleanLine(error.message, 500) : "Codex skill state is unavailable.",
      skills: [],
    };
  }
}

export async function setCodexContextMode(mode, options = {}) {
  if (mode !== "light" && mode !== "full") throw new Error("Codex context mode must be light or full.");
  const home = options.home || os.homedir();
  await runFixedPowerShell(mode, undefined, { ...options, home });
  // Once the operator has an explicit mode, the one-time Light default must
  // never override later Full/Light choices.
  rememberLightDefaultInitialized(home);
  return getCodexSkillControlSnapshot({ ...options, home });
}

export async function setCodexSkillException(skillName, enabled, options = {}) {
  const name = safeSkillName(skillName);
  if (typeof enabled !== "boolean") throw new Error("Skill enabled state must be boolean.");
  const before = await getCodexSkillControlSnapshot(options);
  if (!before.supported) throw new Error(before.why || "Codex skill state is unavailable.");
  if (!before.skills.some((skill) => skill.category === "specialized" && skill.name === name)) {
    throw new Error(`Skill is not in the current valid specialized candidate list: ${name}.`);
  }
  await runFixedPowerShell(enabled ? "skill-on" : "skill-off", name, options);
  return getCodexSkillControlSnapshot(options);
}
