import { contextEconomyEnabled } from "./context-economy-state.mjs";

const K = 1_000;

// Working budgets do not change the model's advertised contextWindow; they
// only tell Codex when to checkpoint a long coding thread. Most entries remain
// exact-route scoped. Xkiro Opus 5 is the narrow exception: multiple Xkiro
// accounts share the same measured provider behavior, while their credentials
// and usage attribution remain independent.
const XKIRO_OPUS_POLICY = Object.freeze({ autoCompact: 160 * K });
const POLICIES = new Map([
  ["commandcode-messages/claude-opus-5", { autoCompact: 160 * K }],
  ["commandcode-messages/claude-opus-4.8", { autoCompact: 160 * K }],
  ["commandcode/deepseek-v4-flash", { autoCompact: 160 * K }],
  ["commandcode/deepseek-v4-pro", { autoCompact: 160 * K }],
  ["commandcode/meta/muse-spark-1.3", { autoCompact: 180 * K }],
  ["commandcode/meta/muse-spark-1.3-contributor", { autoCompact: 180 * K }],
]);

export const CONTEXT_ECONOMY_SOFT_LIMIT = 100 * K;
export const CONTEXT_ECONOMY_AGING_MIN_BYTES = 16 * 1024;
export const CONTEXT_ECONOMY_AGING_FRONTIER = 2;

export function contextEconomyPolicy(
  model,
  { enabled = contextEconomyEnabled(), provider } = {},
) {
  if (!enabled || !model || typeof model.slug !== "string") return undefined;
  const xkiroOpus =
    provider?.ownedBy === "xkiro" &&
    model.upstreamModel === "anthropic/claude-opus-5";
  const base = xkiroOpus ? XKIRO_OPUS_POLICY : POLICIES.get(model.slug);
  if (!base) return undefined;
  const current = Number(model.autoCompact);
  const autoCompact =
    Number.isFinite(current) && current > 0
      ? Math.min(current, base.autoCompact)
      : base.autoCompact;
  const pressureRatio = Math.min(0.7, CONTEXT_ECONOMY_SOFT_LIMIT / autoCompact);
  return Object.freeze({
    ...base,
    autoCompact,
    softLimit: Math.min(CONTEXT_ECONOMY_SOFT_LIMIT, autoCompact),
    pressureRatio,
    agingMinBytes: CONTEXT_ECONOMY_AGING_MIN_BYTES,
    agingFrontier: CONTEXT_ECONOMY_AGING_FRONTIER,
    leanDeferredAppTools: true,
  });
}

export function contextEconomyAutoCompactLimit(model, options) {
  return contextEconomyPolicy(model, options)?.autoCompact;
}

export function contextEconomyPolicies() {
  return [
    { slug: "xkiro-family/anthropic/claude-opus-5", ...XKIRO_OPUS_POLICY },
    ...[...POLICIES.entries()].map(([slug, policy]) => ({ slug, ...policy })),
  ];
}
