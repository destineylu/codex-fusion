import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { RESERVE_BRIDGE_PATH } from "./paths.mjs";

export const RESERVE_BRIDGE_NATIVE_SLUG = "gpt-reserve";

export function readReserveBridge() {
  if (!existsSync(RESERVE_BRIDGE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(RESERVE_BRIDGE_PATH, "utf8"));
    if (parsed?.version !== 1 || parsed.enabled !== true) return undefined;
    const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
    return model ? { enabled: true, model } : undefined;
  } catch {
    return undefined;
  }
}

export function reserveBridgeSnapshot() {
  const state = readReserveBridge();
  return {
    enabled: Boolean(state),
    model: state?.model ?? null,
    nativeSlug: RESERVE_BRIDGE_NATIVE_SLUG,
    path: RESERVE_BRIDGE_PATH,
  };
}

export function setReserveBridge(model) {
  const value = String(model || "").trim();
  if (!value) throw new Error("A routed model slug is required.");
  writePrivateJson(
    RESERVE_BRIDGE_PATH,
    { version: 1, enabled: true, model: value },
    { directoryMode: 0o700 },
  );
  return reserveBridgeSnapshot();
}

export function clearReserveBridge() {
  if (existsSync(RESERVE_BRIDGE_PATH)) unlinkSync(RESERVE_BRIDGE_PATH);
  return reserveBridgeSnapshot();
}
