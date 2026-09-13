// Provider/model-specific request-body limits that have been measured live.
//
// Keep these exact-route scoped. A reseller can expose several models behind
// the same API surface, and a limit observed on one route is not evidence for
// every sibling model. The value is deliberately lower than the first measured
// failure boundary so ordinary JSON-shape variation does not sit on the edge.

const LIMITS = new Map([
  [
    "xkiro\0anthropic/claude-opus-5",
    {
      maxBytes: 1_150_000,
      // 230K was too close to the byte ceiling: on 2026-09-08 a turn with
      // 222,739 input tokens produced 13,837 output tokens, so the next request
      // jumped over the serialized-body limit before Codex had another usage
      // sample that could trigger compaction. Keep enough headroom for a large
      // single response while leaving the advertised 1M context unchanged.
      autoCompact: 200_000,
      reason: "Xkiro Opus 5 fails around a 1.19 MB serialized request body on both Chat Completions and Anthropic Messages",
    },
  ],
]);

export function providerPayloadLimit(model, provider) {
  const providerId = provider?.id || model?.provider;
  const upstreamModel = model?.upstreamModel;
  if (!providerId || !upstreamModel) return undefined;
  return LIMITS.get(`${providerId}\0${upstreamModel}`);
}

export function providerAutoCompactLimit(model, provider) {
  return providerPayloadLimit(model, provider)?.autoCompact;
}

export function payloadLimitExceeded(body, model, provider) {
  const limit = providerPayloadLimit(model, provider);
  if (!limit) return undefined;
  const bytes = Buffer.isBuffer(body)
    ? body.byteLength
    : Buffer.byteLength(String(body ?? ""), "utf8");
  return bytes > limit.maxBytes ? { ...limit, bytes } : undefined;
}

export function payloadLimitContextError(limit) {
  if (!limit) return undefined;
  return {
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      param: "input",
      message:
        `context_length_exceeded: the serialized request is ${limit.bytes.toLocaleString("en-US")} bytes, above the ` +
        `${limit.maxBytes.toLocaleString("en-US")}-byte safe limit measured for this provider route. ` +
        "Compact the conversation or remove large earlier tool/file output before retrying.",
    },
  };
}
