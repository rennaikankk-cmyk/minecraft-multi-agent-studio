import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const baseUrl = requiredOrigin(process.env.LOCAL_AI_HUB_URL);
const model = requiredText(process.env.LOCAL_AI_MODEL, "LOCAL_AI_MODEL", 256);
const concurrencies = integerList(
  process.env.AI_BENCH_CONCURRENCIES ?? "1,2,4,8,10",
);
const timeoutMs = boundedInteger(
  process.env.AI_BENCH_TIMEOUT_MS ?? "120000",
  1_000,
  10 * 60_000,
  "AI_BENCH_TIMEOUT_MS",
);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.join(repositoryRoot, "runtime-data");
const outputPath = benchmarkOutputPath(
  process.env.AI_BENCH_OUTPUT,
  runtimeRoot,
);

const discovery = await discoverEndpoint();
if (!discovery.models.includes(model)) {
  throw new Error("LOCAL_AI_MODEL is not present in the Spark /v1/models response.");
}
const compatibility = await probeCompatibility();

const cases = concurrencies.map((concurrency) => ({
  concurrency,
  requestCount: Math.max(4, concurrency * 2),
}));
const results = [];

for (const benchmarkCase of cases) {
  results.push(await benchmark(benchmarkCase));
}

const successful = results.filter(
  (result) =>
    result.successCount === result.requestCount &&
    result.errorCount === 0 &&
    result.timeoutCount === 0,
);
const maximumThroughput = Math.max(
  0,
  ...successful.map(({ aggregateGenerationTokensPerSecond }) =>
    aggregateGenerationTokensPerSecond),
);
const recommended = successful
  .filter(
    ({ aggregateGenerationTokensPerSecond }) =>
      aggregateGenerationTokensPerSecond >= maximumThroughput * 0.97,
  )
  .sort((left, right) => left.concurrency - right.concurrency)[0] ?? null;

const report = {
  schemaVersion: "1.0",
  benchmarkType: "spark-openai-streaming-concurrency-matrix",
  capturedAt: new Date().toISOString(),
  endpointOrigin: baseUrl,
  model,
  discovery,
  compatibility,
  totalRequests: results.reduce((sum, result) => sum + result.requestCount, 0),
  totalSuccesses: results.reduce((sum, result) => sum + result.successCount, 0),
  totalErrors: results.reduce((sum, result) => sum + result.errorCount, 0),
  recommendation: recommended
    ? {
        maxConcurrency: recommended.concurrency,
        rule: "lowest zero-error concurrency within 97% of maximum aggregate generation throughput",
      }
    : null,
  results,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(serialized);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized, "utf8");
process.stderr.write(`Spark benchmark report: ${outputPath}\n`);

async function discoverEndpoint() {
  const health = await endpointStatus("/health");
  const response = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`/v1/models returned HTTP ${response.status}.`);
  const payload = await response.json();
  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => entry?.id)
        .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 256)
    : [];
  if (models.length === 0 || models.length > 256 || new Set(models).size !== models.length) {
    throw new Error("Spark /v1/models returned no usable model IDs.");
  }
  return {
    health,
    models,
  };
}

async function endpointStatus(pathname) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(3_000),
    });
    return { reachable: true, statusCode: response.status, ok: response.ok };
  } catch (error) {
    return { reachable: false, statusCode: null, ok: false, error: boundedError(error) };
  }
}

async function probeCompatibility() {
  return {
    jsonObject: await probeJsonObject(),
    strictJsonSchema: await probeStrictJsonSchema(),
    toolCalling: await probeToolCalling(),
    streaming: { supported: true, validatedBy: "52-request concurrency matrix" },
  };
}

async function probeJsonObject() {
  return completionProbe(
    {
      messages: [
        { role: "system", content: "Return a JSON object only." },
        { role: "user", content: "Return exactly one field named status with value ok." },
      ],
      response_format: { type: "json_object" },
    },
    (message) => {
      const value = JSON.parse(message.content);
      return value?.status === "ok";
    },
  );
}

async function probeStrictJsonSchema() {
  return completionProbe(
    {
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
    },
    (message) => {
      const value = JSON.parse(message.content);
      return value?.status === "ok" && Object.keys(value).length === 1;
    },
  );
}

async function probeToolCalling() {
  return completionProbe(
    {
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
    },
    (message) => {
      const call = message.tool_calls?.[0];
      if (call?.function?.name !== "report_status") return false;
      const value = JSON.parse(call.function.arguments);
      return value?.status === "ok";
    },
  );
}

async function completionProbe(body, validate) {
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model,
        max_tokens: 64,
        temperature: 0,
        stream: false,
        ...body,
      }),
    });
    if (!response.ok) {
      return { supported: false, statusCode: response.status, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    return {
      supported: Boolean(message && validate(message)),
      statusCode: response.status,
      error: null,
    };
  } catch (error) {
    return { supported: false, statusCode: null, error: boundedError(error) };
  }
}

async function benchmark({ concurrency, requestCount }) {
  const metricsBefore = await scrapeMetrics();
  const samples = [];
  let sampling = true;
  const metricSamples = [];
  const sampler = sampleMetrics(metricSamples, () => sampling);
  const startedAt = performance.now();
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const requestIndex = nextIndex;
      nextIndex += 1;
      if (requestIndex >= requestCount) return;
      samples.push(await oneRequest(concurrency, requestIndex));
    }
  });
  await Promise.all(workers);
  const wallTimeMs = performance.now() - startedAt;
  sampling = false;
  await sampler;
  const metricsAfter = await scrapeMetrics();

  const successes = samples.filter(({ outcome }) => outcome === "completed");
  const errors = samples.filter(({ outcome }) => outcome === "error");
  const timeouts = samples.filter(({ outcome }) => outcome === "timeout");
  const promptTokens = sum(successes.map(({ promptTokens }) => promptTokens));
  const completionTokens = sum(
    successes.map(({ completionTokens }) => completionTokens),
  );
  const queueHistogram = histogramDelta(
    metricsBefore,
    metricsAfter,
    "vllm:request_queue_time_seconds_bucket",
  );
  return {
    concurrency,
    requestCount,
    successCount: successes.length,
    errorCount: errors.length,
    timeoutCount: timeouts.length,
    errorRate: ratio(errors.length, requestCount),
    timeoutRate: ratio(timeouts.length, requestCount),
    wallTimeMs: round(wallTimeMs),
    promptTokens,
    completionTokens,
    promptTokensPerSecond: rate(promptTokens, wallTimeMs),
    aggregateGenerationTokensPerSecond: rate(completionTokens, wallTimeMs),
    meanRequestGenerationTokensPerSecond: round(
      mean(successes.map(({ generationTokensPerSecond }) =>
        generationTokensPerSecond)),
    ),
    latencyMs: summary(successes.map(({ totalTimeMs }) => totalTimeMs)),
    ttftMs: summary(successes.map(({ ttftMs }) => ttftMs)),
    tpotMs: summary(successes.map(({ tpotMs }) => tpotMs)),
    serverQueueTimeMs: {
      p95: queueHistogram ? round(queueHistogramQuantile(queueHistogram, 0.95) * 1_000) : null,
      source: queueHistogram ? "vLLM Prometheus histogram delta" : "unavailable",
    },
    maxRunningRequests: maximumGauge(metricSamples, "vllm:num_requests_running"),
    maxWaitingRequests: maximumGauge(metricSamples, "vllm:num_requests_waiting"),
    maxKvCacheUsageRatio: maximumGaugeAny(metricSamples, [
      "vllm:kv_cache_usage_perc",
      "vllm:gpu_cache_usage_perc",
    ]),
    failures: [...errors, ...timeouts].map(({ requestIndex, outcome, error }) => ({
      requestIndex,
      outcome,
      error,
    })),
  };
}

async function oneRequest(concurrency, requestIndex) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("benchmark timeout")), timeoutMs);
  const startedAt = performance.now();
  let ttftMs = null;
  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "Return one concise Minecraft high-level planning action. Do not output hidden reasoning.",
          },
          {
            role: "user",
            content: `Benchmark case concurrency=${concurrency} request=${requestIndex}. A bot has full health and needs to gather wood. Give one high-level action.`,
          },
        ],
        max_tokens: 96,
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split(/\r?\n/u)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          const payload = JSON.parse(data);
          const token = payload.choices?.[0]?.delta?.content;
          if (typeof token === "string" && token.length > 0) {
            if (ttftMs === null) ttftMs = performance.now() - startedAt;
            content += token;
          }
          if (payload.usage) {
            promptTokens = payload.usage.prompt_tokens ?? promptTokens;
            completionTokens = payload.usage.completion_tokens ?? completionTokens;
          }
        }
      }
    }
    const totalTimeMs = performance.now() - startedAt;
    const measuredTtft = ttftMs ?? totalTimeMs;
    const decodeTimeMs = Math.max(0, totalTimeMs - measuredTtft);
    return {
      requestIndex,
      outcome: "completed",
      promptTokens,
      completionTokens,
      responseCharacters: content.length,
      totalTimeMs,
      ttftMs: measuredTtft,
      tpotMs: completionTokens > 1 ? decodeTimeMs / (completionTokens - 1) : 0,
      generationTokensPerSecond:
        decodeTimeMs > 0 ? completionTokens / (decodeTimeMs / 1_000) : 0,
      error: null,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      requestIndex,
      outcome: timedOut ? "timeout" : "error",
      promptTokens: 0,
      completionTokens: 0,
      totalTimeMs: performance.now() - startedAt,
      ttftMs: 0,
      tpotMs: 0,
      generationTokensPerSecond: 0,
      error: boundedError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sampleMetrics(samples, isActive) {
  while (isActive()) {
    const metrics = await scrapeMetrics();
    if (metrics) samples.push(metrics);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function scrapeMetrics() {
  try {
    const response = await fetch(`${baseUrl}/metrics`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return parsePrometheus(await response.text());
  } catch {
    return null;
  }
}

function parsePrometheus(text) {
  const samples = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^(?<name>[A-Za-z_:][A-Za-z0-9_:]*)(?:\{(?<labels>.*)\})?\s+(?<value>[-+0-9.eE]+)$/u.exec(line);
    if (!match?.groups) continue;
    const value = Number(match.groups.value);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    for (const label of match.groups.labels?.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/gu) ?? []) {
      labels[label[1]] = label[2];
    }
    samples.push({ name: match.groups.name, labels, value });
  }
  return samples;
}

function histogramDelta(before, after, name) {
  if (!before || !after) return null;
  const totals = new Map();
  for (const sample of after.filter((entry) => entry.name === name)) {
    const le = sample.labels.le;
    if (!le) continue;
    totals.set(le, (totals.get(le) ?? 0) + sample.value);
  }
  for (const sample of before.filter((entry) => entry.name === name)) {
    const le = sample.labels.le;
    if (!le) continue;
    totals.set(le, (totals.get(le) ?? 0) - sample.value);
  }
  const buckets = [...totals.entries()]
    .map(([le, count]) => ({ le: le === "+Inf" ? Infinity : Number(le), count }))
    .filter(({ le, count }) => !Number.isNaN(le) && count >= 0)
    .sort((left, right) => left.le - right.le);
  return buckets.length > 0 ? buckets : null;
}

function queueHistogramQuantile(buckets, quantile) {
  const total = buckets.at(-1)?.count ?? 0;
  if (total <= 0) return 0;
  const target = total * quantile;
  return buckets.find(({ count }) => count >= target)?.le ?? Infinity;
}

function maximumGauge(samples, name) {
  const values = samples.flatMap((snapshot) =>
    snapshot.filter((entry) => entry.name === name).map(({ value }) => value));
  return values.length > 0 ? Math.max(...values) : null;
}

function maximumGaugeAny(samples, names) {
  for (const name of names) {
    const value = maximumGauge(samples, name);
    if (value !== null) return value;
  }
  return null;
}

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    mean: sorted.length > 0 ? round(mean(sorted)) : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function mean(values) {
  return values.length > 0 ? sum(values) / values.length : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function rate(tokens, milliseconds) {
  return milliseconds > 0 ? round(tokens / (milliseconds / 1_000)) : 0;
}

function ratio(value, total) {
  return total > 0 ? round(value / total) : 0;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 300);
}

function requiredOrigin(raw) {
  const value = requiredText(raw, "LOCAL_AI_HUB_URL", 2_048);
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("LOCAL_AI_HUB_URL must be an explicit HTTP(S) origin.");
  }
  return url.origin;
}

function requiredText(raw, name, maxLength) {
  const value = raw?.trim();
  if (!value || value.length > maxLength) throw new Error(`${name} is required.`);
  return value;
}

function integerList(raw) {
  const values = raw.split(",").map((value) =>
    boundedInteger(value.trim(), 1, 64, "AI_BENCH_CONCURRENCIES"));
  if (values.length < 1 || values.length > 16 || new Set(values).size !== values.length) {
    throw new Error("AI_BENCH_CONCURRENCIES is invalid.");
  }
  return values;
}

function benchmarkOutputPath(raw, runtimeDirectory) {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const resolved = path.resolve(
    raw?.trim() || path.join(runtimeDirectory, `spark-benchmark-${stamp}.json`),
  );
  const relative = path.relative(runtimeDirectory, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("AI_BENCH_OUTPUT must be a file inside runtime-data.");
  }
  return resolved;
}

function boundedInteger(raw, minimum, maximum, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range.`);
  }
  return value;
}
