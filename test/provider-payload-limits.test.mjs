import assert from "node:assert/strict";
import test from "node:test";

import {
  payloadLimitContextError,
  payloadLimitExceeded,
  providerAutoCompactLimit,
  providerPayloadLimit,
} from "../src/provider-payload-limits.mjs";

const XKIRO = { id: "xkiro" };
const OPUS5 = {
  provider: "xkiro",
  upstreamModel: "anthropic/claude-opus-5",
};

test("Xkiro Opus 5 keeps its measured payload and compact safety limits exact-route scoped", () => {
  const limit = providerPayloadLimit(OPUS5, XKIRO);
  assert.equal(limit.maxBytes, 1_150_000);
  assert.equal(providerAutoCompactLimit(OPUS5, XKIRO), 230_000);

  assert.equal(
    payloadLimitExceeded(Buffer.alloc(1_150_000), OPUS5, XKIRO),
    undefined,
  );
  const exceeded = payloadLimitExceeded(Buffer.alloc(1_150_001), OPUS5, XKIRO);
  assert.deepEqual(exceeded, { ...limit, bytes: 1_150_001 });
  const contextError = payloadLimitContextError(exceeded);
  assert.equal(contextError.error.type, "invalid_request_error");
  assert.equal(contextError.error.code, "context_length_exceeded");
  assert.equal(contextError.error.param, "input");
  assert.match(contextError.error.message, /^context_length_exceeded:/);

  assert.equal(
    providerPayloadLimit(
      { provider: "xkiro", upstreamModel: "anthropic/claude-sonnet-5" },
      XKIRO,
    ),
    undefined,
  );
  assert.equal(
    providerPayloadLimit(OPUS5, { id: "commandcode" }),
    undefined,
  );
});
