import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  authorizeNativeThreadHandoff,
  commitNativeThreadAccount,
  inspectNativeThreadHandoff,
  nativeAccountFingerprintFromHeaders,
  nativeThreadHandoffSnapshot,
} from "../src/native-thread-handoff.mjs";

const THREAD = "123e4567-e89b-42d3-a456-426614174000";

test("native thread handoff moves ownership only after an accepted target turn", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-thread-handoff-"));
  const storePath = path.join(root, "handoff.json");
  const headersA = {
    "thread-id": THREAD,
    "chatgpt-account-id": "account-a",
  };
  const headersB = {
    "thread-id": THREAD,
    "chatgpt-account-id": "account-b",
  };
  try {
    const fingerprintA = nativeAccountFingerprintFromHeaders(headersA);
    const fingerprintB = nativeAccountFingerprintFromHeaders(headersB);
    assert.ok(fingerprintA);
    assert.ok(fingerprintB);
    assert.notEqual(fingerprintA, fingerprintB);

    const first = inspectNativeThreadHandoff(headersA, { storePath });
    assert.equal(first.eligible, true);
    assert.equal(first.firstObservation, true);
    assert.equal(first.handoff, false);
    commitNativeThreadAccount(first, {
      source: "test-a",
      now: new Date("2026-09-22T00:00:00Z"),
    });

    authorizeNativeThreadHandoff(THREAD, fingerprintA, fingerprintB, {
      storePath,
      now: new Date("2026-09-22T00:01:00Z"),
    });
    const pending = nativeThreadHandoffSnapshot({ storePath });
    assert.equal(pending.threads[THREAD].accountFingerprint, fingerprintA);
    assert.equal(pending.pending[THREAD].toAccountFingerprint, fingerprintB);

    // Merely inspecting B does not mutate ownership. The Router calls commit
    // only after the B upstream accepted the request.
    const target = inspectNativeThreadHandoff(headersB, {
      storePath,
      now: Date.parse("2026-09-22T00:02:00Z"),
    });
    assert.equal(target.handoff, true);
    assert.equal(target.explicitlyAuthorized, true);
    assert.equal(target.previousAccountFingerprint, fingerprintA);
    assert.equal(nativeThreadHandoffSnapshot({ storePath }).threads[THREAD].accountFingerprint, fingerprintA);

    commitNativeThreadAccount(target, {
      source: "test-b",
      now: new Date("2026-09-22T00:02:30Z"),
    });
    const completed = nativeThreadHandoffSnapshot({ storePath });
    assert.equal(completed.threads[THREAD].accountFingerprint, fingerprintB);
    assert.equal(completed.threads[THREAD].previousAccountFingerprint, fingerprintA);
    assert.equal(completed.threads[THREAD].handoffCount, 1);
    assert.equal(completed.pending[THREAD], undefined);

    const nextB = inspectNativeThreadHandoff(headersB, { storePath });
    assert.equal(nextB.handoff, false);

    // Sending the same root thread from A later is itself an explicit user
    // action in that thread, so the Router can recover even if Control Center
    // was not the component that performed the account switch.
    const backToA = inspectNativeThreadHandoff(headersA, { storePath });
    assert.equal(backToA.handoff, true);
    assert.equal(backToA.explicitlyAuthorized, false);

    const child = inspectNativeThreadHandoff({
      ...headersA,
      "x-codex-parent-thread-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }, { storePath });
    assert.equal(child.eligible, false);
    assert.equal(child.reason, "subagent-thread");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
