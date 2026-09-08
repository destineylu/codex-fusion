import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { ANTIGRAVITY_CLIENT_SECRET_PATH, STATE_DIR } from "./paths.mjs";

const MAX_SECRET_BYTES = 16 * 1024;

function cleanSecret(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  if (Buffer.byteLength(normalized, "utf8") > MAX_SECRET_BYTES) {
    throw new Error("Antigravity OAuth client secret is too large.");
  }
  if (normalized.includes("\0")) throw new Error("Antigravity OAuth client secret is invalid.");
  return normalized;
}

function persistedSecret() {
  if (!existsSync(ANTIGRAVITY_CLIENT_SECRET_PATH)) return "";
  try {
    return cleanSecret(readFileSync(ANTIGRAVITY_CLIENT_SECRET_PATH, "utf8"));
  } catch {
    return "";
  }
}

export function antigravityClientSecretStatus(environment = process.env) {
  const environmentSecret = cleanSecret(environment.ANTIGRAVITY_CLIENT_SECRET || "");
  if (environmentSecret) {
    return {
      configured: true,
      source: "environment",
      path: ANTIGRAVITY_CLIENT_SECRET_PATH,
      persisted: existsSync(ANTIGRAVITY_CLIENT_SECRET_PATH),
    };
  }
  const stored = persistedSecret();
  return {
    configured: Boolean(stored),
    source: stored ? "router-managed client secret" : undefined,
    path: ANTIGRAVITY_CLIENT_SECRET_PATH,
    persisted: Boolean(stored),
  };
}

export function readAntigravityClientSecret(environment = process.env) {
  const environmentSecret = cleanSecret(environment.ANTIGRAVITY_CLIENT_SECRET || "");
  return environmentSecret || persistedSecret();
}

export function saveAntigravityClientSecret(value) {
  const secret = cleanSecret(value);
  if (!secret) throw new Error("Antigravity OAuth client secret is required.");
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${ANTIGRAVITY_CLIENT_SECRET_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, ANTIGRAVITY_CLIENT_SECRET_PATH);
    protectPrivateFile(ANTIGRAVITY_CLIENT_SECRET_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return antigravityClientSecretStatus({});
}

export function removeAntigravityClientSecret() {
  if (!existsSync(ANTIGRAVITY_CLIENT_SECRET_PATH)) return false;
  unlinkSync(ANTIGRAVITY_CLIENT_SECRET_PATH);
  return true;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_SECRET_BYTES) throw new Error("Antigravity OAuth client secret is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(antigravityClientSecretStatus())}\n`);
    return;
  }
  if (command === "set") {
    saveAntigravityClientSecret(await readStdin());
    process.stdout.write(`${JSON.stringify({ configured: true, persisted: true })}\n`);
    return;
  }
  if (command === "remove") {
    process.stdout.write(`${JSON.stringify({ removed: removeAntigravityClientSecret() })}\n`);
    return;
  }
  throw new Error("Usage: antigravity-client-secret.mjs status|set|remove");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
