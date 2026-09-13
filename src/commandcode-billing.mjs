// Local, request-level Command Code cost attribution.
//
// Command Code exposes authoritative account balances/window caps but no
// provider endpoint this router can rely on for per-model rollups. The router
// therefore snapshots the public GOAT price table onto each metered request.
// Historical rows from before this feature remain immutable; a narrow
// same-day retrospective path lets the Control Center show today's earlier
// traffic while marking it as reconstructed rather than captured.

export const COMMANDCODE_PRICING_VERSION = "goat-2026-09-06";
export const COMMANDCODE_PRICING_SOURCE = "https://commandcode.ai/docs/plans/goat";
export const COMMANDCODE_GOAT_MONTHLY_CREDITS = 70;
export const COMMANDCODE_RETROSPECTIVE_FROM = Date.parse("2026-09-06T00:00:00Z");

const MILLION = 1_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_REQUEST_LIMIT = 20;

function normalizedId(value) {
  return String(value || "").trim().toLowerCase();
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function roundedMoney(value) {
  return Math.round((Number(value) || 0) * 1e12) / 1e12;
}

function entry({ key, label, ids, input, output, cacheRead, cacheWrite, allowance, peak }) {
  return {
    key,
    label,
    ids: ids.map(normalizedId),
    rates: { input, output, cacheRead, ...(cacheWrite !== undefined ? { cacheWrite } : {}) },
    allowance,
    ...(peak ? { peak } : {}),
  };
}

// Rates are USD per 1M tokens from Command Code's GOAT page as published on
// 2026-09-06. Models not listed here are deliberately left unpriced rather
// than guessed. Older GOAT models called out by the page as standard-$20 use
// the same published token rates shown in the model table.
const PRICING = [
  entry({ key: "gpt-5.6-sol", label: "GPT-5.6 Sol", ids: ["commandcode/gpt-5.6-sol", "gpt-5.6-sol"], input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25, allowance: 70 }),
  entry({ key: "gpt-5.6-luna", label: "GPT-5.6 Luna", ids: ["commandcode/gpt-5.6-luna", "gpt-5.6-luna"], input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25, allowance: 20 }),
  entry({
    key: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    ids: ["commandcode/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    allowance: 60,
    peak: { input: 0.44, output: 1.32, cacheRead: 0.01 },
  }),
  entry({
    key: "deepseek-v4-flash-vision",
    label: "DeepSeek V4 Flash Vision",
    ids: ["commandcode/deepseek/deepseek-v4-flash-vision-exp", "deepseek/deepseek-v4-flash-vision-exp"],
    input: 0.22,
    output: 0.66,
    cacheRead: 0.007,
    allowance: 20,
    peak: { input: 0.44, output: 1.32, cacheRead: 0.01 },
  }),
  entry({ key: "deepseek-v4-flash-fast", label: "DeepSeek V4 Flash Fast", ids: ["commandcode/deepseek/deepseek-v4-flash-fast", "deepseek/deepseek-v4-flash-fast"], input: 0.28, output: 0.56, cacheRead: 0.07, allowance: 20 }),
  entry({
    key: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    ids: ["commandcode/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    allowance: 20,
    peak: { input: 1.32, output: 3.96, cacheRead: 0.04 },
  }),
  entry({ key: "glm-5.3-flash", label: "GLM-5.3 Flash", ids: ["commandcode/z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"], input: 0.15, output: 0.5, cacheRead: 0.03, allowance: 40 }),
  entry({ key: "glm-5.3", label: "GLM-5.3", ids: ["commandcode/glm-5.3", "zai-org/glm-5.3"], input: 1.4, output: 4.4, cacheRead: 0.26, allowance: 20 }),
  entry({ key: "glm-5.2", label: "GLM-5.2", ids: ["commandcode/glm-5.2", "zai-org/glm-5.2"], input: 1.4, output: 4.4, cacheRead: 0.26, allowance: 70 }),
  entry({ key: "glm-5.2-fast", label: "GLM-5.2 Fast", ids: ["commandcode/glm-5.2-fast", "zai-org/glm-5.2-fast"], input: 3, output: 10.25, cacheRead: 0.5, allowance: 20 }),
  entry({ key: "glm-5.1", label: "GLM-5.1", ids: ["zai-org/glm-5.1"], input: 1.4, output: 4.4, cacheRead: 0.26, allowance: 20 }),
  entry({ key: "glm-5", label: "GLM-5", ids: ["zai-org/glm-5"], input: 1, output: 3.2, cacheRead: 0.2, allowance: 20 }),
  entry({ key: "kimi-k3", label: "Kimi K3", ids: ["commandcode/kimi-k3", "moonshotai/kimi-k3"], input: 3, output: 15, cacheRead: 0.3, allowance: 20 }),
  entry({ key: "kimi-k2.7-code", label: "Kimi K2.7 Code", ids: ["commandcode/kimi-k2.7-code", "moonshotai/kimi-k2.7-code"], input: 0.95, output: 4, cacheRead: 0.19, allowance: 60 }),
  entry({ key: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code HighSpeed", ids: ["commandcode/kimi-k2.7-code-highspeed", "moonshotai/kimi-k2.7-code-highspeed"], input: 1.9, output: 8, cacheRead: 0.38, allowance: 20 }),
  entry({ key: "kimi-k2.6", label: "Kimi K2.6", ids: ["moonshotai/kimi-k2.6"], input: 0.95, output: 4, cacheRead: 0.16, allowance: 20 }),
  entry({ key: "kimi-k2.5", label: "Kimi K2.5", ids: ["moonshotai/kimi-k2.5"], input: 0.6, output: 3, cacheRead: 0.1, allowance: 20 }),
  entry({ key: "muse-spark-1.3", label: "Muse Spark 1.3", ids: ["commandcode/meta/muse-spark-1.3", "meta/muse-spark-1.3"], input: 1.25, output: 4.25, cacheRead: 0.15, allowance: 20 }),
  entry({ key: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", ids: ["commandcode/meta/muse-spark-1.3-contributor", "meta/muse-spark-1.3-contributor"], input: 0.1, output: 0.2, cacheRead: 0.002, allowance: 20 }),
  entry({ key: "muse-spark-1.2", label: "Muse Spark 1.2", ids: ["commandcode/muse-spark-1.2", "meta/muse-spark-1.2"], input: 1.25, output: 4.25, cacheRead: 0.15, allowance: 20 }),
  entry({ key: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 Contributor", ids: ["meta/muse-spark-1.2-contributor"], input: 0.1, output: 0.2, cacheRead: 0.002, allowance: 20 }),
  entry({ key: "gemini-3.8-flash", label: "Gemini 3.8 Flash", ids: ["google/gemini-3.8-flash"], input: 1.5, output: 7.5, cacheRead: 0.15, allowance: 40 }),
  entry({ key: "gemini-3.7-flash", label: "Gemini 3.7 Flash", ids: ["commandcode/gemini-3.7-flash", "google/gemini-3.7-flash"], input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.08334, allowance: 40 }),
  entry({ key: "grok-4.5", label: "Grok 4.5", ids: ["commandcode/grok-4.5", "xai/grok-4.5"], input: 2, output: 6, cacheRead: 0.5, allowance: 20 }),
  entry({ key: "grok-4.6", label: "Grok 4.6", ids: ["commandcode/grok-4.6", "xai/grok-4.6"], input: 2, output: 6, cacheRead: 0.5, allowance: 20 }),
  entry({ key: "tencent-hy3", label: "Tencent Hy3", ids: ["commandcode/hy3-paid", "tencent/hy3-paid"], input: 0.14, output: 0.58, cacheRead: 0.035, allowance: 70 }),
  entry({ key: "tencent-hy4-preview", label: "Tencent Hy4 Preview", ids: ["tencent/hy4-preview"], input: 0.834, output: 2.501, cacheRead: 0.042, allowance: 20 }),
  entry({ key: "minimax-m3", label: "MiniMax M3", ids: ["commandcode/minimax-m3", "minimaxai/minimax-m3"], input: 0.3, output: 1.2, cacheRead: 0.06, allowance: 47 }),
  entry({ key: "minimax-m2.7", label: "MiniMax M2.7", ids: ["commandcode/minimax-m2.7", "minimaxai/minimax-m2.7"], input: 0.3, output: 1.2, cacheRead: 0.06, allowance: 20 }),
  entry({ key: "minimax-m2.5", label: "MiniMax M2.5", ids: ["minimaxai/minimax-m2.5"], input: 0.3, output: 1.2, cacheRead: 0.03, allowance: 20 }),
  entry({ key: "mimo-v2.5", label: "MiMo V2.5", ids: ["xiaomi/mimo-v2.5"], input: 0.14, output: 0.28, cacheRead: 0.0028, allowance: 30 }),
  entry({ key: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", ids: ["commandcode/mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro"], input: 0.435, output: 0.87, cacheRead: 0.0036, allowance: 20 }),
  entry({ key: "qwen-3.8-max-0902", label: "Qwen 3.8 Max 0902", ids: ["qwen/qwen3.8-max-0902"], input: 2, output: 6, cacheRead: 0.25, allowance: 20 }),
  entry({ key: "qwen-3.8-max", label: "Qwen 3.8 Max", ids: ["commandcode/qwen3.8-max", "qwen/qwen3.8-max"], input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5, allowance: 20 }),
  entry({ key: "qwen-3.8-27b", label: "Qwen 3.8 27B", ids: ["qwen/qwen3.8-27b"], input: 0.4, output: 3, cacheRead: 0.04, allowance: 70 }),
  entry({ key: "qwen-3.8-flash", label: "Qwen 3.8 Flash", ids: ["commandcode/qwen3.8-flash", "qwen/qwen3.8-flash"], input: 0.16, output: 0.47, cacheRead: 0.016, allowance: 20 }),
  entry({ key: "qwen-3.7-max", label: "Qwen 3.7 Max", ids: ["commandcode/qwen3.7-max", "qwen/qwen3.7-max"], input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.13, allowance: 33 }),
  entry({ key: "qwen-3.7-plus", label: "Qwen 3.7 Plus", ids: ["commandcode/qwen3.7-plus", "qwen/qwen3.7-plus"], input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.5, allowance: 33 }),
  entry({ key: "qwen-3.7-flash", label: "Qwen 3.7 Flash", ids: ["commandcode/qwen3.7-flash", "qwen/qwen3.7-flash"], input: 0.03, output: 0.13, cacheRead: 0.006, cacheWrite: 0.038, allowance: 20 }),
  entry({ key: "qwen-3.6-plus", label: "Qwen 3.6 Plus", ids: ["qwen/qwen3.6-plus"], input: 0.5, output: 3, cacheRead: 0.1, allowance: 33 }),
  entry({ key: "qwen-3.6-max-preview", label: "Qwen 3.6 Max Preview", ids: ["qwen/qwen3.6-max-preview"], input: 1.3, output: 7.8, cacheRead: 0.26, cacheWrite: 1.63, allowance: 20 }),
  entry({ key: "inkling", label: "Inkling", ids: ["commandcode/inkling", "thinkingmachines/inkling"], input: 1, output: 4.05, cacheRead: 0.17, allowance: 20 }),
  entry({ key: "inkling-small", label: "Inkling Small", ids: ["commandcode/inkling-small", "thinkingmachines/inkling-small"], input: 0.5, output: 1.2, cacheRead: 0.1, allowance: 20 }),
  entry({ key: "step-3.7-flash", label: "Step 3.7 Flash", ids: ["commandcode/step-3.7-flash", "stepfun/step-3.7-flash"], input: 0.2, output: 1.15, cacheRead: 0.04, allowance: 20 }),
  entry({ key: "step-3.5-flash", label: "Step 3.5 Flash", ids: ["stepfun/step-3.5-flash"], input: 0.1, output: 0.3, cacheRead: 0.02, allowance: 20 }),
  entry({ key: "nemotron-3-ultra", label: "Nemotron 3 Ultra", ids: ["commandcode/nemotron-3-ultra", "nvidia/nemotron-3-ultra-550b-a55b"], input: 0.6, output: 2.4, cacheRead: 0.12, allowance: 20 }),
  entry({ key: "laguna-s-2.1", label: "Laguna S 2.1", ids: ["commandcode/laguna-s-2.1", "poolside/laguna-s-2.1-free"], input: 0, output: 0, cacheRead: 0, allowance: 70 }),
  entry({ key: "longcat-2.0", label: "LongCat 2.0", ids: ["meituan/longcat-2.0:free"], input: 0, output: 0, cacheRead: 0, allowance: 70 }),
];

const BY_ID = new Map();
for (const pricing of PRICING) {
  for (const id of pricing.ids) BY_ID.set(id, pricing);
}

function deepSeekPeak(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function commandCodePricingForModel(model, at = Date.now()) {
  const pricing = BY_ID.get(normalizedId(model));
  if (!pricing) return undefined;
  const peak = pricing.peak && deepSeekPeak(at);
  const rates = peak ? { ...pricing.rates, ...pricing.peak } : pricing.rates;
  return {
    key: pricing.key,
    label: pricing.label,
    pricingVersion: COMMANDCODE_PRICING_VERSION,
    pricingSource: COMMANDCODE_PRICING_SOURCE,
    priceBand: peak ? "peak" : "standard",
    rates: { ...rates },
    goatMonthlyAllowance: pricing.allowance,
    goatMultiplier: pricing.allowance > 0
      ? COMMANDCODE_GOAT_MONTHLY_CREDITS / pricing.allowance
      : 0,
  };
}

export function commandCodeBillingSnapshot({
  model,
  at = Date.now(),
  inputTokens,
  billedInputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  outputTokens,
  billedOutputTokens,
  estimatedInputTokens,
  retrospective = false,
} = {}) {
  const pricing = commandCodePricingForModel(model, at);
  if (!pricing) return undefined;
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
    usageValueUsd += (cached * pricing.rates.cacheRead) / MILLION;
  }
  if (output !== undefined) usageValueUsd += (output * pricing.rates.output) / MILLION;
  if (cacheWrite !== undefined && pricing.rates.cacheWrite !== undefined) {
    usageValueUsd += (cacheWrite * pricing.rates.cacheWrite) / MILLION;
  }
  const goatCredits = usageValueUsd * pricing.goatMultiplier;

  return {
    pricingVersion: pricing.pricingVersion,
    pricingSource: pricing.pricingSource,
    modelKey: pricing.key,
    modelLabel: pricing.label,
    priceBand: pricing.priceBand,
    rates: pricing.rates,
    goatMonthlyAllowance: pricing.goatMonthlyAllowance,
    goatMultiplier: pricing.goatMultiplier,
    usageValueUsd: roundedMoney(usageValueUsd),
    goatCredits: roundedMoney(goatCredits),
    complete: incompleteReasons.length === 0,
    ...(incompleteReasons.length ? { incompleteReasons } : {}),
    ...(retrospective ? { retrospective: true } : {}),
  };
}

export function sanitizeCommandCodeBilling(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usageValueUsd = finiteNonnegative(value.usageValueUsd);
  const goatCredits = finiteNonnegative(value.goatCredits);
  const allowance = finiteNonnegative(value.goatMonthlyAllowance);
  const multiplier = finiteNonnegative(value.goatMultiplier);
  if (usageValueUsd === undefined || goatCredits === undefined) return undefined;
  const rates = value.rates && typeof value.rates === "object"
    ? Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite"]
          .map((key) => [key, finiteNonnegative(value.rates[key])])
          .filter(([, number]) => number !== undefined),
      )
    : {};
  return {
    pricingVersion: String(value.pricingVersion || COMMANDCODE_PRICING_VERSION).slice(0, 80),
    pricingSource: String(value.pricingSource || COMMANDCODE_PRICING_SOURCE).slice(0, 200),
    modelKey: String(value.modelKey || "unknown").slice(0, 120),
    modelLabel: String(value.modelLabel || value.modelKey || "Unknown model").slice(0, 160),
    priceBand: value.priceBand === "peak" ? "peak" : "standard",
    rates,
    ...(allowance !== undefined ? { goatMonthlyAllowance: allowance } : {}),
    ...(multiplier !== undefined ? { goatMultiplier: multiplier } : {}),
    usageValueUsd: roundedMoney(usageValueUsd),
    goatCredits: roundedMoney(goatCredits),
    complete: value.complete === true,
    ...(Array.isArray(value.incompleteReasons)
      ? { incompleteReasons: value.incompleteReasons.map((reason) => String(reason).slice(0, 80)).slice(0, 4) }
      : {}),
    ...(value.retrospective === true ? { retrospective: true } : {}),
  };
}

export const COMMANDCODE_PLANS = [
  { name: "Go", monthlyCredits: 10, fiveHourCap: 3, weeklyCap: 6 },
  { name: "GOAT", monthlyCredits: 70, fiveHourCap: 14, weeklyCap: 35 },
  { name: "Pro", monthlyCredits: 80, fiveHourCap: 16, weeklyCap: 40 },
  { name: "Max 10×", monthlyCredits: 150, fiveHourCap: 45, weeklyCap: 90 },
  { name: "Max 20×", monthlyCredits: 300, fiveHourCap: 90, weeklyCap: 180 },
  { name: "Team Pro", monthlyCredits: 40, fiveHourCap: 12, weeklyCap: 24 },
];

export function commandCodePlanFromCreditsPayload(payload) {
  const fiveHour = finiteNonnegative(payload?.windowLimits?.fiveHour?.cap);
  const weekly = finiteNonnegative(payload?.windowLimits?.weekly?.cap);
  if (fiveHour === undefined || weekly === undefined) return undefined;
  return COMMANDCODE_PLANS.find(
    (plan) => plan.fiveHourCap === fiveHour && plan.weeklyCap === weekly,
  );
}

function emptySpendWindow(key, label, from, to) {
  return {
    key,
    label,
    from: Number.isFinite(from) ? new Date(from).toISOString() : null,
    to: new Date(to).toISOString(),
    usageValueUsd: 0,
    goatCredits: 0,
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
    usageValueUsd: 0,
    goatCredits: 0,
    requests: 0,
    pricedRequests: 0,
    incompleteRequests: 0,
    retrospectiveRequests: 0,
    unpricedRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    goatMonthlyAllowance: billing?.goatMonthlyAllowance,
    goatMultiplier: billing?.goatMultiplier,
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
    window.goatCredits += billing.goatCredits;
    model.usageValueUsd += billing.usageValueUsd;
    model.goatCredits += billing.goatCredits;
    model.goatMonthlyAllowance ??= billing.goatMonthlyAllowance;
    model.goatMultiplier ??= billing.goatMultiplier;
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
    goatCredits: billing?.goatCredits,
    complete: billing?.complete === true,
    retrospective: billing?.retrospective === true,
  };
}

function finalizedWindow(window) {
  return {
    ...window,
    usageValueUsd: roundedMoney(window.usageValueUsd),
    goatCredits: roundedMoney(window.goatCredits),
    models: [...window.models.values()]
      .map((model) => ({
        ...model,
        usageValueUsd: roundedMoney(model.usageValueUsd),
        goatCredits: roundedMoney(model.goatCredits),
        cacheHitPercent: model.inputTokens > 0
          ? Math.round((Math.min(model.cachedInputTokens, model.inputTokens) / model.inputTokens) * 10_000) / 100
          : null,
      }))
      .sort((left, right) => right.goatCredits - left.goatCredits || right.usageValueUsd - left.usageValueUsd || right.requests - left.requests),
  };
}

export function aggregateCommandCodeSpend(events, {
  now = Date.now(),
  fiveHourStart,
  weeklyStart,
} = {}) {
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
    if (normalizedId(event?.provider) !== "commandcode") continue;
    const at = Date.parse(event?.at);
    if (!Number.isFinite(at) || at > now) continue;
    observedFrom = Math.min(observedFrom, at);
    let billing = sanitizeCommandCodeBilling(event.commandCodeBilling);
    if (billing) {
      capturedFrom = Math.min(capturedFrom, at);
    } else if (at >= COMMANDCODE_RETROSPECTIVE_FROM) {
      billing = commandCodeBillingSnapshot({ ...event, at, retrospective: true });
    }
    recentRequests.push(recentSpendRequest(event, billing, at));
    for (const window of Object.values(windows)) {
      const from = window.from ? Date.parse(window.from) : Number.NEGATIVE_INFINITY;
      if (at >= from) addSpendEvent(window, event, billing);
    }
  }

  recentRequests.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));

  return {
    pricingVersion: COMMANDCODE_PRICING_VERSION,
    pricingSource: COMMANDCODE_PRICING_SOURCE,
    goatMonthlyCredits: COMMANDCODE_GOAT_MONTHLY_CREDITS,
    observedFrom: Number.isFinite(observedFrom) ? new Date(observedFrom).toISOString() : null,
    capturedFrom: Number.isFinite(capturedFrom) ? new Date(capturedFrom).toISOString() : null,
    recentRequests: recentRequests.slice(0, RECENT_REQUEST_LIMIT),
    windows: Object.fromEntries(
      Object.entries(windows).map(([key, window]) => [key, finalizedWindow(window)]),
    ),
  };
}
