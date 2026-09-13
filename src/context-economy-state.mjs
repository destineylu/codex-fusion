import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const CONTEXT_ECONOMY_STATE_PATH =
  process.env.MODEL_ROUTER_CONTEXT_ECONOMY_STATE ||
  path.join(STATE_DIR, "context-economy.json");

function defaultSettings() {
  return { version: 1, enabled: false, defaulted: true };
}

export function readContextEconomySettings() {
  if (!existsSync(CONTEXT_ECONOMY_STATE_PATH)) return defaultSettings();
  try {
    const parsed = JSON.parse(readFileSync(CONTEXT_ECONOMY_STATE_PATH, "utf8"));
    if (parsed?.version === 1 && typeof parsed.enabled === "boolean") {
      return { version: 1, enabled: parsed.enabled };
    }
  } catch {
    // An explicit but unreadable choice must fail closed rather than silently
    // changing how much conversation history a paid third-party model receives.
  }
  return { version: 1, enabled: false, invalid: true };
}

export function setContextEconomyEnabled(enabled) {
  const settings = { version: 1, enabled: enabled === true };
  writePrivateJson(CONTEXT_ECONOMY_STATE_PATH, settings, { directoryMode: 0o700 });
  return settings;
}

export function contextEconomyEnabled() {
  const override = process.env.CODEX_ROUTER_CONTEXT_ECONOMY;
  if (override === "0") return false;
  if (override === "1") return true;
  return readContextEconomySettings().enabled === true;
}

export function contextEconomySnapshot() {
  const settings = readContextEconomySettings();
  const override = process.env.CODEX_ROUTER_CONTEXT_ECONOMY;
  return {
    ...settings,
    enabled: override === "1" ? true : override === "0" ? false : settings.enabled,
    configured: existsSync(CONTEXT_ECONOMY_STATE_PATH),
    environmentOverride: override === "0" || override === "1",
  };
}
