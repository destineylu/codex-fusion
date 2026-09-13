import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "context-economy-test-"));
process.env.MODEL_ROUTER_CONTEXT_ECONOMY_STATE = path.join(stateDir, "context-economy.json");

const {
  CONTEXT_ECONOMY_AGING_FRONTIER,
  CONTEXT_ECONOMY_AGING_MIN_BYTES,
  CONTEXT_ECONOMY_SOFT_LIMIT,
  contextEconomyPolicy,
} = await import("../src/context-economy.mjs");
const {
  contextEconomySnapshot,
  setContextEconomyEnabled,
} = await import("../src/context-economy-state.mjs");
const { chatProviderToolSurface } = await import("../src/chat-tool-surface.mjs");
const { routedModel } = await import("../src/catalog.mjs");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("Context Economy keeps the real context window while lowering only the working compact budget", () => {
  const model = {
    slug: "commandcode/deepseek-v4-flash",
    contextWindow: 1_000_000,
    autoCompact: 900_000,
  };
  const policy = contextEconomyPolicy(model, { enabled: true });
  assert.equal(policy.autoCompact, 160_000);
  assert.equal(policy.softLimit, CONTEXT_ECONOMY_SOFT_LIMIT);
  assert.equal(policy.pressureRatio, 0.625);
  assert.equal(policy.agingMinBytes, CONTEXT_ECONOMY_AGING_MIN_BYTES);
  assert.equal(policy.agingFrontier, CONTEXT_ECONOMY_AGING_FRONTIER);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.autoCompact, 900_000);
});

test("Context Economy is exact-route scoped and never raises an already safer compact limit", () => {
  assert.equal(
    contextEconomyPolicy(
      { slug: "commandcode/deepseek-v4-flash", autoCompact: 120_000 },
      { enabled: true },
    ).autoCompact,
    120_000,
  );
  assert.equal(
    contextEconomyPolicy(
      { slug: "commandcode/gpt-5.6-luna", autoCompact: 900_000 },
      { enabled: true },
    ),
    undefined,
  );
});

test("Context Economy state is explicit, private-state shaped, and reversible", () => {
  assert.equal(contextEconomySnapshot().enabled, false);
  setContextEconomyEnabled(true);
  assert.equal(contextEconomySnapshot().enabled, true);
  assert.deepEqual(JSON.parse(readFileSync(process.env.MODEL_ROUTER_CONTEXT_ECONOMY_STATE, "utf8")), {
    version: 1,
    enabled: true,
  });
  setContextEconomyEnabled(false);
  assert.equal(contextEconomySnapshot().enabled, false);
});

test("catalog publication lowers only auto_compact_token_limit when Context Economy is on", () => {
  const model = {
    slug: "commandcode/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "fixture",
    priority: 1,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "High" }],
    contextWindow: 1_000_000,
    autoCompact: 900_000,
    inputModalities: ["text"],
    compHash: "fixture",
  };
  setContextEconomyEnabled(true);
  const economic = routedModel({}, model);
  assert.equal(economic.context_window, 1_000_000);
  assert.equal(economic.max_context_window, 1_000_000);
  assert.equal(economic.auto_compact_token_limit, 160_000);

  setContextEconomyEnabled(false);
  const normal = routedModel({}, model);
  assert.equal(normal.context_window, 1_000_000);
  assert.equal(normal.auto_compact_token_limit, 900_000);
});

test("lean chat tool surface omits unreferenced deferred app tools but restores referenced ones", () => {
  const tools = [{
    type: "function",
    name: "workspace_read",
    description: "Read one workspace file",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }];

  const full = chatProviderToolSurface(tools, "commandcode");
  const lean = chatProviderToolSurface(tools, "commandcode", {
    deferUnreferencedAppTools: true,
  });
  assert.ok(full.tools.length > lean.tools.length);
  assert.deepEqual(lean.tools.map((tool) => tool.name), ["workspace_read"]);

  const referenced = chatProviderToolSurface(tools, "commandcode", {
    deferUnreferencedAppTools: true,
    input: [{
      type: "function_call",
      name: "codex_app__create_thread",
      call_id: "call-1",
      arguments: "{}",
    }],
  });
  const names = referenced.tools.map((tool) => tool.name);
  assert.ok(names.includes("workspace_read"));
  assert.ok(names.includes("codex_app__create_thread"));
  assert.ok(!names.includes("codex_app__automation_update"));
});
