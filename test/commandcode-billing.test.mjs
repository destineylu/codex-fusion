import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateCommandCodeSpend,
  commandCodeBillingSnapshot,
  commandCodePlanFromCreditsPayload,
  commandCodePricingForModel,
} from "../src/commandcode-billing.mjs";

test("Muse Spark Contributor cost separates fresh input from cache reads", () => {
  const billing = commandCodeBillingSnapshot({
    model: "commandcode/meta/muse-spark-1.3-contributor",
    at: Date.parse("2026-09-06T12:00:00Z"),
    inputTokens: 50_800,
    cachedInputTokens: 50_000,
    outputTokens: 180,
  });

  assert.equal(billing.complete, true);
  assert.equal(billing.usageValueUsd, 0.000216);
  assert.equal(billing.goatCredits, 0.000756);
  assert.equal(billing.goatMonthlyAllowance, 20);
  assert.equal(billing.goatMultiplier, 3.5);
});

test("DeepSeek V4 Flash uses the published UTC peak price band", () => {
  const standard = commandCodePricingForModel("commandcode/deepseek-v4-flash", Date.parse("2026-09-06T05:00:00Z"));
  const peak = commandCodePricingForModel("commandcode/deepseek-v4-flash", Date.parse("2026-09-06T08:00:00Z"));

  assert.equal(standard.priceBand, "standard");
  assert.deepEqual(standard.rates, { input: 0.22, output: 0.66, cacheRead: 0.007 });
  assert.equal(peak.priceBand, "peak");
  assert.deepEqual(peak.rates, { input: 0.44, output: 1.32, cacheRead: 0.01 });

  const billing = commandCodeBillingSnapshot({
    model: "commandcode/deepseek-v4-flash",
    at: Date.parse("2026-09-06T08:00:00Z"),
    inputTokens: 1_000,
    cachedInputTokens: 500,
    outputTokens: 100,
  });
  assert.equal(billing.usageValueUsd, 0.000357);
  assert.ok(Math.abs(billing.goatCredits - 0.0004165) < 1e-12);
});

test("missing exact prompt usage stays a known minimum instead of pricing an estimate as fact", () => {
  const billing = commandCodeBillingSnapshot({
    model: "commandcode/deepseek-v4-flash",
    at: Date.parse("2026-09-06T08:00:00Z"),
    inputTokens: 0,
    outputTokens: 100,
    estimatedInputTokens: 400_000,
  });

  assert.equal(billing.complete, false);
  assert.deepEqual(billing.incompleteReasons, ["input-usage-unavailable"]);
  assert.equal(billing.usageValueUsd, 0.000132);
});

test("unknown Command Code models are left unpriced rather than guessed", () => {
  assert.equal(commandCodePricingForModel("commandcode/future-model"), undefined);
  assert.equal(commandCodeBillingSnapshot({ model: "commandcode/future-model", inputTokens: 1 }), undefined);
});

test("Command Code plan is inferred from provider-reported rolling caps", () => {
  assert.deepEqual(commandCodePlanFromCreditsPayload({
    windowLimits: {
      fiveHour: { cap: 14 },
      weekly: { cap: 35 },
    },
  }), { name: "GOAT", monthlyCredits: 70, fiveHourCap: 14, weeklyCap: 35 });
});

test("spend aggregation keeps per-model attribution and marks reconstructed rows", () => {
  const now = Date.parse("2026-09-06T18:00:00Z");
  const exact = commandCodeBillingSnapshot({
    model: "commandcode/meta/muse-spark-1.3-contributor",
    at: Date.parse("2026-09-06T17:00:00Z"),
    inputTokens: 1_000,
    cachedInputTokens: 800,
    outputTokens: 200,
  });
  const result = aggregateCommandCodeSpend([
    {
      at: "2026-09-06T17:00:00Z",
      provider: "commandcode",
      model: "commandcode/meta/muse-spark-1.3-contributor",
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 200,
      commandCodeBilling: exact,
    },
    {
      at: "2026-09-06T16:00:00Z",
      provider: "commandcode",
      model: "commandcode/meta/muse-spark-1.3-contributor",
      inputTokens: 500,
      cachedInputTokens: 400,
      outputTokens: 100,
    },
    {
      at: "2026-09-06T15:00:00Z",
      provider: "commandcode",
      model: "commandcode/not-priced",
      inputTokens: 500,
      outputTokens: 100,
    },
  ], { now });

  const weekly = result.windows.weekly;
  assert.equal(weekly.requests, 3);
  assert.equal(weekly.pricedRequests, 2);
  assert.equal(weekly.retrospectiveRequests, 1);
  assert.equal(weekly.unpricedRequests, 1);
  assert.equal(weekly.models.length, 2);
  const muse = weekly.models.find((model) => model.slug.includes("muse-spark"));
  assert.equal(muse.requests, 2);
  assert.equal(muse.pricedRequests, 2);
  assert.equal(muse.retrospectiveRequests, 1);
  assert.equal(muse.cacheHitPercent, 80);
  assert.equal(result.recentRequests.length, 3);
  assert.equal(result.recentRequests[0].displayName, "Muse Spark 1.3 Contributor");
  assert.equal(result.recentRequests[0].at, "2026-09-06T17:00:00.000Z");
  assert.equal(result.recentRequests[0].complete, true);
  assert.equal(result.recentRequests[1].retrospective, true);
  assert.equal(result.recentRequests[2].usageValueUsd, undefined);
});

test("recent Command Code requests are capped and newest-first", () => {
  const now = Date.parse("2026-09-06T18:00:00Z");
  const events = Array.from({ length: 25 }, (_, index) => ({
    at: new Date(now - index * 1_000).toISOString(),
    provider: "commandcode",
    model: "commandcode/meta/muse-spark-1.3-contributor",
    status: 200,
    inputTokens: 0,
    outputTokens: index + 1,
    estimatedInputTokens: 100_000,
  }));
  const result = aggregateCommandCodeSpend(events, { now });
  assert.equal(result.recentRequests.length, 20);
  assert.equal(result.recentRequests[0].outputTokens, 1);
  assert.equal(result.recentRequests.at(-1).outputTokens, 20);
  assert.equal(result.recentRequests[0].complete, false);
});
