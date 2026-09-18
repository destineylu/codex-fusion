import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  callerBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { EXACT_ROUTE_PROBE_HEADER } from "./exact-route-probe.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "./model-registry.mjs";
import { selectedListedModels } from "./provider-selection.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

function nativeSessionModel(model) {
  const route = MODEL_BY_SLUG.get(model);
  return Boolean(route && PROVIDERS.get(route.provider)?.nativeSessionAuth);
}

function normalizedProbeText(model, value) {
  const text = String(value || "");
  return nativeSessionModel(model) ? text.replace(/\\([_*~`])/g, "$1") : text;
}

function nativeProbeBody(model, body) {
  if (!nativeSessionModel(model)) return body;
  const threadId = randomUUID();
  const turnId = randomUUID();
  const cwd = process.cwd();
  const passthrough = { turn_id: turnId };
  const metadata = {
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "workspace-write",
    workspaces: { [cwd]: {} },
  };
  const environment = [
    "<environment_context>",
    `  <cwd>${cwd}</cwd>`,
    "  <workspace_roots>",
    `    <root>${cwd}</root>`,
    "  </workspace_roots>",
    "  <sandbox_mode>workspace-write</sandbox_mode>",
    "</environment_context>",
  ].join("\n");
  return {
    ...body,
    input: [
      {
        type: "message",
        id: `msg_env_${randomUUID().replaceAll("-", "")}`,
        role: "user",
        content: [{ type: "input_text", text: environment }],
        internal_chat_message_metadata_passthrough: passthrough,
      },
      {
        type: "message",
        id: `msg_user_${randomUUID().replaceAll("-", "")}`,
        role: "user",
        content: [{ type: "input_text", text: body.input }],
        internal_chat_message_metadata_passthrough: passthrough,
      },
    ],
    prompt_cache_key: body.prompt_cache_key || threadId,
    client_metadata: {
      ...(body.client_metadata || {}),
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
  };
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const values = [];
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") values.push(part.text);
    }
  }
  return values.join("\n");
}

export function installedRouterBaseUrl(override) {
  const supplied = override || process.env.CODEX_ROUTER_BASE_URL;
  if (supplied) return String(supplied).replace(/\/+$/, "");
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  }
  const callerKey = assertCallerSecret(
    readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
  );
  return callerBaseUrl(PORTS.router, callerKey);
}

export async function smokeTestModel(model, options = {}) {
  const baseUrl = installedRouterBaseUrl(options.baseUrl);
  const marker = options.marker || "CODEX_ROUTER_SMOKE_OK";
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-smoke-test",
      "Content-Type": "application/json",
      [EXACT_ROUTE_PROBE_HEADER]: "1",
    },
    body: JSON.stringify(nativeProbeBody(model, {
      model,
      input: `Reply with exactly ${marker} and nothing else.`,
      stream: false,
    })),
    signal: AbortSignal.timeout(Number(options.timeoutMs || 180_000)),
  });
  const payload = await response.json().catch(() => ({}));
  const text = responseText(payload);
  const markerReceived = normalizedProbeText(model, text).includes(marker);
  return {
    ok: response.ok && markerReceived,
    model,
    status: response.status,
    markerReceived,
    error: response.ok ? undefined : payload?.error?.message || `HTTP ${response.status}`,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: smoke-test [MODEL...] --yes [--json]

Makes one quota-consuming live request per requested or enabled provider. Pass
--yes to confirm provider usage.
`);
    return;
  }
  if (!process.argv.includes("--yes")) {
    throw new Error("Live smoke tests may use provider quota; pass --yes to confirm.");
  }
  const requested = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const models = requested.length
    ? requested
    : [...new Map(selectedListedModels().map((model) => [model.provider, model.slug])).values()];
  if (models.length === 0) throw new Error("No enabled provider models are available to test.");
  const results = [];
  for (const model of models) results.push(await smokeTestModel(model));
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    for (const result of results) {
      process.stdout.write(
        `${result.ok ? "PASS" : "FAIL"} ${result.model}: ${
          result.ok ? "live response verified" : result.error || "marker missing"
        }\n`,
      );
    }
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      redactCallerUrl(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}
