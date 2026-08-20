import { randomUUID } from "node:crypto";

import { AIRouter } from "./router.js";
import { AIRequestScheduler } from "./scheduler.js";
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
  requestsPerSecond: number;
  outputTokens: number;
  outputTokensPerSecond: number;
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
    results.push(Object.freeze({
      concurrency,
      requests,
      succeeded: successes.length,
      failed: failures.length,
      errorRate: round(failures.length / requests),
      wallTimeMs,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      requestsPerSecond: round((successes.length * 1_000) / wallTimeMs),
      outputTokens,
      outputTokensPerSecond: round((outputTokens * 1_000) / wallTimeMs),
      errors: Object.freeze(errors),
    }));
  }

  return Object.freeze({
    schemaVersion: "1.0",
    benchmarkType: "ai-openai-compatible-concurrency",
    warning:
      "This measures one synthetic inference prompt. It does not measure Minecraft task quality, long-context load, soak stability, or end-to-end Bot execution.",
    measuredAt: now().toISOString(),
    provider: options.provider.name,
    concurrencyLevels: Object.freeze(results),
    recommendedMaxConcurrency: recommend(results, maximumErrorRate),
    recommendationRule:
      "Lowest healthy level within 95% of maximum measured throughput; healthy means error rate at or below the configured threshold.",
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
): number | null {
  const healthy = results.filter(({ errorRate, succeeded }) =>
    succeeded > 0 && errorRate <= maximumErrorRate,
  );
  if (healthy.length === 0) return null;
  const useTokenThroughput = healthy.some(({ outputTokens }) => outputTokens > 0);
  const throughput = (result: AIConcurrencyBenchmarkLevel) =>
    useTokenThroughput ? result.outputTokensPerSecond : result.requestsPerSecond;
  const maximum = Math.max(...healthy.map(throughput));
  return healthy.find((result) => throughput(result) >= maximum * 0.95)!.concurrency;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
