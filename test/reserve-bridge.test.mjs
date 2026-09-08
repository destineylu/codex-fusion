import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { privateFileIsProtected } from "../src/file-security.mjs";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "reserve-bridge-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  clearReserveBridge,
  readReserveBridge,
  reserveBridgeSnapshot,
  setReserveBridge,
} = await import("../src/reserve-bridge.mjs");
const { RESERVE_BRIDGE_PATH } = await import("../src/paths.mjs");

test("reserve bridge defaults to disabled", () => {
  assert.equal(readReserveBridge(), undefined);
  assert.deepEqual(reserveBridgeSnapshot(), {
    enabled: false,
    model: null,
    nativeSlug: "gpt-reserve",
    path: RESERVE_BRIDGE_PATH,
  });
});

test("reserve bridge round-trips one routed target through protected state", () => {
  assert.deepEqual(setReserveBridge("commandcode/deepseek-v4-flash"), {
    enabled: true,
    model: "commandcode/deepseek-v4-flash",
    nativeSlug: "gpt-reserve",
    path: RESERVE_BRIDGE_PATH,
  });
  assert.deepEqual(readReserveBridge(), {
    enabled: true,
    model: "commandcode/deepseek-v4-flash",
  });
  assert.equal(privateFileIsProtected(RESERVE_BRIDGE_PATH), true);
  if (process.platform !== "win32") {
    assert.equal(statSync(RESERVE_BRIDGE_PATH).mode & 0o777, 0o600);
  }
  clearReserveBridge();
  assert.equal(readReserveBridge(), undefined);
});

test("reserve bridge rejects empty targets and ignores malformed state", () => {
  assert.throws(() => setReserveBridge(""), /routed model slug is required/i);
  writeFileSync(RESERVE_BRIDGE_PATH, "{ not json", "utf8");
  assert.equal(readReserveBridge(), undefined);
  writeFileSync(
    RESERVE_BRIDGE_PATH,
    JSON.stringify({ version: 1, enabled: false, model: "commandcode/deepseek-v4-flash" }),
    "utf8",
  );
  assert.equal(readReserveBridge(), undefined);
  clearReserveBridge();
});
