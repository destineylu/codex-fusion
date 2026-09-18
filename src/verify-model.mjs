import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetch as undiciFetch } from "undici";

import { installStableFetchTransport } from "./fetch-transport.mjs";
import { discoverProviderModels } from "./model-discovery.mjs";
import { MODEL_PICKER_STATE_PATH, setModelsVisible } from "./model-picker-state.mjs";
import { MODELS, PROVIDERS, resolveProviderBaseUrl } from "./model-registry.mjs";
import {
  aggregateRollbackError,
  applyModelOverlayPublication,
  captureModelOverlayFiles,
  restoreModelOverlayFiles,
} from "./model-overlay-publication.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { curationPrimaryProviderId, curationProviderIds } from "./opencode-curation.mjs";
import { inheritedProxyEnvironment } from "./proxy-environment.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { nativeSessionHeaders } from "./codex-native-session.mjs";
import {
  USER_MODELS_PATH,
  readUserModels,
  userModelEntry,
  writeUserModels,
} from "./user-models.mjs";

const SELF = fileURLToPath(import.meta.url);
const SOURCE_ROOT = path.resolve(path.dirname(SELF), "..");
const BASIC_MARKER = "CODEX_ROUTER_VERIFY_OK";
const STREAM_MARKER = "CODEX_ROUTER_STREAM_OK";
const TOOL_NAME = "codex_router_probe";
const REQUEST_TIMEOUT_MS = 120_000;
const AUTO_COMPACT_RATIO = 0.85;

function verifiedSizing(contextLength) {
  if (!Number.isInteger(contextLength) || contextLength < 1) return {};
  return {
    contextWindow: contextLength,
    autoCompact: Math.floor(contextLength * AUTO_COMPACT_RATIO),
  };
}

function verifiedEffortMetadata(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return {};
  const unique = [...new Set(efforts)];
  return {
    reasoningLevels: unique.map((effort) => ({
      effort,
      description: effort === "high" ? "Deep reasoning" : `${effort} reasoning`,
    })),
    defaultEffort: unique.includes("high") ? "high" : unique.at(-1),
  };
}

function option(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function trimDetail(value, limit = 420) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function errorDetail(payload, status) {
  return trimDetail(
    payload?.error?.message ||
      payload?.message ||
      payload?.error?.code ||
      payload?.error ||
      `HTTP ${status}`,
  );
}

function protocolFor(provider) {
  if (provider.protocol === "anthropic") return "messages";
  if (provider.protocol === "openai-responses") return "responses";
  return "chat";
}

function endpointFor(provider) {
  const base = resolveProviderBaseUrl(provider).baseUrl.replace(/\/$/, "");
  const protocol = protocolFor(provider);
  if (protocol === "messages") return `${base}/messages`;
  if (protocol === "responses") return `${base}/responses`;
  return `${base}/chat/completions`;
}

function headersFor(provider, credential) {
  if (provider.nativeSessionAuth) {
    const native = nativeSessionHeaders();
    if (!native?.authorization) {
      throw new Error(`${provider.displayName} verification requires the local Codex session sharing authorization.`);
    }
    return { "Content-Type": "application/json", ...native };
  }
  if (provider.authMode === "anonymous") return { "Content-Type": "application/json" };
  if (provider.protocol === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": credential.value,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${credential.value}`,
  };
}

function withNativeProbeTurn(provider, body) {
  if (!provider.nativeSessionAuth || protocolFor(provider) !== "responses") return body;
  if (typeof body?.input !== "string") return body;

  const threadId = randomUUID();
  const turnId = randomUUID();
  const cwd = process.cwd();
  const metadata = {
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "workspace-write",
    workspaces: { [cwd]: {} },
  };
  const passthrough = { turn_id: turnId };
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

async function postJson(provider, credential, body, { fetchImpl = undiciFetch } = {}) {
  const probeBody = withNativeProbeTurn(provider, body);
  const response = await fetchImpl(endpointFor(provider), {
    method: "POST",
    headers: headersFor(provider, credential),
    body: JSON.stringify(probeBody),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  return { response, payload, text };
}

function basicBody(provider, model, { reasoningEffort } = {}) {
  const protocol = protocolFor(provider);
  if (protocol === "messages") {
    return {
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: `Reply with exactly ${BASIC_MARKER} and nothing else.` }],
    };
  }
  if (protocol === "responses") {
    return {
      model,
      input: `Reply with exactly ${BASIC_MARKER} and nothing else.`,
      max_output_tokens: 1024,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    };
  }
  return {
    model,
    messages: [{ role: "user", content: `Reply with exactly ${BASIC_MARKER} and nothing else.` }],
    max_tokens: 1024,
    stream: false,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

function normalizedProbeText(provider, value) {
  const text = String(value || "");
  if (!provider.nativeSessionAuth) return text;
  return text.replace(/\\([_*`~])/g, "$1");
}

function markerPresent(provider, value, marker) {
  return normalizedProbeText(provider, value).includes(marker);
}

function basicText(provider, payload) {
  const protocol = protocolFor(provider);
  if (protocol === "messages") {
    return (payload?.content || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join("");
  }
  if (protocol === "responses") {
    if (typeof payload?.output_text === "string") return payload.output_text;
    return (payload?.output || [])
      .flatMap((item) => item?.content || [])
      .map((part) => part?.text || part?.output_text || "")
      .join("");
  }
  return payload?.choices?.[0]?.message?.content || "";
}

export async function basicProbe(provider, credential, model, options = {}) {
  try {
    const { response, payload } = await postJson(provider, credential, basicBody(provider, model), options);
    const text = basicText(provider, payload);
    return {
      ok: response.ok && markerPresent(provider, text, BASIC_MARKER),
      status: response.status,
      detail: response.ok ? (markerPresent(provider, text, BASIC_MARKER) ? "marker verified" : "marker missing") : errorDetail(payload, response.status),
    };
  } catch (error) {
    return { ok: false, status: 0, detail: trimDetail(error?.message || error) };
  }
}

function streamBody(provider, model) {
  const protocol = protocolFor(provider);
  if (protocol === "messages") {
    return {
      model,
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: `Reply with exactly ${STREAM_MARKER} and nothing else.` }],
    };
  }
  if (protocol === "responses") {
    return {
      model,
      stream: true,
      max_output_tokens: 1024,
      input: `Reply with exactly ${STREAM_MARKER} and nothing else.`,
    };
  }
  return {
    model,
    stream: true,
    max_tokens: 1024,
    messages: [{ role: "user", content: `Reply with exactly ${STREAM_MARKER} and nothing else.` }],
  };
}

function streamEvidence(provider, body) {
  const protocol = protocolFor(provider);
  let streamedText = "";
  let completed = false;

  for (const line of String(body || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      completed = true;
      continue;
    }

    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (protocol === "chat") {
      for (const choice of event?.choices || []) {
        const content = choice?.delta?.content ?? choice?.message?.content;
        if (typeof content === "string") streamedText += content;
        if (Array.isArray(content)) {
          streamedText += content
            .map((part) => part?.text ?? part?.content ?? "")
            .filter((part) => typeof part === "string")
            .join("");
        }
        if (choice?.finish_reason != null) completed = true;
      }
      continue;
    }

    if (protocol === "messages") {
      if (event?.type === "message_stop") completed = true;
      if (typeof event?.delta?.text === "string") streamedText += event.delta.text;
      continue;
    }

    if (event?.type === "response.completed" || event?.type === "response.done") completed = true;
    const delta = event?.delta ?? event?.text ?? event?.output_text;
    if (typeof delta === "string") streamedText += delta;
  }

  if (protocol === "messages" && /message_stop/.test(body)) completed = true;
  if (protocol === "responses" && /response\.(?:completed|done)/.test(body)) completed = true;

  return {
    marker: markerPresent(provider, streamedText, STREAM_MARKER) || markerPresent(provider, body, STREAM_MARKER),
    completed,
  };
}

export async function streamingProbe(provider, credential, model, { fetchImpl = undiciFetch } = {}) {
  try {
    const response = await fetchImpl(endpointFor(provider), {
      method: "POST",
      headers: headersFor(provider, credential),
      body: JSON.stringify(withNativeProbeTurn(provider, streamBody(provider, model))),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    const protocol = protocolFor(provider);
    const evidence = streamEvidence(provider, body);
    return {
      ok: response.ok && evidence.marker && evidence.completed,
      status: response.status,
      detail: response.ok
        ? evidence.marker && evidence.completed
          ? "stream text and completion verified"
          : evidence.marker
            ? "stream completion missing"
            : evidence.completed
              ? "stream marker missing"
              : "stream marker and completion missing"
        : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, detail: trimDetail(error?.message || error) };
  }
}

function toolBody(provider, model, mode) {
  const protocol = protocolFor(provider);
  if (protocol === "messages") {
    return {
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: `Call ${TOOL_NAME} exactly once with value set to ok.` }],
      tools: [
        {
          name: TOOL_NAME,
          description: "Compatibility probe",
          input_schema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: mode === "required" ? "any" : "auto" },
    };
  }
  if (protocol === "responses") {
    return {
      model,
      input: `Call ${TOOL_NAME} exactly once with value set to ok. Do not answer normally.`,
      max_output_tokens: 1024,
      tools: [
        {
          type: "function",
          name: TOOL_NAME,
          description: "Compatibility probe",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: mode,
    };
  }
  return {
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: `Call ${TOOL_NAME} exactly once with value set to ok. Do not answer normally.` }],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL_NAME,
          description: "Compatibility probe",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: mode,
  };
}

function toolCallFrom(provider, payload) {
  const protocol = protocolFor(provider);
  if (protocol === "messages") {
    const call = (payload?.content || []).find((part) => part?.type === "tool_use" && part?.name === TOOL_NAME);
    return { name: call?.name, args: call?.input };
  }
  if (protocol === "responses") {
    const call = (payload?.output || []).find((item) => item?.type === "function_call" && item?.name === TOOL_NAME);
    let args;
    try {
      args = JSON.parse(call?.arguments || "{}");
    } catch {
      args = undefined;
    }
    return { name: call?.name, args };
  }
  const call = (payload?.choices?.[0]?.message?.tool_calls || []).find((item) => item?.function?.name === TOOL_NAME);
  let args;
  try {
    args = JSON.parse(call?.function?.arguments || "{}");
  } catch {
    args = undefined;
  }
  return { name: call?.function?.name, args };
}

async function oneToolProbe(provider, credential, model, mode, options = {}) {
  try {
    const { response, payload } = await postJson(provider, credential, toolBody(provider, model, mode), options);
    const call = toolCallFrom(provider, payload);
    return {
      ok: response.ok && call.name === TOOL_NAME && call.args?.value === "ok",
      status: response.status,
      detail: response.ok
        ? call.name === TOOL_NAME && call.args?.value === "ok"
          ? "function call and JSON arguments verified"
          : "function call missing or arguments invalid"
        : errorDetail(payload, response.status),
    };
  } catch (error) {
    return { ok: false, status: 0, detail: trimDetail(error?.message || error) };
  }
}

function isAutoOnlyToolChoiceRejection(result) {
  if (result?.status !== 400) return false;
  const detail = String(result?.detail || "").toLowerCase();
  return detail.includes("tool_choice") && detail.includes("auto") && detail.includes("supported");
}

export async function toolProbe(provider, credential, model, options = {}) {
  const { autoAttempts = 2, ...probeOptions } = options;
  const required = await oneToolProbe(provider, credential, model, "required", probeOptions);
  if (required.ok) {
    return { ok: true, required, auto: undefined, autoAttempts: [], requestProfile: undefined };
  }

  // Some reseller-backed models accept tools only with tool_choice=auto. That
  // mode is intentionally non-forcing, so one otherwise healthy probe can
  // occasionally answer normally or hit a transient upstream 5xx. Once the
  // provider has explicitly identified the restriction, allow one bounded
  // repeat of the auto probe instead of making the operator rerun the entire
  // basic/streaming/protocol verification sequence.
  const attempts = [];
  const boundedAttempts = isAutoOnlyToolChoiceRejection(required)
    ? Math.max(1, Math.min(2, Number(autoAttempts) || 1))
    : 1;
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    const auto = await oneToolProbe(provider, credential, model, "auto", probeOptions);
    attempts.push(auto);
    if (auto.ok) {
      return { ok: true, required, auto, autoAttempts: attempts, requestProfile: "auto-tool-choice" };
    }
  }
  return {
    ok: false,
    required,
    auto: attempts.at(-1),
    autoAttempts: attempts,
    requestProfile: undefined,
  };
}

export async function reasoningProbe(provider, credential, model, options = {}) {
  if (protocolFor(provider) === "messages") {
    return { ok: false, skipped: true, detail: "reasoning_effort is not probed on Anthropic Messages" };
  }
  try {
    const { response, payload } = await postJson(
      provider,
      credential,
      basicBody(provider, model, { reasoningEffort: "high" }),
      options,
    );
    const text = basicText(provider, payload);
    return {
      ok: response.ok && markerPresent(provider, text, BASIC_MARKER),
      status: response.status,
      detail: response.ok ? (markerPresent(provider, text, BASIC_MARKER) ? "high effort verified" : "marker missing") : errorDetail(payload, response.status),
    };
  } catch (error) {
    return { ok: false, status: 0, detail: trimDetail(error?.message || error) };
  }
}

async function routeCredential(provider) {
  const credential = resolveProviderCredential(provider);
  if (!credential) throw new Error(`${provider.displayName} credential is not configured.`);
  return credential;
}

function prepareInferenceTransport() {
  // Discovery deliberately pins the provider hostname to the addresses it
  // validated and therefore refuses a proxy that resolves the destination on
  // its own. Preserve that boundary: only after discovery has established the
  // exact model ID do billed inference probes adopt the installation's recorded
  // proxy and install the normal stable outbound dispatcher.
  Object.assign(process.env, inheritedProxyEnvironment());
  return installStableFetchTransport();
}

export async function verifyModel(
  providerId,
  model,
  {
    fetchImpl = undiciFetch,
    discover = discoverProviderModels,
    routeOverride,
    refresh = true,
    credentialFor = routeCredential,
    prepareTransport = prepareInferenceTransport,
  } = {},
) {
  const primaryProviderId = curationPrimaryProviderId(providerId);
  const primary = PROVIDERS.get(primaryProviderId);
  if (!primary) throw new Error(`Unknown provider: ${providerId}`);

  const discovery = await discover(primaryProviderId, { refresh });
  if (!discovery.discovered.includes(model)) {
    throw new Error(`${primary.displayName} does not currently advertise ${model}.`);
  }

  const registeredRoutes = MODELS.filter(
    (entry) => curationProviderIds(primaryProviderId).includes(entry.provider) && entry.upstreamModel === model,
  );
  if (registeredRoutes.length) {
    return {
      provider: primaryProviderId,
      model,
      alreadyRegistered: true,
      registeredSlugs: registeredRoutes.map((entry) => entry.slug),
      discovery,
    };
  }

  const routes = curationProviderIds(primaryProviderId)
    .map((id) => PROVIDERS.get(id))
    .filter(Boolean);
  if (!routes.length) {
    throw new Error(`${primary.displayName} has no routable curation endpoint to verify.`);
  }
  if (routeOverride && !routes.some((route) => route.id === routeOverride)) {
    throw new Error(`--route must be one of: ${routes.map((route) => route.id).join(", ")}.`);
  }

  await prepareTransport();

  const routesToProbe = routeOverride
    ? routes.filter((route) => route.id === routeOverride)
    : routes;
  const protocolChecks = [];
  for (const route of routesToProbe) {
    const credential = await credentialFor(route);
    const basic = await basicProbe(route, credential, model, { fetchImpl });
    protocolChecks.push({ route: route.id, protocol: protocolFor(route), basic, credential });
  }

  const basicCandidates = protocolChecks.filter((item) => item.basic.ok);
  const routesToProve = routeOverride
    ? basicCandidates.filter((item) => item.route === routeOverride)
    : basicCandidates;
  if (!routesToProve.length) {
    return {
      provider: primaryProviderId,
      model,
      safeToCurate: false,
      reason: routeOverride
        ? `The requested route ${routeOverride} did not pass the basic probe.`
        : "No provider route passed the basic probe.",
      protocolChecks: protocolChecks.map(({ credential, ...item }) => item),
      discovery,
    };
  }

  const proven = [];
  for (const candidate of routesToProve) {
    const route = PROVIDERS.get(candidate.route);
    const streaming = await streamingProbe(route, candidate.credential, model, { fetchImpl });
    const tools = await toolProbe(route, candidate.credential, model, { fetchImpl });
    const reasoning = await reasoningProbe(route, candidate.credential, model, { fetchImpl });
    proven.push({
      route: route.id,
      protocol: candidate.protocol,
      basic: candidate.basic,
      streaming,
      tools,
      reasoning,
      ok: candidate.basic.ok && streaming.ok && tools.ok,
      requestProfile: tools.requestProfile,
    });
  }

  const compatible = proven.filter((item) => item.ok);
  if (compatible.length !== 1) {
    return {
      provider: primaryProviderId,
      model,
      safeToCurate: false,
      reason: compatible.length === 0
        ? "No route passed basic, streaming, and tool-call verification."
        : `More than one route passed (${compatible.map((item) => item.route).join(", ")}); rerun with --route to choose explicitly.`,
      protocolChecks: protocolChecks.map(({ credential, ...item }) => item),
      routeChecks: proven,
      discovery,
    };
  }

  const selected = compatible[0];
  return {
    provider: primaryProviderId,
    model,
    safeToCurate: true,
    selectedRoute: selected.route,
    protocol: selected.protocol,
    requestProfile: selected.requestProfile,
    contextWindow: discovery.contextLengths?.[model],
    reasoningEfforts: selected.reasoning.ok ? ["high"] : [],
    protocolChecks: protocolChecks.map(({ credential, ...item }) => item),
    routeChecks: proven,
    discovery,
  };
}

function compatibilityChild(slug) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "compatibility-test.mjs"), slug, "--live", "--yes", "--json"],
    {
      cwd: SOURCE_ROOT,
      env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  let payload;
  try {
    payload = JSON.parse(String(result.stdout || ""));
  } catch {
    payload = undefined;
  }
  return {
    ok: result.status === 0 && payload?.ok === true,
    status: result.status,
    payload,
    detail: payload?.ok === true
      ? "full routed compatibility verified"
      : trimDetail(payload ? JSON.stringify(payload) : result.stderr || result.stdout || result.error?.message),
  };
}

export async function applyVerifiedModel(
  report,
  {
    lock = withModelOverlayLock,
    publish = applyModelOverlayPublication,
    compatibility = compatibilityChild,
    readModels = readUserModels,
    writeModels = writeUserModels,
    setVisible = setModelsVisible,
    capture = captureModelOverlayFiles,
    restore = restoreModelOverlayFiles,
  } = {},
) {
  if (!report?.safeToCurate) throw new Error("The model has not passed live compatibility verification.");

  const familyProviderIds = curationProviderIds(report.provider);
  return lock(async () => {
    // Capture and decide priority only after the cross-process lock is held.
    // A live verification can take minutes; another curation may legitimately
    // finish while it runs. Reading state before this lock and later rolling
    // back to that stale snapshot would erase the other operator's change.
    const snapshots = capture([USER_MODELS_PATH, MODEL_PICKER_STATE_PATH]);
    const current = readModels();
    const family = current.filter((model) => familyProviderIds.includes(model.provider));
    if (family.some((entry) => entry.upstreamModel === report.model)) {
      throw new Error(`${report.model} is already locally curated.`);
    }

    const metadata = {
      ...verifiedSizing(report.contextWindow),
      ...verifiedEffortMetadata(report.reasoningEfforts),
    };
    const entry = userModelEntry({
      providerId: report.selectedRoute,
      upstreamId: report.model,
      requestProfile: report.requestProfile,
      priority: 100 + family.length,
      metadata,
    });
    // `userModelEntry` carries a conservative high-only reasoning default. A
    // failed reasoning probe is evidence to advertise no effort control, not a
    // reason to keep that default and turn an unverified assumption into UI.
    if (!report.reasoningEfforts?.length) {
      delete entry.defaultEffort;
      delete entry.reasoningLevels;
    }

    const owned = new Set(familyProviderIds);
    const next = [
      ...current.filter((model) => !owned.has(model.provider)),
      ...family,
      entry,
    ];

    let operationError;
    try {
      writeModels(next);
      setVisible([entry.slug], true);
      await publish({ restart: true });
      const finalCompatibility = await compatibility(entry.slug);
      if (!finalCompatibility?.ok) {
        const error = new Error(
          `The model passed direct provider probes but failed the routed compatibility test; ` +
            `the local model addition will be rolled back. ${finalCompatibility?.detail || "unknown failure"}`,
        );
        error.finalCompatibility = finalCompatibility;
        throw error;
      }
      return { entry, finalCompatibility };
    } catch (error) {
      operationError = error;
    }

    try {
      restore(snapshots);
      await publish({ restart: true });
    } catch (rollbackError) {
      throw aggregateRollbackError(operationError, rollbackError);
    }
    throw operationError;
  });
}

function reportForOutput(report) {
  const { discovery, ...safe } = report;
  return {
    ...safe,
    discovery: discovery
      ? {
          provider: discovery.provider,
          contextWindow: discovery.contextLengths?.[report.model],
          blockedReason: discovery.blocked?.[report.model],
          fetchedAt: discovery.fetchedAt,
          cached: discovery.cached,
        }
      : undefined,
  };
}

function printHuman(report, applied) {
  process.stdout.write(`Model: ${report.model}\n`);
  if (report.alreadyRegistered) {
    process.stdout.write(`Already registered: ${report.registeredSlugs.join(", ")}\n`);
    return;
  }
  for (const check of report.protocolChecks || []) {
    process.stdout.write(`${check.basic.ok ? "PASS" : "FAIL"} ${check.route} (${check.protocol}) basic: ${check.basic.detail}\n`);
  }
  for (const route of report.routeChecks || []) {
    process.stdout.write(`${route.streaming.ok ? "PASS" : "FAIL"} ${route.route} streaming: ${route.streaming.detail}\n`);
    const toolDetail = route.tools.requestProfile === "auto-tool-choice"
      ? `required rejected, auto function call verified${
          route.tools.autoAttempts?.length > 1 ? ` after ${route.tools.autoAttempts.length} auto attempts` : ""
        }`
      : [
          route.tools.required?.detail ? `required: ${route.tools.required.detail}` : undefined,
          route.tools.auto?.detail ? `auto: ${route.tools.auto.detail}` : undefined,
        ].filter(Boolean).join("; ") || "tool verification failed";
    process.stdout.write(`${route.tools.ok ? "PASS" : "FAIL"} ${route.route} tools: ${toolDetail}\n`);
    if (route.reasoning?.skipped) {
      process.stdout.write(`SKIP ${route.route} reasoning: ${route.reasoning.detail}\n`);
    } else {
      process.stdout.write(`${route.reasoning?.ok ? "PASS" : "WARN"} ${route.route} reasoning=high: ${route.reasoning?.detail || "not verified"}\n`);
    }
  }
  if (!report.safeToCurate) {
    process.stdout.write(`Safe to curate: NO\nReason: ${report.reason}\n`);
    return;
  }
  process.stdout.write(`Safe to curate: YES\n`);
  process.stdout.write(`Selected route: ${report.selectedRoute}\n`);
  process.stdout.write(`Request profile: ${report.requestProfile || "default"}\n`);
  if (report.contextWindow) process.stdout.write(`Context window: ${report.contextWindow}\n`);
  if (applied) {
    process.stdout.write(`Added: ${applied.entry.slug}\n`);
    process.stdout.write(`Final routed compatibility: PASS\n`);
    process.stdout.write("Fully quit and reopen Codex to refresh the picker.\n");
  } else {
    process.stdout.write("Run again with --apply to add this verified model locally.\n");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.length < 2) {
    process.stdout.write(
      "Usage: verify-model PROVIDER MODEL --live --yes [--apply] [--route PROVIDER_VARIANT] [--json]\n\n" +
        "Live-probes an unregistered model on the provider family's available route or protocol variants. " +
        "With --apply, only a uniquely verified route is curated locally, published, restarted, " +
        "and then checked through the router's full exact-route compatibility test.\n",
    );
    if (argv.length < 2 && !argv.includes("--help")) process.exitCode = 2;
    return;
  }
  if (!argv.includes("--live") || !argv.includes("--yes")) {
    throw new Error("Live verification consumes provider quota; pass both --live and --yes to confirm.");
  }

  const provider = argv[0];
  const model = argv[1];
  const routeOverride = option("--route", argv);
  const asJson = argv.includes("--json");
  const apply = argv.includes("--apply");

  const report = await verifyModel(provider, model, { routeOverride, refresh: true });
  let applied;
  if (apply && report.safeToCurate && !report.alreadyRegistered) {
    applied = await applyVerifiedModel(report);
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ...reportForOutput(report), ...(applied ? { applied } : {}) }, null, 2)}\n`);
  } else {
    printHuman(report, applied);
  }
  if (!report.alreadyRegistered && !report.safeToCurate) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
