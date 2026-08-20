import { z } from "zod";
import type {
  AiLatencyPercentilesV1,
  AiNodeMetricsSnapshotV1,
} from "@minecraft-studio/protocol";

const modelsResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(1_024),
          })
          .passthrough(),
      )
      .max(128),
  })
  .passthrough();

const versionResponseSchema = z
  .object({ version: z.string().trim().min(1).max(256) })
  .passthrough();

export type SparkLatencyPercentiles = AiLatencyPercentilesV1;
export type SparkMetricsSnapshot = AiNodeMetricsSnapshotV1;

export type SparkMetricsCollectorOptions = Readonly<{
  baseUrl: string;
  nodeName?: string;
  backend?: "vllm" | "openai-compatible";
  quantization?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxResponseBytes?: number;
  now?: () => Date;
  fetch?: typeof fetch;
}>;

type PrometheusSample = Readonly<{
  name: string;
  labels: Readonly<Record<string, string>>;
  value: number;
}>;

type CounterSample = Readonly<{
  sampledAtMs: number;
  promptTokens: number | null;
  generationTokens: number | null;
}>;

/**
 * Reads only documented OpenAI-compatible/vLLM observation endpoints. Missing
 * metrics remain null so an older or differently configured backend never
 * appears healthier or faster than the evidence supports.
 */
export class SparkMetricsCollector {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => Date;
  private previousCounters: CounterSample | null = null;

  constructor(private readonly options: SparkMetricsCollectorOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 100, 60_000, "timeoutMs");
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 2 * 1_024 * 1_024,
      1_024,
      16 * 1_024 * 1_024,
      "maxResponseBytes",
    );
    if (
      options.maxConcurrency !== undefined &&
      (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1)
    ) {
      throw new TypeError("maxConcurrency must be a positive safe integer.");
    }
    this.now = options.now ?? (() => new Date());
  }

  async collect(signal?: AbortSignal): Promise<SparkMetricsSnapshot> {
    const sampledAt = validDate(this.now());
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error("SPARK_METRICS_TIMEOUT")), this.timeoutMs);
    const headers = this.options.apiKey === undefined
      ? undefined
      : { Authorization: `Bearer ${this.options.apiKey}` };
    try {
      const [health, models, metrics, version] = await Promise.allSettled([
        this.timedRequest("/health", controller.signal, headers),
        this.request("/v1/models", controller.signal, headers),
        this.request("/metrics", controller.signal, headers),
        this.request("/version", controller.signal, headers),
      ]);
      const healthOnline = health.status === "fulfilled" && health.value.ok;
      const modelsOnline = models.status === "fulfilled" && models.value.ok;
      const endpointResponding = health.status === "fulfilled" || models.status === "fulfilled";
      const errorCodes: string[] = [];
      if (!healthOnline) errorCodes.push(responseErrorCode("HEALTH", health));

      const modelIds = modelsOnline
        ? parseModels(models.value.body, errorCodes)
        : (errorCodes.push(responseErrorCode("MODELS", models)), []);
      const samples = metrics.status === "fulfilled" && metrics.value.ok
        ? parsePrometheus(metrics.value.body, errorCodes)
        : (errorCodes.push(responseErrorCode("METRICS", metrics)), []);
      const backendVersion = version.status === "fulfilled" && version.value.ok
        ? parseVersion(version.value.body, errorCodes)
        : (errorCodes.push(responseErrorCode("VERSION", version)), null);
      const counters: CounterSample = {
        sampledAtMs: sampledAt.getTime(),
        promptTokens: metricSum(samples, ["vllm:prompt_tokens_total", "vllm_prompt_tokens_total"]),
        generationTokens: metricSum(samples, [
          "vllm:generation_tokens_total",
          "vllm_generation_tokens_total",
          "vllm:generation_tokens",
          "vllm_generation_tokens",
        ]),
      };
      const rates = counterRates(this.previousCounters, counters);
      this.previousCounters = counters;
      const requestOutcomes = requestOutcomeMetrics(samples);

      return Object.freeze({
        schemaVersion: "1.0",
        nodeName: this.options.nodeName ?? "MSI DGX Spark",
        status: healthOnline || modelsOnline
          ? "online"
          : endpointResponding
            ? "starting"
            : "offline",
        sampledAt: sampledAt.toISOString(),
        backend: this.options.backend ?? "vllm",
        backendVersion,
        quantization: this.options.quantization ?? null,
        models: Object.freeze(modelIds),
        networkRttMs: healthOnline ? health.value.rttMs : null,
        runningRequests: metricSum(samples, [
          "vllm:num_requests_running",
          "vllm_num_requests_running",
        ]),
        waitingRequests: metricSum(samples, [
          "vllm:num_requests_waiting",
          "vllm_num_requests_waiting",
        ]),
        maxConcurrency: this.options.maxConcurrency ?? null,
        kvCacheUsagePercent: cacheUsagePercent(samples),
        promptTokensPerSecond: rates.promptTokensPerSecond,
        generationTokensPerSecond: rates.generationTokensPerSecond,
        promptTokensTotal: counters.promptTokens,
        generationTokensTotal: counters.generationTokens,
        successfulRequestsTotal: requestOutcomes.successful,
        ttft: histogramPercentiles(samples, [
          "vllm:time_to_first_token_seconds",
          "vllm_time_to_first_token_seconds",
        ]),
        tpot: histogramPercentiles(samples, [
          "vllm:request_time_per_output_token_seconds",
          "vllm_request_time_per_output_token_seconds",
          "vllm:time_per_output_token_seconds",
          "vllm_time_per_output_token_seconds",
        ]),
        queueLatency: histogramPercentiles(samples, [
          "vllm:request_queue_time_seconds",
          "vllm_request_queue_time_seconds",
        ]),
        endToEndLatency: histogramPercentiles(samples, [
          "vllm:e2e_request_latency_seconds",
          "vllm_e2e_request_latency_seconds",
        ]),
        errorRate: requestOutcomes.errorRate,
        errorCodes: Object.freeze([...new Set(errorCodes)].sort()),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async request(
    path: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<Readonly<{ ok: boolean; status: number; body: string }>> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...(headers === undefined ? {} : { headers }),
      redirect: "error",
      signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await readBoundedText(response, this.maxResponseBytes),
    };
  }

  private async timedRequest(
    path: string,
    signal: AbortSignal,
    headers: Readonly<Record<string, string>> | undefined,
  ): Promise<Readonly<{ ok: boolean; status: number; body: string; rttMs: number }>> {
    const startedAt = Date.now();
    return {
      ...await this.request(path, signal, headers),
      rttMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Spark metrics base URL is invalid.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/")
  ) {
    throw new TypeError("Spark metrics base URL must be an HTTP(S) origin or its /v1 root.");
  }
  url.pathname = "";
  return url.toString().replace(/\/$/u, "");
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("SPARK_METRICS_RESPONSE_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("SPARK_METRICS_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function parseModels(body: string, errors: string[]): string[] {
  try {
    const parsed = modelsResponseSchema.parse(JSON.parse(body) as unknown);
    return [...new Set(parsed.data.map(({ id }) => id))].sort();
  } catch {
    errors.push("MODELS_RESPONSE_INVALID");
    return [];
  }
}

function parseVersion(body: string, errors: string[]): string | null {
  try {
    return versionResponseSchema.parse(JSON.parse(body) as unknown).version;
  } catch {
    errors.push("VERSION_RESPONSE_INVALID");
    return null;
  }
}

function parsePrometheus(body: string, errors: string[]): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const line of body.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/u.exec(trimmed);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels = parseLabels(match[2] ?? "");
    if (labels === null) continue;
    samples.push(Object.freeze({ name: match[1]!, labels: Object.freeze(labels), value }));
  }
  if (samples.length === 0) errors.push("METRICS_RESPONSE_INVALID");
  return samples;
}

function parseLabels(value: string): Record<string, string> | null {
  if (value === "") return {};
  const labels: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/gy;
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match) return null;
    labels[match[1]!] = match[2]!.replace(/\\([\\"n])/gu, (_whole, escaped: string) =>
      escaped === "n" ? "\n" : escaped,
    );
    offset = pattern.lastIndex;
  }
  return labels;
}

function metricSum(samples: readonly PrometheusSample[], names: readonly string[]): number | null {
  const selected = samples.filter(({ name }) => names.includes(name));
  return selected.length === 0 ? null : round(selected.reduce((sum, sample) => sum + sample.value, 0));
}

function cacheUsagePercent(samples: readonly PrometheusSample[]): number | null {
  const value = metricSum(samples, [
    "vllm:kv_cache_usage_perc",
    "vllm_kv_cache_usage_perc",
    "vllm:gpu_cache_usage_perc",
    "vllm_gpu_cache_usage_perc",
  ]);
  if (value === null) return null;
  return round(Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)));
}

function requestOutcomeMetrics(samples: readonly PrometheusSample[]): Readonly<{
  successful: number | null;
  errorRate: number | null;
}> {
  const outcomes = samples.filter(({ name }) =>
    name === "vllm:request_success_total" || name === "vllm_request_success_total",
  );
  if (outcomes.length === 0) return { successful: null, errorRate: null };
  let successful = 0;
  let errors = 0;
  let total = 0;
  for (const sample of outcomes) {
    total += sample.value;
    const reason = sample.labels.finished_reason ?? sample.labels.finish_reason;
    if (reason === "error") {
      errors += sample.value;
    } else if (reason !== "abort") {
      successful += sample.value;
    }
  }
  return {
    successful: round(successful),
    errorRate: total <= 0 ? 0 : round(errors / total),
  };
}

function histogramPercentiles(
  samples: readonly PrometheusSample[],
  names: readonly string[],
): SparkLatencyPercentiles {
  const buckets = new Map<number, number>();
  for (const sample of samples) {
    const baseName = names.find((name) => sample.name === `${name}_bucket`);
    if (!baseName) continue;
    const upper = sample.labels.le === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample.labels.le);
    if (Number.isNaN(upper)) continue;
    buckets.set(upper, (buckets.get(upper) ?? 0) + sample.value);
  }
  const sorted = [...buckets].sort(([left], [right]) => left - right);
  const percentile = (fraction: number): number | null => {
    if (sorted.length === 0) return null;
    const total = sorted.at(-1)![1];
    if (total <= 0) return null;
    const target = total * fraction;
    const bucket = sorted.find(([, count]) => count >= target);
    if (!bucket || !Number.isFinite(bucket[0])) return null;
    return round(bucket[0] * 1_000);
  };
  return Object.freeze({ p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) });
}

function counterRates(previous: CounterSample | null, current: CounterSample) {
  if (!previous || current.sampledAtMs <= previous.sampledAtMs) {
    return { promptTokensPerSecond: null, generationTokensPerSecond: null };
  }
  const seconds = (current.sampledAtMs - previous.sampledAtMs) / 1_000;
  const rate = (before: number | null, after: number | null): number | null =>
    before === null || after === null || after < before ? null : round((after - before) / seconds);
  return {
    promptTokensPerSecond: rate(previous.promptTokens, current.promptTokens),
    generationTokensPerSecond: rate(previous.generationTokens, current.generationTokens),
  };
}

function responseErrorCode(
  prefix: string,
  result: PromiseSettledResult<Readonly<{ status: number }>>,
): string {
  return result.status === "fulfilled" ? `${prefix}_HTTP_${result.value.status}` : `${prefix}_UNAVAILABLE`;
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} is outside the allowed range.`);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Spark metrics clock is invalid.");
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
