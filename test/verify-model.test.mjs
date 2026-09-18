import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDERS } from "../src/model-registry.mjs";
import {
  applyVerifiedModel,
  streamingProbe,
  toolProbe,
  verifyModel,
} from "../src/verify-model.mjs";

const CHAT = PROVIDERS.get("commandcode");
const XKIRO = PROVIDERS.get("xkiro");
const CREDENTIAL = { value: "TEST_KEY" };
const MODEL = "vendor/new-model";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatToolCall() {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "codex_router_probe",
                arguments: JSON.stringify({ value: "ok" }),
              },
            },
          ],
        },
      },
    ],
  };
}

test("tool probe records auto-tool-choice only after required fails and auto calls the tool", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tool_choice === "required") {
      return jsonResponse({ error: { message: "only auto is supported for tool_choice" } }, 400);
    }
    return jsonResponse(chatToolCall());
  };

  const result = await toolProbe(CHAT, CREDENTIAL, MODEL, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.required.ok, false);
  assert.equal(result.required.status, 400);
  assert.equal(result.auto.ok, true);
  assert.equal(result.requestProfile, "auto-tool-choice");
  assert.deepEqual(result.autoAttempts, [result.auto]);
  assert.deepEqual(bodies.map((body) => body.tool_choice), ["required", "auto"]);
});

test("tool probe retries auto once after an explicit auto-only refusal", async () => {
  const bodies = [];
  let autoCalls = 0;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tool_choice === "required") {
      return jsonResponse({
        error: {
          message: "only `\"auto\"` is supported for `tool_choice`.",
          type: "AI_APICallError",
          param: { statusCode: 400 },
        },
      }, 400);
    }
    autoCalls += 1;
    if (autoCalls === 1) {
      return jsonResponse({ error: { message: "Upstream model provider is temporarily unavailable." } }, 503);
    }
    return jsonResponse(chatToolCall());
  };

  const result = await toolProbe(CHAT, CREDENTIAL, MODEL, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.requestProfile, "auto-tool-choice");
  assert.equal(result.autoAttempts.length, 2);
  assert.equal(result.autoAttempts[0].status, 503);
  assert.equal(result.autoAttempts[1].ok, true);
  assert.deepEqual(bodies.map((body) => body.tool_choice), ["required", "auto", "auto"]);
});

test("chat streaming accepts fragmented text with finish_reason even when [DONE] is absent", async () => {
  const fetchImpl = async () => new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "CODEX_" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ROUTER_STREAM_" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  const result = await streamingProbe(XKIRO, CREDENTIAL, MODEL, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.detail, "stream text and completion verified");
});

test("chat streaming still fails when text arrives but no completion evidence exists", async () => {
  const fetchImpl = async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "CODEX_ROUTER_STREAM_OK" }, finish_reason: null }] })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  const result = await streamingProbe(XKIRO, CREDENTIAL, MODEL, { fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.detail, "stream completion missing");
});

test("route override probes only the requested Command Code protocol variant", async () => {
  const discover = async () => ({
    provider: "commandcode",
    discovered: [MODEL],
    registered: [],
    unregistered: [MODEL],
    addable: [],
    blocked: { [MODEL]: "protocol unknown" },
    unavailable: [],
    contextLengths: { [MODEL]: 1048576 },
    fetchedAt: "2026-09-03T00:00:00.000Z",
    cached: false,
  });
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    assert.equal(String(url).endsWith("/messages"), false);
    const body = JSON.parse(init.body);
    if (body.stream === true) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "CODEX_ROUTER_STREAM_OK" }, finish_reason: "stop" }] })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (Array.isArray(body.tools)) {
      if (body.tool_choice === "required") {
        return jsonResponse({ error: { message: "only auto is supported for tool_choice" } }, 400);
      }
      return jsonResponse(chatToolCall());
    }
    return jsonResponse({ choices: [{ message: { content: "CODEX_ROUTER_VERIFY_OK" } }] });
  };

  const result = await verifyModel("commandcode", MODEL, {
    discover,
    fetchImpl,
    routeOverride: "commandcode",
    refresh: false,
    credentialFor: async () => CREDENTIAL,
    prepareTransport: async () => {},
  });

  assert.equal(result.safeToCurate, true);
  assert.deepEqual(result.protocolChecks.map((item) => item.route), ["commandcode"]);
  assert.equal(urls.some((url) => url.endsWith("/messages")), false);
});

test("blocked-model verification chooses Command Code Chat and carries verified metadata", async () => {
  const discover = async () => ({
    provider: "commandcode",
    discovered: [MODEL],
    registered: [],
    unregistered: [MODEL],
    addable: [],
    blocked: { [MODEL]: "protocol unknown" },
    unavailable: [],
    contextLengths: { [MODEL]: 1048576 },
    fetchedAt: "2026-09-03T00:00:00.000Z",
    cached: false,
  });

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/messages")) {
      return jsonResponse(
        { error: { message: "Use /provider/v1/chat/completions for OpenAI and OSS models." } },
        400,
      );
    }
    if (body.stream === true) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "CODEX_ROUTER_STREAM_OK" } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (Array.isArray(body.tools)) {
      if (body.tool_choice === "required") {
        return jsonResponse({ error: { message: "only auto is supported" } }, 400);
      }
      return jsonResponse(chatToolCall());
    }
    return jsonResponse({
      choices: [{ message: { content: "CODEX_ROUTER_VERIFY_OK" }, finish_reason: "stop" }],
    });
  };

  const result = await verifyModel("commandcode", MODEL, {
    discover,
    fetchImpl,
    refresh: false,
    credentialFor: async () => CREDENTIAL,
    prepareTransport: async () => {},
  });

  assert.equal(result.safeToCurate, true);
  assert.equal(result.selectedRoute, "commandcode");
  assert.equal(result.protocol, "chat");
  assert.equal(result.requestProfile, "auto-tool-choice");
  assert.equal(result.contextWindow, 1048576);
  assert.deepEqual(result.reasoningEfforts, ["high"]);
  assert.equal(result.protocolChecks.find((item) => item.route === "commandcode")?.basic.ok, true);
  assert.equal(result.protocolChecks.find((item) => item.route === "commandcode-messages")?.basic.ok, false);
});

test("single-route verification proves an Xkiro addable candidate before curation", async () => {
  const xkiroModel = "moonshotai/kimi-k3";
  const discover = async () => ({
    provider: "xkiro",
    discovered: [xkiroModel],
    registered: [],
    unregistered: [xkiroModel],
    addable: [xkiroModel],
    blocked: {},
    unavailable: [],
    contextLengths: { [xkiroModel]: 262144 },
    fetchedAt: "2026-09-04T00:00:00.000Z",
    cached: false,
  });

  const bodies = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.stream === true) {
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "CODEX_ROUTER_STREAM_OK" } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (Array.isArray(body.tools)) return jsonResponse(chatToolCall());
    return jsonResponse({
      choices: [{ message: { content: "CODEX_ROUTER_VERIFY_OK" }, finish_reason: "stop" }],
    });
  };

  const result = await verifyModel("xkiro", xkiroModel, {
    discover,
    fetchImpl,
    refresh: false,
    credentialFor: async (provider) => {
      assert.equal(provider, XKIRO);
      return CREDENTIAL;
    },
    prepareTransport: async () => {},
  });

  assert.equal(result.safeToCurate, true);
  assert.equal(result.selectedRoute, "xkiro");
  assert.equal(result.protocol, "chat");
  assert.equal(result.requestProfile, undefined);
  assert.equal(result.contextWindow, 262144);
  assert.deepEqual(result.reasoningEfforts, ["high"]);
  assert.deepEqual(result.protocolChecks.map((item) => item.route), ["xkiro"]);
  assert.equal(result.routeChecks.length, 1);
  assert.equal(result.routeChecks[0].tools.required.ok, true);
  assert.equal(bodies.some((body) => body.reasoning_effort === "high"), true);
});

test("verified apply publishes the local model and leaves it visible after final routed proof", async () => {
  const writes = [];
  const visible = [];
  const publications = [];
  const report = {
    provider: "commandcode",
    model: MODEL,
    safeToCurate: true,
    selectedRoute: "commandcode",
    requestProfile: "auto-tool-choice",
    contextWindow: 1048576,
    reasoningEfforts: ["high"],
  };

  const result = await applyVerifiedModel(report, {
    lock: async (operation) => operation(),
    readModels: () => [],
    writeModels: (models) => writes.push(structuredClone(models)),
    setVisible: (slugs, value) => visible.push({ slugs: [...slugs], value }),
    capture: () => [{ path: "snapshot", existed: false, contents: null }],
    restore: () => assert.fail("successful verification must not restore state"),
    publish: async (options) => publications.push(options),
    compatibility: async (slug) => ({ ok: true, slug, detail: "full routed compatibility verified" }),
  });

  assert.equal(result.entry.slug, "commandcode/vendor/new-model");
  assert.equal(result.entry.provider, "commandcode");
  assert.equal(result.entry.requestProfile, "auto-tool-choice");
  assert.equal(result.entry.contextWindow, 1048576);
  assert.equal(result.entry.autoCompact, 891289);
  assert.equal(result.entry.defaultEffort, "high");
  assert.equal(writes.length, 1);
  assert.deepEqual(visible, [{ slugs: ["commandcode/vendor/new-model"], value: true }]);
  assert.deepEqual(publications, [{ restart: true }]);
});

test("verified apply restores the exact locked snapshot when final routed proof fails", async () => {
  const events = [];
  const snapshot = [{ path: "snapshot", existed: true, contents: "OLD" }];
  const report = {
    provider: "commandcode",
    model: MODEL,
    safeToCurate: true,
    selectedRoute: "commandcode",
    contextWindow: 400000,
    reasoningEfforts: [],
  };

  await assert.rejects(
    applyVerifiedModel(report, {
      lock: async (operation) => {
        events.push("lock:start");
        try {
          return await operation();
        } finally {
          events.push("lock:end");
        }
      },
      readModels: () => [],
      writeModels: () => events.push("write"),
      setVisible: () => events.push("visible"),
      capture: () => {
        events.push("capture");
        return snapshot;
      },
      restore: (held) => {
        assert.equal(held, snapshot);
        events.push("restore");
      },
      publish: async () => events.push("publish"),
      compatibility: async () => ({ ok: false, detail: "tool calling failed" }),
    }),
    /rolled back|will be rolled back/,
  );

  assert.deepEqual(events, [
    "lock:start",
    "capture",
    "write",
    "visible",
    "publish",
    "restore",
    "publish",
    "lock:end",
  ]);
});
