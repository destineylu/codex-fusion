const MILLION = 1_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_REQUEST_LIMIT = 40;

export const XKIRO_PRICING_VERSION = "models-2026-09-14";
export const XKIRO_PRICING_SOURCE = "https://api.xkiro.com/v1/models";

function entry(id, label, { input, output, cacheRead, cacheWrite, accessTier = "paid" }) {
  return Object.freeze({
    id,
    label,
    accessTier,
    rates: Object.freeze({
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    }),
  });
}

// Verified against Xkiro's authenticated /v1/models catalog on 2026-09-14.
// Historical events keep a pricing snapshot so a later catalog change does not
// rewrite yesterday's local attribution.
const PRICING = Object.freeze([
  entry("anthropic/claude-fable-5", "Claude Fable 5", { input: 9, output: 45, cacheRead: 0.9, cacheWrite: 18 }),
  entry("anthropic/claude-fable-5-1", "Claude Fable 5.1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 }),
  entry("anthropic/claude-opus-5", "Claude Opus 5", { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 9 }),
  entry("anthropic/claude-sonnet-5", "Claude Sonnet 5", { input: 1.8, output: 9, cacheRead: 0.18, cacheWrite: 3.6 }),
  entry("deepseek/deepseek-v4-flash-0731", "DeepSeek V4 Flash (0731)", { input: 0.091, output: 0.182, cacheRead: 0.0182, accessTier: "premium" }),
  entry("moonshotai/kimi-k3", "Kimi K3", { input: 1.95, output: 9.75, accessTier: "premium" }),
  entry("openai/gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", { input: 0, output: 0, accessTier: "free" }),
  entry("openai/gpt-5.6-sol", "GPT-5.6 Sol", { input: 4.5, output: 27, cacheRead: 0.45 }),
  entry("openai/gpt-6-astra", "GPT-6 Astra", { input: 10, output: 50, cacheRead: 1 }),
  entry("x-ai/grok-4.6", "Grok 4.6", { input: 1, output: 3 }),
  entry("z-ai/glm-5.3", "GLM-5.3", { input: 1.4, output: 4.4, cacheRead: 0.26 }),
  entry("z-ai/glm-5.3-flash", "GLM-5.3 Flash", { input: 0.15, output: 0.5, cacheRead: 0.03 }),
]);

const BY_ID = new Map(PRICING.map((pricing) => [pricing.id, pricing]));

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function roundedMoney(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

export function xkiroUpstreamModelId(model) {
  const value = String(model || "").trim();
  return value.replace(/^xkiro2?\//, "");
}

export function xkiroPricingForModel(model) {
  const pricing = BY_ID.get(xkiroUpstreamModelId(model));
  if (!pricing) return undefined;
  return {
    modelId: pricing.id,
    modelLabel: pricing.label,
    accessTier: pricing.accessTier,
    pricingVersion: XKIRO_PRICING_VERSION,
    pricingSource: XKIRO_PRICING_SOURCE,
    rates: { ...pricing.rates },
  };
}

export function xkiroBillingSnapshot({
  model,
  status,
  inputTokens,
  billedInputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  billedOutputTokens,
  estimatedInputTokens,
  retrospective = false,
} = {}) {
  const pricing = xkiroPricingForModel(model);
  if (!pricing) return undefined;

  const numericStatus = Number(status);
  if (Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus !== 499) {
    return {
      pricingVersion: pricing.pricingVersion,
      pricingSource: pricing.pricingSource,
      modelId: pricing.modelId,
      modelLabel: pricing.modelLabel,
      accessTier: pricing.accessTier,
      rates: pricing.rates,
      usageValueUsd: 0,
      complete: true,
      chargeable: false,
      ...(retrospective ? { retrospective: true } : {}),
    };
  }

  const input = finiteNonnegative(billedInputTokens ?? inputTokens);
  const output = finiteNonnegative(billedOutputTokens ?? outputTokens);
  const cached = input === undefined
    ? 0
    : Math.min(finiteNonnegative(cachedInputTokens) ?? 0, input);
  const cacheWrite = finiteNonnegative(cacheWriteInputTokens);
  const estimatedInput = finiteNonnegative(estimatedInputTokens);
  const suspiciousZeroInput = input === 0 && ((estimatedInput ?? 0) >= 1_000 || (output ?? 0) > 0);
  const incompleteReasons = [];

  if (input === undefined || suspiciousZeroInput) incompleteReasons.push("input-usage-unavailable");
  if (pricing.rates.cacheWrite !== undefined && cacheWrite === undefined) {
    incompleteReasons.push("cache-write-usage-unavailable");
  }

  let usageValueUsd = 0;
  if (input !== undefined && !suspiciousZeroInput) {
    const fresh = Math.max(0, input - cached);
    usageValueUsd += (fresh * pricing.rates.input) / MILLION;
    usageValueUsd += (cached * (pricing.rates.cacheRead ?? pricing.rates.input)) / MILLION;
  }
  if (output !== undefined) usageValueUsd += (output * pricing.rates.output) / MILLION;
  if (cacheWrite !== undefined && pricing.rates.cacheWrite !== undefined) {
    usageValueUsd += (cacheWrite * pricing.rates.cacheWrite) / MILLION;
  }

  return {
    pricingVersion: pricing.pricingVersion,
    pricingSource: pricing.pricingSource,
    modelId: pricing.modelId,
    modelLabel: pricing.modelLabel,
    accessTier: pricing.accessTier,
    rates: pricing.rates,
    usageValueUsd: roundedMoney(usageValueUsd),
    complete: incompleteReasons.length === 0,
    chargeable: true,
    ...(incompleteReasons.length ? { incompleteReasons } : {}),
    ...(retrospective ? { retrospective: true } : {}),
  };
}

export function sanitizeXkiroBilling(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usageValueUsd = finiteNonnegative(value.usageValueUsd);
  if (usageValueUsd === undefined) return undefined;
  const rates = value.rates && typeof value.rates === "object"
    ? Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite"]
          .map((key) => [key, finiteNonnegative(value.rates[key])])
          .filter(([, number]) => number !== undefined),
      )
    : {};
  return {
    pricingVersion: String(value.pricingVersion || XKIRO_PRICING_VERSION).slice(0, 80),
    pricingSource: String(value.pricingSource || XKIRO_PRICING_SOURCE).slice(0, 200),
    modelId: String(value.modelId || "unknown").slice(0, 160),
    modelLabel: String(value.modelLabel || value.modelId || "Unknown model").slice(0, 160),
    accessTier: String(value.accessTier || "unknown").slice(0, 40),
    rates,
    usageValueUsd: roundedMoney(usageValueUsd),
    complete: value.complete === true,
    chargeable: value.chargeable !== false,
    ...(Array.isArray(value.incompleteReasons)
      ? { incompleteReasons: value.incompleteReasons.map((reason) => String(reason).slice(0, 80)).slice(0, 4) }
      : {}),
    ...(value.retrospective === true ? { retrospective: true } : {}),
  };
}

function emptySpendWindow(key, label, from, to) {
  return {
    key,
    label,
    from: Number.isFinite(from) ? new Date(from).toISOString() : null,
    to: new Date(to).toISOString(),
    usageValueUsd: 0,
    requests: 0,
    pricedRequests: 0,
    incompleteRequests: 0,
    retrospectiveRequests: 0,
    unpricedRequests: 0,
    models: new Map(),
  };
}

function modelSpendBucket(model, billing) {
  return {
    slug: model,
    displayName: billing?.modelLabel || String(model || "unknown").split("/").at(-1) || "unknown",
    accessTier: billing?.accessTier,
    usageValueUsd: 0,
    requests: 0,
    pricedRequests: 0,
    incompleteRequests: 0,
    retrospectiveRequests: 0,
    unpricedRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function addSpendEvent(window, event, billing) {
  window.requests += 1;
  const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
  const model = window.models.get(slug) || modelSpendBucket(slug, billing);
  model.requests += 1;
  model.inputTokens += finiteNonnegative(event.billedInputTokens ?? event.inputTokens) ?? 0;
  model.cachedInputTokens += finiteNonnegative(event.cachedInputTokens) ?? 0;
  model.outputTokens += finiteNonnegative(event.billedOutputTokens ?? event.outputTokens) ?? 0;

  if (!billing) {
    window.unpricedRequests += 1;
    model.unpricedRequests += 1;
  } else {
    window.pricedRequests += 1;
    model.pricedRequests += 1;
    window.usageValueUsd += billing.usageValueUsd;
    model.usageValueUsd += billing.usageValueUsd;
    model.accessTier ??= billing.accessTier;
    if (!billing.complete) {
      window.incompleteRequests += 1;
      model.incompleteRequests += 1;
    }
    if (billing.retrospective) {
      window.retrospectiveRequests += 1;
      model.retrospectiveRequests += 1;
    }
  }
  window.models.set(slug, model);
}

function recentSpendRequest(event, billing, at) {
  const slug = typeof event.model === "string" && event.model ? event.model : "unknown";
  return {
    at: new Date(at).toISOString(),
    slug,
    displayName: billing?.modelLabel || slug.split("/").at(-1) || "unknown",
    status: Number.isInteger(event.status) ? event.status : 0,
    durationMs: finiteNonnegative(event.durationMs) ?? 0,
    inputTokens: finiteNonnegative(event.billedInputTokens ?? event.inputTokens),
    cachedInputTokens: finiteNonnegative(event.cachedInputTokens),
    outputTokens: finiteNonnegative(event.billedOutputTokens ?? event.outputTokens),
    estimatedInputTokens: finiteNonnegative(event.estimatedInputTokens),
    usageValueUsd: billing?.usageValueUsd,
    complete: billing?.complete === true,
    retrospective: billing?.retrospective === true,
  };
}

function finalizedWindow(window) {
  return {
    ...window,
    usageValueUsd: roundedMoney(window.usageValueUsd),
    models: [...window.models.values()]
      .map((model) => ({
        ...model,
        usageValueUsd: roundedMoney(model.usageValueUsd),
        cacheHitPercent: model.inputTokens > 0
          ? Math.round((Math.min(model.cachedInputTokens, model.inputTokens) / model.inputTokens) * 10_000) / 100
          : null,
      }))
      .sort((left, right) => right.usageValueUsd - left.usageValueUsd || right.requests - left.requests),
  };
}

export function aggregateXkiroSpend(events, {
  providerId,
  now = Date.now(),
  fiveHourStart,
  weeklyStart,
} = {}) {
  if (providerId !== "xkiro" && providerId !== "xkiro2") {
    throw new Error("aggregateXkiroSpend requires providerId xkiro or xkiro2");
  }
  const fiveStart = Number.isFinite(fiveHourStart) ? fiveHourStart : now - 5 * HOUR_MS;
  const weekStart = Number.isFinite(weeklyStart) ? weeklyStart : now - 7 * DAY_MS;
  const windows = {
    fiveHour: emptySpendWindow("fiveHour", "Current 5 hours", fiveStart, now),
    weekly: emptySpendWindow("weekly", "Current 7 days", weekStart, now),
    thirtyDay: emptySpendWindow("thirtyDay", "Last 30 days", now - 30 * DAY_MS, now),
    all: emptySpendWindow("all", "All tracked", Number.NEGATIVE_INFINITY, now),
  };
  let capturedFrom = Number.POSITIVE_INFINITY;
  let observedFrom = Number.POSITIVE_INFINITY;
  const recentRequests = [];

  for (const event of events || []) {
    if (String(event?.provider || "") !== providerId) continue;
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at > now) continue;
    observedFrom = Math.min(observedFrom, at);
    const billing = sanitizeXkiroBilling(event.xkiroBilling);
    if (billing) {
      capturedFrom = Math.min(capturedFrom, at);
    }
    recentRequests.push(recentSpendRequest(event, billing, at));
    for (const window of Object.values(windows)) {
      const from = window.from ? Date.parse(window.from) : Number.NEGATIVE_INFINITY;
      if (at >= from) addSpendEvent(window, event, billing);
    }
  }

  recentRequests.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  return {
    providerId,
    pricingVersion: XKIRO_PRICING_VERSION,
    pricingSource: XKIRO_PRICING_SOURCE,
    observedFrom: Number.isFinite(observedFrom) ? new Date(observedFrom).toISOString() : null,
    capturedFrom: Number.isFinite(capturedFrom) ? new Date(capturedFrom).toISOString() : null,
    recentRequests: recentRequests.slice(0, RECENT_REQUEST_LIMIT),
    windows: Object.fromEntries(
      Object.entries(windows).map(([key, window]) => [key, finalizedWindow(window)]),
    ),
  };
}
