import assert from "node:assert/strict";
import test from "node:test";

import {
  XKIRO_PRICING_VERSION,
  aggregateXkiroSpend,
  sanitizeXkiroBilling,
  xkiroBillingSnapshot,
  xkiroPricingForModel,
} from "../src/xkiro-billing.mjs";

test("Xkiro pricing snapshots split fresh input, cache reads, cache writes, and output", () => {
  const pricing = xkiroPricingForModel("xkiro2/anthropic/claude-fable-5-1");
  assert.equal(pricing.pricingVersion, XKIRO_PRICING_VERSION);
  assert.deepEqual(pricing.rates, {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 20,
  });

  const incomplete = xkiroBillingSnapshot({
    model: "xkiro2/anthropic/claude-fable-5-1",
    inputTokens: 200_000,
    cachedInputTokens: 190_000,
    outputTokens: 1_000,
  });
  assert.equal(incomplete.usageValueUsd, 0.1975);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.incompleteReasons, ["cache-write-usage-unavailable"]);

  const complete = xkiroBillingSnapshot({
    model: "xkiro2/anthropic/claude-fable-5-1",
    inputTokens: 200_000,
    cachedInputTokens: 190_000,
    cacheWriteInputTokens: 5_000,
    outputTokens: 1_000,
  });
  assert.equal(complete.usageValueUsd, 0.2975);
  assert.equal(complete.complete, true);

  const rejected = xkiroBillingSnapshot({
    model: "xkiro2/anthropic/claude-fable-5-1",
    status: 429,
    inputTokens: 200_000,
    cachedInputTokens: 190_000,
    outputTokens: 1_000,
  });
  assert.equal(rejected.usageValueUsd, 0);
  assert.equal(rejected.complete, true);
  assert.equal(rejected.chargeable, false);
});

test("Xkiro billing sanitizer never carries arbitrary fields", () => {
  const sanitized = sanitizeXkiroBilling({
    pricingVersion: "v",
    pricingSource: "https://example.test",
    modelId: "openai/gpt-5.6-sol",
    modelLabel: "GPT-5.6 Sol",
    accessTier: "paid",
    rates: { input: 4.5, output: 27, cacheRead: 0.45, secret: 99 },
    usageValueUsd: 1.25,
    complete: true,
    apiKey: "must-not-survive",
  });
  assert.deepEqual(sanitized.rates, { input: 4.5, output: 27, cacheRead: 0.45 });
  assert.equal("apiKey" in sanitized, false);
});

test("Xkiro spend stays isolated by account and never invents historical dollars", () => {
  const now = Date.parse("2026-09-14T18:00:00Z");
  const firstBilling = xkiroBillingSnapshot({
    model: "xkiro/openai/gpt-5.6-sol",
    inputTokens: 100_000,
    cachedInputTokens: 90_000,
    outputTokens: 1_000,
  });
  const events = [
    {
      at: "2026-09-14T17:00:00Z",
      provider: "xkiro",
      model: "xkiro/openai/gpt-5.6-sol",
      status: 200,
      inputTokens: 100_000,
      cachedInputTokens: 90_000,
      outputTokens: 1_000,
      xkiroBilling: firstBilling,
    },
    {
      at: "2026-09-14T17:10:00Z",
      provider: "xkiro2",
      model: "xkiro2/anthropic/claude-fable-5-1",
      status: 200,
      inputTokens: 200_000,
      cachedInputTokens: 190_000,
      outputTokens: 1_000,
    },
  ];

  const first = aggregateXkiroSpend(events, { providerId: "xkiro", now });
  const second = aggregateXkiroSpend(events, { providerId: "xkiro2", now });

  assert.equal(first.windows.all.requests, 1);
  assert.equal(second.windows.all.requests, 1);
  assert.equal(first.windows.all.models[0].slug, "xkiro/openai/gpt-5.6-sol");
  assert.equal(second.windows.all.models[0].slug, "xkiro2/anthropic/claude-fable-5-1");
  assert.equal(first.windows.all.pricedRequests, 1);
  assert.equal(second.windows.all.pricedRequests, 0);
  assert.ok(first.windows.all.usageValueUsd > 0);
  assert.equal(second.windows.all.usageValueUsd, 0);
  assert.equal(second.windows.all.models[0].unpricedRequests, 1);
});
