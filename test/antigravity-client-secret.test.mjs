import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-antigravity-secret-"));
process.env.MODEL_ROUTER_STATE_DIR = root;
delete process.env.ANTIGRAVITY_CLIENT_SECRET;

const secretModule = await import(`../src/antigravity-client-secret.mjs?test=${Date.now()}`);
const constantsModule = await import(`../src/antigravity-oauth-constants.mjs?test=${Date.now()}`);

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("Antigravity client secret persists in router-owned state and is reusable without an environment variable", () => {
  assert.equal(secretModule.antigravityClientSecretStatus().configured, false);
  const saved = secretModule.saveAntigravityClientSecret("test-client-secret");
  assert.equal(saved.configured, true);
  assert.equal(saved.persisted, true);
  assert.equal(saved.source, "router-managed client secret");
  assert.equal(existsSync(saved.path), true);
  assert.equal(readFileSync(saved.path, "utf8").trim(), "test-client-secret");
  assert.equal(secretModule.readAntigravityClientSecret(), "test-client-secret");
  assert.equal(constantsModule.requireAntigravityClientSecret(), "test-client-secret");
});

test("environment secret remains a backward-compatible override", () => {
  process.env.ANTIGRAVITY_CLIENT_SECRET = "environment-secret";
  try {
    const status = secretModule.antigravityClientSecretStatus();
    assert.equal(status.configured, true);
    assert.equal(status.source, "environment");
    assert.equal(secretModule.readAntigravityClientSecret(), "environment-secret");
  } finally {
    delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  }
});

test("removing the router-managed secret makes refresh fail closed again", () => {
  assert.equal(secretModule.removeAntigravityClientSecret(), true);
  assert.equal(secretModule.antigravityClientSecretStatus().configured, false);
  assert.throws(() => constantsModule.requireAntigravityClientSecret(), /ANTIGRAVITY_CLIENT_SECRET/);
});
