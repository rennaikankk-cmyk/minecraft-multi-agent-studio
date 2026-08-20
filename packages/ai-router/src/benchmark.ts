import { randomUUID } from "node:crypto";

import { AIRouter } from "./router.js";
import { AIRequestScheduler } from "./scheduler.js";
import type { SparkMetricsSnapshot } from "./spark-metrics.js";
import type { AIProvider } from "./types/provider.js";

export type AIConcurrencyBenchmarkLevel = Readonly<{
  concurrency: number;
  requests: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  wallTimeMs: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  queueTimeP50Ms: number | null;
  queueTimeP95Ms: number | null;
  queueTimeP99Ms: number | null;
  providerQueueTimeP50Ms: number | null;
  providerQueueTimeP95Ms: number | null;
  providerQueueTimeP99Ms: number | null;
  timeToFirstTokenP50Ms: number | null;
  timeToFirstTokenP95Ms: number | null;
  timeToFirstTokenP99Ms: number | null;
  timePerOutputTokenP50Ms: number | null;
  timePerOutputTokenP95Ms: number | null;
  timePerOutputTokenP99Ms: number | null;
  requestsPerSecond: number;
  promptTokens: number;
  promptTokensPerSecond: number;
  outputTokens: number;
  outputTokensPerSecond: number;
  perRequestGenerationTokensPerSecondP50: number | null;
  perRequestGenerationTokensPerSecondP95: number | null;
  inferenceNodeBefore: SparkMetricsSnapshot | null;
  inferenceNodeAfter: SparkMetricsSnapshot | null;
  errors: Readonly<Record<string, number>>;
}>;

export type AIConcurrencyBenchmarkResult = Readonly<{
  schemaVersion: "1.0";
  benchmarkType: "ai-openai-compatible-concurrency";
  warning: string;
  measuredAt: string;
  provider: string;
  concurrencyLevels: readonly AIConcurrencyBenchmarkLevel[];
  recommendedMaxConcurrency: number | null;
  recommendation: Readonly<{
    recommendedConcurrency: number | null;
    tested: readonly number[];
    reason: string;
  }>;
  recommendationRule: string;
}>;

export type AIConcurrencyBenchmarkOptions = Readonly<{
  provider: AIProvider;
  concurrencyLevels: readonly number[];
  requestsPerLevel?: number | ((concurrency: number) => number);
  prompt?: string;
  systemPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maximumErrorRate?: number;
  now?: () => Date;
  randomId?: () => string;
  metricsCollector?: Readonly<{ collect(signal?: AbortSignal): Promise<SparkMetricsSnapshot> }>;
}>;

export async function runAIConcurrencyBenchmark(
  options: AIConcurrencyBenchmarkOptions,
): Promise<AIConcurrencyBenchmarkResult> {
  const levels = [...new Set(options.concurrencyLevels)].sort((left, right) => left - right);
  if (levels.length === 0 || levels.some((level) => !Number.isSafeInteger(level) || level < 1)) {
    throw new TypeError("concurrencyLevels must contain positive safe integers.");
  }
  const maximumErrorRate = options.maximumErrorRate ?? 0.01;
  if (!Number.isFinite(maximumErrorRate) || maximumErrorRate < 0 || maximumErrorRate > 1) {
    throw new TypeError("maximumErrorRate must be between 0 and 1.");
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const results: AIConcurrencyBenchmarkLevel[] = [];

  for (const concurrency of levels) {
    const inferenceNodeBefore = await safeCollect(options.metricsCollector);
    const requests = requestCount(options.requestsPerLevel, concurrency);
    const router = new AIRouter();
    router.register(options.provider);
    const scheduler = new AIRequestScheduler(router, {
      maxConcurrency: concurrency,
      maxQueue: Math.max(requests, 1),
      perBotConcurrency: 1,
      staleAfterMs: Math.max(timeoutMs * 2, 1_000),
      maxRetries: 0,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    const startedAt = Date.now();
    const handles = Array.from({ length: requests }, (_, index) => {
      const requestId = randomId();
      return scheduler.submit({
        requestId,
        traceId: `benchmark-${requestId}`,
        botId: `benchmark-bot-${concurrency}-${index}`,
        taskType: "planner",
        priority: 30,
        timestamp: now().toISOString(),
        stateVersion: 1,
        taskVersion: 1,
        prompt: options.prompt ?? "Return one concise safe Minecraft planning suggestion.",
        ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
        maxTokens: options.maxTokens ?? 128,
        temperature: 0,
        timeoutMs,
      });
    });
    const settled = await Promise.allSettled(handles.map(({ promise }) => promise));
    const wallTimeMs = Math.max(1, Date.now() - startedAt);
    scheduler.close();
    const successes = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = settled.filter((result) => result.status === "rejected");
    const latencies = successes.map(({ totalLatencyMs }) => totalLatencyMs);
    const queueTimes = successes.map(({ queueTimeMs }) => queueTimeMs);
    const providerQueueTimes = compact(successes.map(({ metrics }) => metrics?.queueTimeMs));
    const timeToFirstTokens = compact(
      successes.map(({ metrics }) => metrics?.timeToFirstTokenMs),
    );
    const timePerOutputTokens = compact(
      successes.map(({ metrics }) => metrics?.meanInterTokenLatencyMs),
    );
    const perRequestGenerationRates = compact(
      successes.map(({ metrics }) => metrics?.tokensPerSecond),
    );
    const promptTokens = successes.reduce(
      (total, result) => total + result.usage.promptTokens,
      0,
    );
    const outputTokens = successes.reduce(
      (total, result) => total + result.usage.completionTokens,
      0,
    );
    const errors: Record<string, number> = {};
    for (const failure of failures) {
      const reason: unknown = failure.reason;
      const code =
        typeof reason === "object" && reason !== null && "code" in reason &&
        typeof reason.code === "string"
          ? reason.code
          : "UNKNOWN";
      errors[code] = (errors[code] ?? 0) + 1;
    }
    const inferenceNodeAfter = await safeCollect(options.metricsCollector);
    results.push(Object.freeze({
      concurrency,
      requests,
      succeeded: successes.length,
      failed: failures.length,
      errorRate: round(failures.length / requests),
      wallTimeMs,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      latencyP99Ms: percentile(latencies, 0.99),
      queueTimeP50Ms: percentile(queueTimes, 0.5),
      queueTimeP95Ms: percentile(queueTimes, 0.95),
      queueTimeP99Ms: percentile(queueTimes, 0.99),
      providerQueueTimeP50Ms: percentile(providerQueueTimes, 0.5),
      providerQueueTimeP95Ms: percentile(providerQueueTimes, 0.95),
      providerQueueTimeP99Ms: percentile(providerQueueTimes, 0.99),
      timeToFirstTokenP50Ms: percentile(timeToFirstTokens, 0.5),
      timeToFirstTokenP95Ms: percentile(timeToFirstTokens, 0.95),
      timeToFirstTokenP99Ms: percentile(timeToFirstTokens, 0.99),
      timePerOutputTokenP50Ms: percentile(timePerOutputTokens, 0.5),
      timePerOutputTokenP95Ms: percentile(timePerOutputTokens, 0.95),
      timePerOutputTokenP99Ms: percentile(timePerOutputTokens, 0.99),
      requestsPerSecond: round((successes.length * 1_000) / wallTimeMs),
      promptTokens,
      promptTokensPerSecond: round((promptTokens * 1_000) / wallTimeMs),
      outputTokens,
      outputTokensPerSecond: round((outputTokens * 1_000) / wallTimeMs),
      perRequestGenerationTokensPerSecondP50: percentile(
        perRequestGenerationRates,
        0.5,
      ),
      perRequestGenerationTokensPerSecondP95: percentile(
        perRequestGenerationRates,
        0.95,
      ),
      inferenceNodeBefore,
      inferenceNodeAfter,
      errors: Object.freeze(errors),
    }));
  }

  const recommendation = recommend(results, maximumErrorRate);
  return Object.freeze({
    schemaVersion: "1.0",
    benchmarkType: "ai-openai-compatible-concurrency",
    warning:
      "This measures one synthetic inference prompt. It does not measure Minecraft task quality, long-context load, soak stability, or end-to-end Bot execution.",
    measuredAt: now().toISOString(),
    provider: options.provider.name,
    concurrencyLevels: Object.freeze(results),
    recommendedMaxConcurrency: recommendation.recommendedConcurrency,
    recommendation: Object.freeze({
      ...recommendation,
      tested: Object.freeze(levels),
    }),
    recommendationRule:
      "Lowest balanced level near peak throughput after rejecting excessive errors, P95 latency growth, provider queueing, waiting requests, or KV cache pressure.",
  });
}

function requestCount(
  configured: AIConcurrencyBenchmarkOptions["requestsPerLevel"],
  concurrency: number,
): number {
  const value = typeof configured === "function"
    ? configured(concurrency)
    : configured ?? Math.max(4, concurrency * 2);
  if (!Number.isSafeInteger(value) || value < concurrency) {
    throw new TypeError("requestsPerLevel must be a safe integer at least equal to concurrency.");
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index]!);
}

function recommend(
  results: readonly AIConcurrencyBenchmarkLevel[],
  maximumErrorRate: number,
): Readonly<{ recommendedConcurrency: number | null; reason: string }> {
  const healthy = results.filter(({ errorRate, succeeded }) =>
    succeeded > 0 && errorRate <= maximumErrorRate,
  );
  if (healthy.length === 0) {
    return {
      recommendedConcurrency: null,
      reason: "No tested level completed within the configured error-rate limit.",
    };
  }
  const useTokenThroughput = healthy.some(({ outputTokens }) => outputTokens > 0);
  const throughput = (result: AIConcurrencyBenchmarkLevel) =>
    useTokenThroughput ? result.outputTokensPerSecond : result.requestsPerSecond;
  const maximum = Math.max(...healthy.map(throughput));
  const bestP95 = Math.min(
    ...healthy.map(({ latencyP95Ms }) => latencyP95Ms ?? Number.POSITIVE_INFINITY),
  );
  const balanced = healthy.filter((result) => {
    const kvUsage = result.inferenceNodeAfter?.kvCacheUsagePercent;
    const waiting = result.inferenceNodeAfter?.waitingRequests;
    const latencyAcceptable = !Number.isFinite(bestP95) || result.latencyP95Ms === null ||
      result.latencyP95Ms <= bestP95 * 2.5;
    const queueAcceptable = result.providerQueueTimeP95Ms === null ||
      result.providerQueueTimeP95Ms <= Math.max(1_000, bestP95);
    return throughput(result) >= maximum * 0.9 &&
      latencyAcceptable &&
      queueAcceptable &&
      (kvUsage === null || kvUsage === undefined || kvUsage <= 90) &&
      (waiting === null || waiting === undefined || waiting <= result.concurrency);
  });
  const selected = (balanced.length > 0 ? balanced : healthy)
    .sort((left, right) => left.concurrency - right.concurrency)[0]!;
  return {
    recommendedConcurrency: selected.concurrency,
    reason:
      `Concurrency ${selected.concurrency} is the lowest tested level near peak healthy throughput ` +
      "without observed excessive P95 latency, provider queueing, waiting requests, or KV pressure.",
  };
}

async function safeCollect(
  collector: AIConcurrencyBenchmarkOptions["metricsCollector"],
): Promise<SparkMetricsSnapshot | null> {
  if (collector === undefined) return null;
  try {
    return await collector.collect();
  } catch {
    return null;
  }
}

function compact(values: readonly (number | null | undefined)[]): number[] {
  return values.filter((value): value is number => value !== null && value !== undefined);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
