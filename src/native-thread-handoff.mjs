import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";
import {
  parentThreadIdFromHeaders,
  threadIdFromHeaders,
} from "./codex-session-names.mjs";

const VERSION = 1;
const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{12}$/i;
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export const NATIVE_THREAD_HANDOFF_PATH =
  process.env.CODEX_ROUTER_NATIVE_THREAD_HANDOFF
  || path.join(STATE_DIR, "native-thread-handoff.json");

function cleanFingerprint(value) {
  const fingerprint = String(value || "").toLowerCase();
  return FINGERPRINT.test(fingerprint) ? fingerprint : undefined;
}

function cleanThreadId(value) {
  const threadId = String(value || "").toLowerCase();
  return THREAD_UUID.test(threadId) ? threadId : undefined;
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

function readState(storePath = NATIVE_THREAD_HANDOFF_PATH) {
  const parsed = readJson(storePath);
  const threads = {};
  const pending = {};
  if (parsed?.version === VERSION && parsed.threads && typeof parsed.threads === "object") {
    for (const [rawId, row] of Object.entries(parsed.threads)) {
      const threadId = cleanThreadId(rawId);
      const accountFingerprint = cleanFingerprint(row?.accountFingerprint);
      if (!threadId || !accountFingerprint) continue;
      threads[threadId] = {
        accountFingerprint,
        firstSeenAt: typeof row.firstSeenAt === "string" ? row.firstSeenAt : undefined,
        lastSeenAt: typeof row.lastSeenAt === "string" ? row.lastSeenAt : undefined,
        handoffCount: Number.isFinite(Number(row.handoffCount)) ? Number(row.handoffCount) : 0,
        lastHandoffAt: typeof row.lastHandoffAt === "string" ? row.lastHandoffAt : undefined,
        previousAccountFingerprint: cleanFingerprint(row.previousAccountFingerprint),
        source: typeof row.source === "string" ? row.source.slice(0, 80) : undefined,
      };
    }
  }
  if (parsed?.version === VERSION && parsed.pending && typeof parsed.pending === "object") {
    for (const [rawId, row] of Object.entries(parsed.pending)) {
      const threadId = cleanThreadId(rawId);
      const fromAccountFingerprint = cleanFingerprint(row?.fromAccountFingerprint);
      const toAccountFingerprint = cleanFingerprint(row?.toAccountFingerprint);
      const authorizedAt = Date.parse(String(row?.authorizedAt || ""));
      const expiresAt = Date.parse(String(row?.expiresAt || ""));
      if (
        !threadId
        || !fromAccountFingerprint
        || !toAccountFingerprint
        || fromAccountFingerprint === toAccountFingerprint
        || !Number.isFinite(authorizedAt)
        || !Number.isFinite(expiresAt)
      ) continue;
      pending[threadId] = {
        fromAccountFingerprint,
        toAccountFingerprint,
        authorizedAt: new Date(authorizedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        source: typeof row.source === "string" ? row.source.slice(0, 80) : undefined,
      };
    }
  }
  return { version: VERSION, threads, pending };
}

function writeState(storePath, state) {
  writePrivateJson(storePath, {
    version: VERSION,
    threads: state.threads,
    pending: state.pending,
  });
}

export function nativeAccountFingerprintFromHeaders(headers = {}) {
  let accountId;
  for (const [name, raw] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== "chatgpt-account-id") continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim()) accountId = value.trim();
    break;
  }
  if (!accountId) return undefined;
  return createHash("sha256").update(`account:${accountId}`).digest("hex").slice(0, 12);
}

export function authorizeNativeThreadHandoff(
  threadId,
  fromAccountFingerprint,
  toAccountFingerprint,
  {
    storePath = NATIVE_THREAD_HANDOFF_PATH,
    now = new Date(),
    ttlMs = DEFAULT_PENDING_TTL_MS,
    source = "control-center-account-switch",
  } = {},
) {
  const id = cleanThreadId(threadId);
  const from = cleanFingerprint(fromAccountFingerprint);
  const to = cleanFingerprint(toAccountFingerprint);
  if (!id) throw new Error("Invalid native Codex thread id.");
  if (!from || !to) throw new Error("Native account fingerprint is unavailable.");
  if (from === to) throw new Error("Native thread handoff requires two different accounts.");
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error("Native thread handoff time is invalid.");
  const state = readState(storePath);
  state.pending[id] = {
    fromAccountFingerprint: from,
    toAccountFingerprint: to,
    authorizedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + Math.max(60_000, Number(ttlMs) || DEFAULT_PENDING_TTL_MS)).toISOString(),
    source,
  };
  writeState(storePath, state);
  return state.pending[id];
}

export function cancelNativeThreadHandoff(
  threadId,
  { storePath = NATIVE_THREAD_HANDOFF_PATH } = {},
) {
  const id = cleanThreadId(threadId);
  if (!id) return false;
  const state = readState(storePath);
  if (!state.pending[id]) return false;
  delete state.pending[id];
  writeState(storePath, state);
  return true;
}

export function inspectNativeThreadHandoff(
  headers = {},
  {
    storePath = NATIVE_THREAD_HANDOFF_PATH,
    now = Date.now(),
  } = {},
) {
  const threadId = cleanThreadId(threadIdFromHeaders(headers));
  const currentAccountFingerprint = nativeAccountFingerprintFromHeaders(headers);
  if (!threadId || !currentAccountFingerprint) {
    return {
      threadId,
      currentAccountFingerprint,
      eligible: false,
      handoff: false,
      reason: "missing-thread-or-account",
      storePath,
    };
  }
  if (parentThreadIdFromHeaders(headers)) {
    return {
      threadId,
      currentAccountFingerprint,
      eligible: false,
      handoff: false,
      reason: "subagent-thread",
      storePath,
    };
  }

  const state = readState(storePath);
  const owner = state.threads[threadId]?.accountFingerprint;
  const pending = state.pending[threadId];
  const pendingValid = Boolean(
    pending
    && Date.parse(pending.expiresAt) > Number(now)
    && pending.toAccountFingerprint === currentAccountFingerprint
  );
  const previousAccountFingerprint = pendingValid
    ? pending.fromAccountFingerprint
    : owner;

  return {
    threadId,
    currentAccountFingerprint,
    previousAccountFingerprint,
    eligible: true,
    firstObservation: !owner && !pendingValid,
    handoff: Boolean(
      pendingValid
      || (owner && owner !== currentAccountFingerprint)
    ),
    explicitlyAuthorized: pendingValid,
    source: pendingValid ? "pending" : owner ? "stored" : "new",
    storePath,
  };
}

export function commitNativeThreadAccount(
  observation,
  {
    source = "native-turn",
    now = new Date(),
  } = {},
) {
  if (
    !observation?.eligible
    || !cleanThreadId(observation.threadId)
    || !cleanFingerprint(observation.currentAccountFingerprint)
  ) return false;

  const storePath = observation.storePath || NATIVE_THREAD_HANDOFF_PATH;
  const state = readState(storePath);
  const threadId = observation.threadId.toLowerCase();
  const current = state.threads[threadId];
  const pending = state.pending[threadId];
  const target = observation.currentAccountFingerprint.toLowerCase();
  const handoff = Boolean(
    observation.handoff
    || (current?.accountFingerprint && current.accountFingerprint !== target)
  );
  const stamp = now.toISOString();

  state.threads[threadId] = {
    accountFingerprint: target,
    firstSeenAt: current?.firstSeenAt || stamp,
    lastSeenAt: stamp,
    handoffCount: (current?.handoffCount || 0) + (handoff ? 1 : 0),
    ...(handoff
      ? {
          lastHandoffAt: stamp,
          previousAccountFingerprint:
            current?.accountFingerprint
            || observation.previousAccountFingerprint,
        }
      : current?.previousAccountFingerprint
        ? {
            previousAccountFingerprint: current.previousAccountFingerprint,
            ...(current.lastHandoffAt ? { lastHandoffAt: current.lastHandoffAt } : {}),
          }
        : {}),
    source,
  };

  if (
    pending
    && pending.toAccountFingerprint === target
  ) {
    delete state.pending[threadId];
  }
  writeState(storePath, state);
  return true;
}

export function nativeThreadHandoffSnapshot(
  { storePath = NATIVE_THREAD_HANDOFF_PATH } = {},
) {
  return readState(storePath);
}

function cli() {
  const [action, threadId, fromFingerprint, toFingerprint] = process.argv.slice(2);
  if (action === "authorize") {
    const pending = authorizeNativeThreadHandoff(threadId, fromFingerprint, toFingerprint);
    process.stdout.write(JSON.stringify({ ok: true, threadId, pending }) + "\n");
    return;
  }
  if (action === "cancel") {
    process.stdout.write(JSON.stringify({ ok: cancelNativeThreadHandoff(threadId), threadId }) + "\n");
    return;
  }
  if (action === "snapshot") {
    process.stdout.write(JSON.stringify(nativeThreadHandoffSnapshot()) + "\n");
    return;
  }
  process.stderr.write("Usage: node native-thread-handoff.mjs authorize THREAD FROM_FINGERPRINT TO_FINGERPRINT | cancel THREAD | snapshot\n");
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli();
}
