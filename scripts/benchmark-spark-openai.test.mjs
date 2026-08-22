import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkConfig,
  buildLongContextPrompt,
  collectVllmMetricEvidence,
  evaluateLongContextEvidence,
  extractSseEvents,
  parsePrometheus,
  parseSseEvent,
  parseTokenizePayload,
} from "./benchmark-spark-openai.mjs";

test("Spark benchmark defaults cover the required context and concurrency matrix", () => {
  const config = benchmarkConfig({
    LOCAL_AI_HUB_URL: "http://127.0.0.1:8000",
    LOCAL_AI_MODEL: "test-model",
  });

  assert.deepEqual(config.contextTokenTargets, [4_000, 50_000, 100_000]);
  assert.deepEqual(config.concurrencies, [1, 2, 4, 8, 16]);
});

test("long-context prompt terminates in a deterministic tail sentinel", () => {
  const sentinel = "SPARK_TAIL_4000_ABC123";
  const prompt = buildLongContextPrompt(8, sentinel);

  assert.equal(prompt.endsWith(`\n${sentinel}`), true);
  assert.equal(prompt.includes("oak oak oak"), true);
});

test("tokenize response supports vLLM count and token arrays", () => {
  assert.deepEqual(parseTokenizePayload({ count: 4_000 }), {
    count: 4_000,
    source: "count",
  });
  assert.deepEqual(parseTokenizePayload({ tokens: [1, 2, 3] }), {
    count: 3,
    source: "tokens.length",
  });
  assert.equal(parseTokenizePayload({}), null);
});

test("long-context validation fails visibly for a 2048-token truncation", () => {
  const result = evaluateLongContextEvidence({
    targetTokens: 50_000,
    tokenizeSupported: true,
    tokenizeCount: 50_003,
    tokenizeError: null,
    usagePromptTokens: 2_048,
    requestOutcome: "completed",
    tailSentinelMatched: false,
  });

  assert.equal(result.passed, false);
  assert.equal(result.truncationSuspected, true);
  assert.equal(result.failures.includes("server-prompt-usage-at-or-below-2048"), true);
  assert.equal(result.failures.includes("server-prompt-usage-below-tokenize-evidence"), true);
});

test("long-context validation accepts consistent server usage and sentinel evidence", () => {
  const result = evaluateLongContextEvidence({
    targetTokens: 4_000,
    tokenizeSupported: true,
    tokenizeCount: 4_002,
    tokenizeError: null,
    usagePromptTokens: 4_030,
    requestOutcome: "completed",
    tailSentinelMatched: true,
  });

  assert.deepEqual(result, {
    passed: true,
    failures: [],
    truncationSuspected: false,
  });
});

test("SSE parsing retains partial frames and ignores done events", () => {
  const partial = extractSseEvents('data: {"choices":[{"delta":{"content":"ok"}}]}\n\npartial');
  assert.equal(partial.events.length, 1);
  assert.equal(partial.remainder, "partial");
  assert.equal(parseSseEvent(partial.events[0])[0].choices[0].delta.content, "ok");
  assert.deepEqual(parseSseEvent("data: [DONE]"), []);
});

test("vLLM metric evidence calculates cache, prefix, and speculative deltas", () => {
  const before = parsePrometheus(`
vllm:prefix_cache_hits_total 10
vllm:prefix_cache_queries_total 20
vllm:spec_decode_num_accepted_tokens_total 30
vllm:spec_decode_num_draft_tokens_total 40
vllm:spec_decode_num_drafts_total 10
vllm:request_prefill_time_seconds_bucket{le="1"} 1
vllm:request_prefill_time_seconds_bucket{le="+Inf"} 1
vllm:request_prefill_time_seconds_sum 0.5
vllm:request_prefill_time_seconds_count 1
`);
  const after = parsePrometheus(`
vllm:prefix_cache_hits_total 16
vllm:prefix_cache_queries_total 28
vllm:spec_decode_num_accepted_tokens_total 42
vllm:spec_decode_num_draft_tokens_total 60
vllm:spec_decode_num_drafts_total 14
vllm:request_prefill_time_seconds_bucket{le="1"} 3
vllm:request_prefill_time_seconds_bucket{le="+Inf"} 3
vllm:request_prefill_time_seconds_sum 1.5
vllm:request_prefill_time_seconds_count 3
`);
  const snapshots = [parsePrometheus("vllm:gpu_cache_usage_perc 0.75")];
  const evidence = collectVllmMetricEvidence(before, after, snapshots);

  assert.equal(evidence.kvCache.maxUsageRatio, 0.75);
  assert.equal(evidence.prefixCache.hits, 6);
  assert.equal(evidence.prefixCache.queries, 8);
  assert.equal(evidence.prefixCache.hitRate, 0.75);
  assert.equal(evidence.speculativeDecoding.acceptedTokens, 12);
  assert.equal(evidence.speculativeDecoding.draftTokens, 20);
  assert.equal(evidence.speculativeDecoding.tokenAcceptanceRate, 0.6);
  assert.equal(evidence.speculativeDecoding.acceptedTokensPerDraft, 3);
  assert.equal(evidence.timing.prefillMs.mean, 500);
  assert.equal(evidence.timing.prefillMs.p95, 1_000);
});

test("unsupported vLLM metrics remain explicit nulls", () => {
  const evidence = collectVllmMetricEvidence([], [], []);

  assert.equal(evidence.kvCache.maxUsageRatio, null);
  assert.equal(evidence.prefixCache.hitRate, null);
  assert.equal(evidence.speculativeDecoding.tokenAcceptanceRate, null);
  assert.equal(evidence.timing.decodeMs.metric, null);
});
