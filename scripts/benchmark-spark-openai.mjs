import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const RUNTIME_ROOT = path.join(REPOSITORY_ROOT, "runtime-data");

export const VLLM_METRIC_NAMES = Object.freeze({
  queue: ["vllm:request_queue_time_seconds_bucket"],
  ttft: ["vllm:time_to_first_token_seconds_bucket"],
  prefill: ["vllm:request_prefill_time_seconds_bucket"],
  decode: ["vllm:request_decode_time_seconds_bucket"],
  kv: ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"],
  prefixHits: [
    "vllm:prefix_cache_hits_total",
    "vllm:gpu_prefix_cache_hits_total",
    "vllm:gpu_prefix_cache_hits",
  ],
  prefixQueries: [
    "vllm:prefix_cache_queries_total",
    "vllm:gpu_prefix_cache_queries_total",
    "vllm:gpu_prefix_cache_queries",
  ],
  specAccepted: [
    "vllm:spec_decode_num_accepted_tokens_total",
    "vllm:spec_decode_num_accepted_tokens",
  ],
  specDraft: [
    "vllm:spec_decode_num_draft_tokens_total",
    "vllm:spec_decode_num_draft_tokens",
  ],
  specDrafts: [
    "vllm:spec_decode_num_drafts_total",
    "vllm:spec_decode_num_drafts",
  ],
  specRate: ["vllm:spec_decode_draft_acceptance_rate"],
  specEfficiency: ["vllm:spec_decode_efficiency"],
});

export async function main(env = process.env) {
  const config = benchmarkConfig(env);
  const discovery = await discoverEndpoint(config.baseUrl);
  if (!discovery.models.includes(config.model)) {
    throw new Error("LOCAL_AI_MODEL is not present in the Spark /v1/models response.");
  }
  const compatibility = await probeCompatibility(config);
  const results = [];
  for (const concurrency of config.concurrencies) {
    results.push(await benchmark({ concurrency, requestCount: Math.max(4, concurrency * 2) }, config));
  }
  const contextWindowResults = [];
  for (const targetTokens of config.contextTokenTargets) {
    contextWindowResults.push(await benchmarkContextWindow(targetTokens, config));
  }
  const successful = results.filter((result) =>
    result.successCount === result.requestCount && result.errorCount === 0 && result.timeoutCount === 0);
  const maximumThroughput = Math.max(0, ...successful.map((result) => result.aggregateGenerationTokensPerSecond));
  const recommended = successful
    .filter((result) => result.aggregateGenerationTokensPerSecond >= maximumThroughput * 0.97)
    .sort((left, right) => left.concurrency - right.concurrency)[0] ?? null;
  const failedContextCases = contextWindowResults.filter((result) => !result.validation.passed);
  const report = {
    schemaVersion: "1.1",
    benchmarkType: "spark-openai-streaming-concurrency-and-context-validation",
    capturedAt: new Date().toISOString(),
    endpointOrigin: config.baseUrl,
    model: config.model,
    configuration: {
      concurrencies: config.concurrencies,
      contextTokenTargets: config.contextTokenTargets,
      timeoutMs: config.timeoutMs,
    },
    discovery,
    compatibility,
    totalRequests: results.reduce((sum, result) => sum + result.requestCount, 0) + contextWindowResults.length,
    totalSuccesses: results.reduce((sum, result) => sum + result.successCount, 0) +
      contextWindowResults.filter((result) => result.request.outcome === "completed").length,
    totalErrors: results.reduce((sum, result) => sum + result.errorCount, 0) +
      contextWindowResults.filter((result) => result.request.outcome === "error").length,
    recommendation: recommended ? {
      maxConcurrency: recommended.concurrency,
      rule: "lowest zero-error concurrency within 97% of maximum aggregate generation throughput",
    } : null,
    contextWindowValidation: {
      passed: failedContextCases.length === 0,
      failureCount: failedContextCases.length,
      cases: contextWindowResults,
    },
    results,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  await mkdir(path.dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, serialized, "utf8");
  process.stderr.write(`Spark benchmark report: ${config.outputPath}\n`);
  if (failedContextCases.length > 0) {
    process.stderr.write(`Spark long-context validation failed for ${failedContextCases.length} case(s).\n`);
  }
  return report;
}

export function benchmarkConfig(env) {
  return {
    baseUrl: requiredOrigin(env.LOCAL_AI_HUB_URL),
    model: requiredText(env.LOCAL_AI_MODEL, "LOCAL_AI_MODEL", 256),
    concurrencies: integerList(env.AI_BENCH_CONCURRENCIES ?? "1,2,4,8,16", "AI_BENCH_CONCURRENCIES", 1, 64),
    contextTokenTargets: integerList(env.AI_BENCH_CONTEXT_TOKENS ?? "4000,50000,100000", "AI_BENCH_CONTEXT_TOKENS", 2049, 1_000_000),
    timeoutMs: boundedInteger(env.AI_BENCH_TIMEOUT_MS ?? "120000", 1_000, 10 * 60_000, "AI_BENCH_TIMEOUT_MS"),
    outputPath: benchmarkOutputPath(env.AI_BENCH_OUTPUT, RUNTIME_ROOT),
  };
}

async function discoverEndpoint(baseUrl) {
  const health = await endpointStatus(baseUrl, "/health");
  const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}.`);
  const payload = await response.json();
  const models = Array.isArray(payload?.data) ? payload.data.map((entry) => entry?.id)
    .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 256) : [];
  if (models.length === 0 || models.length > 256 || new Set(models).size !== models.length) {
    throw new Error("Spark /v1/models returned no usable model IDs.");
  }
  return { health, models };
}

async function endpointStatus(baseUrl, pathname) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(3_000) });
    return { reachable: true, statusCode: response.status, ok: response.ok };
  } catch (error) {
    return { reachable: false, statusCode: null, ok: false, error: boundedError(error) };
  }
}

async function probeCompatibility(config) {
  return {
    jsonObject: await completionProbe(config, {
      messages: [
        { role: "system", content: "Return a JSON object only." },
        { role: "user", content: "Return exactly one field named status with value ok." },
      ],
      response_format: { type: "json_object" },
    }, (message) => {
      const value = JSON.parse(message.content);
      return value?.status === "ok";
    }),
    strictJsonSchema: await completionProbe(config, {
      messages: [
        { role: "system", content: "Return data matching the supplied JSON Schema." },
        { role: "user", content: "Report status ok." },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "spark_compatibility_probe",
          strict: true,
          schema: {
            type: "object",
            properties: { status: { type: "string", const: "ok" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
    }, (message) => {
      const value = JSON.parse(message.content);
      return value?.status === "ok" && Object.keys(value).length === 1;
    }),
    toolCalling: await completionProbe(config, {
      messages: [{ role: "user", content: "Call report_status with status ok." }],
      tools: [{
        type: "function",
        function: {
          name: "report_status",
          description: "Report the compatibility probe status.",
          parameters: {
            type: "object",
            properties: { status: { type: "string", const: "ok" } },
            required: ["status"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "report_status" } },
    }, (message) => {
      const call = message.tool_calls?.[0];
      if (call?.function?.name !== "report_status") return false;
      const value = JSON.parse(call.function.arguments);
      return value?.status === "ok";
    }),
    streaming: { supported: true, validatedBy: "concurrency matrix" },
  };
}

async function completionProbe({ baseUrl, model }, body, validate) {
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model, max_tokens: 64, temperature: 0, stream: false, ...body }),
    });
    if (!response.ok) return { supported: false, statusCode: response.status, error: `HTTP ${response.status}` };
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    return { supported: Boolean(message && validate(message)), statusCode: response.status, error: null };
  } catch (error) {
    return { supported: false, statusCode: null, error: boundedError(error) };
  }
}

async function benchmark({ concurrency, requestCount }, config) {
  const before = await scrapeMetrics(config.baseUrl);
  const samples = [];
  const snapshots = [];
  let active = true;
  const sampler = sampleMetrics(config.baseUrl, snapshots, () => active);
  const startedAt = performance.now();
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const requestIndex = nextIndex++;
      if (requestIndex >= requestCount) return;
      samples.push(await oneRequest(concurrency, requestIndex, config));
    }
  });
  await Promise.all(workers);
  const wallTimeMs = performance.now() - startedAt;
  active = false;
  await sampler;
  const after = await scrapeMetrics(config.baseUrl);
  const successes = samples.filter((sample) => sample.outcome === "completed");
  const errors = samples.filter((sample) => sample.outcome === "error");
  const timeouts = samples.filter((sample) => sample.outcome === "timeout");
  const promptTokens = sum(successes.map((sample) => sample.promptTokens ?? 0));
  const completionTokens = sum(successes.map((sample) => sample.completionTokens ?? 0));
  const vllmMetrics = collectVllmMetricEvidence(before, after, snapshots);
  return {
    concurrency, requestCount, successCount: successes.length, errorCount: errors.length,
    timeoutCount: timeouts.length, errorRate: ratio(errors.length, requestCount),
    timeoutRate: ratio(timeouts.length, requestCount), wallTimeMs: round(wallTimeMs),
    promptTokens, completionTokens, promptTokensPerSecond: rate(promptTokens, wallTimeMs),
    aggregateGenerationTokensPerSecond: rate(completionTokens, wallTimeMs),
    meanRequestGenerationTokensPerSecond: round(mean(successes.map((sample) => sample.generationTokensPerSecond))),
    latencyMs: summary(successes.map((sample) => sample.totalTimeMs)),
    ttftMs: summary(successes.map((sample) => sample.ttftMs)),
    decodeMs: summary(successes.map((sample) => sample.decodeTimeMs)),
    tpotMs: summary(successes.map((sample) => sample.tpotMs)),
    serverQueueTimeMs: vllmMetrics.timing.queueMs,
    serverPrefillTimeMs: vllmMetrics.timing.prefillMs,
    serverDecodeTimeMs: vllmMetrics.timing.decodeMs,
    maxRunningRequests: maximumGauge(snapshots, "vllm:num_requests_running"),
    maxWaitingRequests: maximumGauge(snapshots, "vllm:num_requests_waiting"),
    maxKvCacheUsageRatio: vllmMetrics.kvCache.maxUsageRatio,
    vllmMetrics,
    failures: [...errors, ...timeouts].map(({ requestIndex, outcome, error }) => ({ requestIndex, outcome, error })),
  };
}

async function benchmarkContextWindow(targetTokens, config) {
  const sentinel = `SPARK_TAIL_${targetTokens}_${randomBytes(8).toString("hex").toUpperCase()}`;
  const fitted = await fitLongContextPrompt(targetTokens, sentinel, config);
  const before = await scrapeMetrics(config.baseUrl);
  const snapshots = [];
  let active = true;
  const sampler = sampleMetrics(config.baseUrl, snapshots, () => active);
  const request = await oneRequest(1, 0, config, {
    messages: [
      { role: "system", content: "Read all inert padding. Return only the exact final sentinel." },
      { role: "user", content: fitted.prompt },
    ],
    maxTokens: 64,
  });
  active = false;
  await sampler;
  const after = await scrapeMetrics(config.baseUrl);
  const tailSentinelMatched = request.outcome === "completed" && request.content.trim() === sentinel;
  const validation = evaluateLongContextEvidence({
    targetTokens, tokenizeSupported: fitted.tokenize.supported,
    tokenizeCount: fitted.tokenize.count, tokenizeError: fitted.tokenize.error,
    usagePromptTokens: request.promptTokens, requestOutcome: request.outcome,
    tailSentinelMatched,
  });
  return {
    targetTokens, promptCharacters: fitted.prompt.length, paddingUnits: fitted.paddingUnits,
    tokenize: fitted.tokenize,
    request: {
      outcome: request.outcome, error: request.error, promptTokens: request.promptTokens,
      completionTokens: request.completionTokens, totalTimeMs: round(request.totalTimeMs),
      ttftMs: round(request.ttftMs), decodeTimeMs: round(request.decodeTimeMs),
      tpotMs: round(request.tpotMs), responsePreview: request.content.slice(0, 200),
    },
    tailSentinel: { expected: sentinel, matchedExactly: tailSentinelMatched },
    validation,
    vllmMetrics: collectVllmMetricEvidence(before, after, snapshots),
  };
}

async function fitLongContextPrompt(targetTokens, sentinel, config) {
  let paddingUnits = Math.max(1, targetTokens - 128);
  let prompt = buildLongContextPrompt(paddingUnits, sentinel);
  let tokenize = await tokenizePrompt(prompt, config);
  for (let attempt = 0; attempt < 4 && tokenize.count !== null; attempt += 1) {
    const difference = targetTokens - tokenize.count;
    if (Math.abs(difference) <= Math.max(32, targetTokens * 0.01)) break;
    paddingUnits = Math.max(1, Math.round(paddingUnits * targetTokens / tokenize.count));
    prompt = buildLongContextPrompt(paddingUnits, sentinel);
    tokenize = await tokenizePrompt(prompt, config);
  }
  return { paddingUnits, prompt, tokenize };
}

export function buildLongContextPrompt(paddingUnits, sentinel) {
  if (!Number.isSafeInteger(paddingUnits) || paddingUnits < 1) throw new Error("paddingUnits must be positive.");
  const checkedSentinel = requiredText(sentinel, "sentinel", 128);
  return [
    "Read through all inert padding below. The last non-empty line is a random sentinel.",
    "Return exactly that final sentinel and nothing else.",
    "BEGIN_INERT_PADDING", "oak ".repeat(paddingUnits).trimEnd(),
    "END_INERT_PADDING", checkedSentinel,
  ].join("\n");
}

async function tokenizePrompt(prompt, { baseUrl, model }) {
  try {
    const response = await fetch(`${baseUrl}/tokenize`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model, prompt }),
    });
    if (response.status === 404 || response.status === 405) {
      return { supported: false, statusCode: response.status, count: null, countSource: null, error: null };
    }
    if (!response.ok) return { supported: true, statusCode: response.status, count: null, countSource: null, error: `HTTP ${response.status}` };
    const parsed = parseTokenizePayload(await response.json());
    return { supported: true, statusCode: response.status, count: parsed?.count ?? null, countSource: parsed?.source ?? null, error: parsed ? null : "No token count in /tokenize response." };
  } catch (error) {
    return { supported: null, statusCode: null, count: null, countSource: null, error: boundedError(error) };
  }
}

export function parseTokenizePayload(payload) {
  if (Number.isSafeInteger(payload?.count) && payload.count >= 0) return { count: payload.count, source: "count" };
  if (Array.isArray(payload?.tokens)) return { count: payload.tokens.length, source: "tokens.length" };
  if (Array.isArray(payload?.token_ids)) return { count: payload.token_ids.length, source: "token_ids.length" };
  return null;
}

export function evaluateLongContextEvidence({ targetTokens, tokenizeSupported, tokenizeCount, tokenizeError, usagePromptTokens, requestOutcome, tailSentinelMatched }) {
  const failures = [];
  if (requestOutcome !== "completed") failures.push(`request-${requestOutcome}`);
  if (usagePromptTokens === null || usagePromptTokens === undefined) failures.push("server-prompt-usage-unavailable");
  else {
    if (targetTokens > 2048 && usagePromptTokens <= 2048) failures.push("server-prompt-usage-at-or-below-2048");
    if (tokenizeCount !== null && usagePromptTokens < Math.floor(tokenizeCount * 0.98)) failures.push("server-prompt-usage-below-tokenize-evidence");
    if (tokenizeCount === null && usagePromptTokens < Math.floor(targetTokens * 0.9)) failures.push("server-prompt-usage-below-90-percent-of-target");
  }
  if (tokenizeSupported === true && tokenizeCount === null) failures.push(`tokenize-endpoint-failed${tokenizeError ? `: ${tokenizeError}` : ""}`);
  if (tokenizeCount !== null) {
    if (targetTokens > 2048 && tokenizeCount <= 2048) failures.push("tokenize-count-at-or-below-2048");
    if (Math.abs(tokenizeCount - targetTokens) > Math.max(64, targetTokens * 0.05)) failures.push("tokenize-count-outside-five-percent-target-tolerance");
  }
  if (!tailSentinelMatched) failures.push("tail-sentinel-not-returned-exactly");
  return {
    passed: failures.length === 0, failures,
    truncationSuspected: failures.some((failure) => failure.includes("2048") || failure.includes("below-tokenize") || failure.includes("tail-sentinel")),
  };
}

async function oneRequest(concurrency, requestIndex, config, workload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("benchmark timeout")), config.timeoutMs);
  const startedAt = performance.now();
  let ttftMs = null;
  let content = "";
  let promptTokens = null;
  let completionTokens = null;
  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: config.model, messages: workload.messages ?? defaultMessages(concurrency, requestIndex), max_tokens: workload.maxTokens ?? 96, temperature: 0, stream: true, stream_options: { include_usage: true } }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        ({ content, promptTokens, completionTokens, ttftMs } = consumeSseEvent(event, { content, promptTokens, completionTokens, ttftMs, startedAt }));
      }
    }
    buffer += decoder.decode();
    for (const event of extractSseEvents(buffer, true).events) {
      ({ content, promptTokens, completionTokens, ttftMs } = consumeSseEvent(event, { content, promptTokens, completionTokens, ttftMs, startedAt }));
    }
    const totalTimeMs = performance.now() - startedAt;
    const measuredTtft = ttftMs ?? totalTimeMs;
    const decodeTimeMs = Math.max(0, totalTimeMs - measuredTtft);
    return { requestIndex, outcome: "completed", promptTokens, completionTokens, content, responseCharacters: content.length, totalTimeMs, ttftMs: measuredTtft, decodeTimeMs, tpotMs: completionTokens !== null && completionTokens > 1 ? decodeTimeMs / (completionTokens - 1) : 0, generationTokensPerSecond: completionTokens !== null && decodeTimeMs > 0 ? completionTokens / (decodeTimeMs / 1000) : 0, error: null };
  } catch (error) {
    return { requestIndex, outcome: controller.signal.aborted ? "timeout" : "error", promptTokens: null, completionTokens: null, content, totalTimeMs: performance.now() - startedAt, ttftMs: ttftMs ?? 0, decodeTimeMs: 0, tpotMs: 0, generationTokensPerSecond: 0, error: boundedError(error) };
  } finally {
    clearTimeout(timer);
  }
}

function defaultMessages(concurrency, requestIndex) {
  return [
    { role: "system", content: "Return one concise Minecraft high-level planning action. Do not output hidden reasoning." },
    { role: "user", content: `Benchmark case concurrency=${concurrency} request=${requestIndex}. A bot has full health and needs to gather wood. Give one high-level action.` },
  ];
}

function consumeSseEvent(event, state) {
  for (const payload of parseSseEvent(event)) {
    const delta = payload.choices?.[0]?.delta;
    if (state.ttftMs === null && deltaContainsToken(delta)) state.ttftMs = performance.now() - state.startedAt;
    if (typeof delta?.content === "string") state.content += delta.content;
    if (Number.isSafeInteger(payload.usage?.prompt_tokens)) state.promptTokens = payload.usage.prompt_tokens;
    if (Number.isSafeInteger(payload.usage?.completion_tokens)) state.completionTokens = payload.usage.completion_tokens;
  }
  return state;
}

function deltaContainsToken(delta) {
  return Boolean(delta && Object.values(delta).some((value) => (typeof value === "string" && value.length > 0) || (Array.isArray(value) && value.length > 0)));
}

export function extractSseEvents(buffer, flush = false) {
  const events = [];
  let remainder = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/u.exec(remainder);
    if (!match) break;
    events.push(remainder.slice(0, match.index));
    remainder = remainder.slice(match.index + match[0].length);
  }
  if (flush && remainder.trim()) { events.push(remainder); remainder = ""; }
  return { events, remainder };
}

export function parseSseEvent(event) {
  const payloads = [];
  for (const line of event.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    payloads.push(JSON.parse(data));
  }
  return payloads;
}

async function sampleMetrics(baseUrl, samples, isActive) {
  while (isActive()) {
    const metrics = await scrapeMetrics(baseUrl);
    if (metrics) samples.push(metrics);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function scrapeMetrics(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/metrics`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? parsePrometheus(await response.text()) : null;
  } catch { return null; }
}

export function parsePrometheus(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(?<name>[A-Za-z_:][A-Za-z0-9_:]*)(?:\{(?<labels>.*)\})?\s+(?<value>[-+0-9.eE]+)$/u.exec(line);
    if (!match?.groups) continue;
    const value = Number(match.groups.value);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    for (const label of match.groups.labels?.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"])*)"/gu) ?? []) labels[label[1]] = label[2].replace(/\\n/gu, "\n").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    samples.push({ name: match.groups.name, labels, value });
  }
  return samples;
}

export function collectVllmMetricEvidence(before, after, snapshots = []) {
  const prefixHits = counterDeltaAny(before, after, VLLM_METRIC_NAMES.prefixHits);
  const prefixQueries = counterDeltaAny(before, after, VLLM_METRIC_NAMES.prefixQueries);
  const accepted = counterDeltaAny(before, after, VLLM_METRIC_NAMES.specAccepted);
  const draft = counterDeltaAny(before, after, VLLM_METRIC_NAMES.specDraft);
  const drafts = counterDeltaAny(before, after, VLLM_METRIC_NAMES.specDrafts);
  const rateGauge = latestGaugeAny([...snapshots, after].filter(Boolean), VLLM_METRIC_NAMES.specRate);
  const efficiency = latestGaugeAny([...snapshots, after].filter(Boolean), VLLM_METRIC_NAMES.specEfficiency);
  const kv = maximumGaugeEvidence(snapshots, VLLM_METRIC_NAMES.kv);
  return {
    timing: {
      queueMs: histogramSummaryAny(before, after, VLLM_METRIC_NAMES.queue),
      ttftMs: histogramSummaryAny(before, after, VLLM_METRIC_NAMES.ttft),
      prefillMs: histogramSummaryAny(before, after, VLLM_METRIC_NAMES.prefill),
      decodeMs: histogramSummaryAny(before, after, VLLM_METRIC_NAMES.decode),
    },
    kvCache: { maxUsageRatio: kv?.value ?? null, metric: kv?.name ?? null },
    prefixCache: {
      hits: prefixHits?.value ?? null, queries: prefixQueries?.value ?? null,
      hitRate: prefixHits && prefixQueries && prefixQueries.value > 0 ? ratio(prefixHits.value, prefixQueries.value) : null,
      hitMetric: prefixHits?.name ?? null, queryMetric: prefixQueries?.name ?? null,
    },
    speculativeDecoding: {
      acceptedTokens: accepted?.value ?? null, draftTokens: draft?.value ?? null,
      tokenAcceptanceRate: accepted && draft && draft.value > 0 ? ratio(accepted.value, draft.value) : rateGauge?.value ?? null,
      acceptedTokensPerDraft: accepted && drafts && drafts.value > 0 ? round(accepted.value / drafts.value) : null,
      draftCount: drafts?.value ?? null, efficiency: efficiency?.value ?? null,
      acceptedTokenMetric: accepted?.name ?? null, draftTokenMetric: draft?.name ?? null,
      draftCountMetric: drafts?.name ?? null, acceptanceRateMetric: rateGauge?.name ?? null,
      efficiencyMetric: efficiency?.name ?? null,
    },
  };
}

function counterDeltaAny(before, after, names) {
  for (const name of names) {
    const value = counterDeltaForName(before, after, name);
    if (value !== null) return { name, value };
  }
  return null;
}

function counterDeltaForName(before, after, name) {
  if (!before || !after) return null;
  const prior = before.filter((entry) => entry.name === name);
  const current = after.filter((entry) => entry.name === name);
  if (prior.length === 0 && current.length === 0) return null;
  const value = sum(current.map((entry) => entry.value)) - sum(prior.map((entry) => entry.value));
  return value >= 0 ? value : null;
}

function latestGaugeAny(snapshots, names) {
  for (const name of names) {
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      const values = snapshots[index].filter((entry) => entry.name === name).map((entry) => entry.value);
      if (values.length > 0) return { name, value: Math.max(...values) };
    }
  }
  return null;
}

function maximumGaugeEvidence(snapshots, names) {
  for (const name of names) {
    const value = maximumGauge(snapshots, name);
    if (value !== null) return { name, value };
  }
  return null;
}

function histogramSummaryAny(before, after, names) {
  for (const name of names) {
    const buckets = histogramDelta(before, after, name);
    if (!buckets) continue;
    const base = name.endsWith("_bucket") ? name.slice(0, -7) : name;
    const sumDelta = counterDeltaForName(before, after, `${base}_sum`);
    const countDelta = counterDeltaForName(before, after, `${base}_count`);
    return { mean: sumDelta !== null && countDelta > 0 ? round(sumDelta / countDelta * 1000) : null, p50: milliseconds(queueHistogramQuantile(buckets, 0.5)), p95: milliseconds(queueHistogramQuantile(buckets, 0.95)), metric: name, source: "vLLM Prometheus histogram delta" };
  }
  return { mean: null, p50: null, p95: null, metric: null, source: "unavailable" };
}

export function histogramDelta(before, after, name) {
  if (!before || !after) return null;
  const totals = new Map();
  for (const sample of after.filter((entry) => entry.name === name)) totals.set(sample.labels.le, (totals.get(sample.labels.le) ?? 0) + sample.value);
  for (const sample of before.filter((entry) => entry.name === name)) totals.set(sample.labels.le, (totals.get(sample.labels.le) ?? 0) - sample.value);
  const buckets = [...totals.entries()].map(([le, count]) => ({ le: le === "+Inf" ? Infinity : Number(le), count })).filter(({ le, count }) => !Number.isNaN(le) && count >= 0).sort((left, right) => left.le - right.le);
  return buckets.length > 0 ? buckets : null;
}

export function queueHistogramQuantile(buckets, quantile) {
  const total = buckets.at(-1)?.count ?? 0;
  if (total <= 0) return 0;
  return buckets.find(({ count }) => count >= total * quantile)?.le ?? Infinity;
}

function maximumGauge(samples, name) {
  const values = samples.flatMap((snapshot) => snapshot.filter((entry) => entry.name === name).map((entry) => entry.value));
  return values.length > 0 ? Math.max(...values) : null;
}

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return { mean: sorted.length > 0 ? round(mean(sorted)) : null, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

export function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function mean(values) { return values.length > 0 ? sum(values) / values.length : 0; }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function rate(tokens, milliseconds) { return milliseconds > 0 ? round(tokens / (milliseconds / 1000)) : 0; }
function ratio(value, total) { return total > 0 ? round(value / total) : 0; }
function milliseconds(seconds) { return Number.isFinite(seconds) ? round(seconds * 1000) : null; }
function round(value) { return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null; }
function boundedError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/gu, " ").slice(0, 300); }
function requiredOrigin(raw) {
  const value = requiredText(raw, "LOCAL_AI_HUB_URL", 2048);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("LOCAL_AI_HUB_URL must be an explicit HTTP(S) origin.");
  return url.origin;
}
function requiredText(raw, name, maxLength) { const value = raw?.trim(); if (!value || value.length > maxLength) throw new Error(`${name} is required.`); return value; }
function integerList(raw, name, minimum, maximum) {
  const values = raw.split(",").map((value) => boundedInteger(value.trim(), minimum, maximum, name));
  if (values.length < 1 || values.length > 16 || new Set(values).size !== values.length) throw new Error(`${name} is invalid.`);
  return values;
}
function benchmarkOutputPath(raw, runtimeDirectory) {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const resolved = path.resolve(raw?.trim() || path.join(runtimeDirectory, `spark-benchmark-${stamp}.json`));
  const relative = path.relative(runtimeDirectory, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("AI_BENCH_OUTPUT must be a file inside runtime-data.");
  return resolved;
}
function boundedInteger(raw, minimum, maximum, name) { const value = Number(raw); if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is outside the allowed range.`); return value; }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  main().then((report) => { if (!report.contextWindowValidation.passed) process.exitCode = 1; }).catch((error) => { process.stderr.write(`${boundedError(error)}\n`); process.exitCode = 1; });
}
