#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runAIConcurrencyBenchmark } from "./benchmark.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { SparkMetricsCollector } from "./spark-metrics.js";

const executeFile = promisify(execFile);
const values = parseArgs(process.argv.slice(2));
const baseUrl = requiredEnvironment("AI_BASE_URL");
const model = requiredEnvironment("AI_MODEL");
const apiKey = optionalEnvironment("AI_API_KEY");
const concurrency = positiveInteger(
  values.get("concurrency") ?? process.env.AI_MAX_CONCURRENCY ?? "4",
  "concurrency",
);
const durationMs = values.has("duration-seconds")
  ? positiveInteger(values.get("duration-seconds")!, "duration-seconds") * 1_000
  : positiveInteger(values.get("duration-minutes") ?? "30", "duration-minutes") * 60_000;
const maxTokens = positiveInteger(values.get("max-tokens") ?? "128", "max-tokens");
const provider = new OpenAICompatibleProvider({
  name: process.env.AI_PROVIDER_NAME ?? "spark-vllm",
  baseUrl,
  model,
  ...(apiKey === undefined ? {} : { apiKey }),
});
const health = await provider.health();
if (!health.available) {
  throw new Error(`AI provider health check failed: ${health.errorCode ?? "unavailable"}`);
}
const collector = new SparkMetricsCollector({
  baseUrl,
  maxConcurrency: concurrency,
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(process.env.AI_QUANTIZATION === undefined
    ? {}
    : { quantization: process.env.AI_QUANTIZATION }),
});
const startedAt = Date.now();
const deadline = startedAt + durationMs;
let stopRequested = false;
process.once("SIGINT", () => { stopRequested = true; });
process.once("SIGTERM", () => { stopRequested = true; });
const batches: Array<Readonly<{
  index: number;
  measuredAt: string;
  result: Awaited<ReturnType<typeof runAIConcurrencyBenchmark>>;
  gpu: Awaited<ReturnType<typeof collectNvidiaSnapshot>>;
}>> = [];

while (!stopRequested && (batches.length === 0 || Date.now() < deadline)) {
  const result = await runAIConcurrencyBenchmark({
    provider,
    concurrencyLevels: [concurrency],
    requestsPerLevel: concurrency,
    maxTokens,
    timeoutMs: 120_000,
    metricsCollector: collector,
  });
  const gpu = await collectNvidiaSnapshot();
  const batch = Object.freeze({
    index: batches.length + 1,
    measuredAt: new Date().toISOString(),
    result,
    gpu,
  });
  batches.push(batch);
  const level = result.concurrencyLevels[0]!;
  process.stdout.write(`${JSON.stringify({
    batch: batch.index,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
    succeeded: level.succeeded,
    failed: level.failed,
    outputTokensPerSecond: level.outputTokensPerSecond,
    temperatureC: gpu.devices[0]?.temperatureC ?? null,
  })}\n`);
}

const completedAt = Date.now();
const levels = batches.map(({ result }) => result.concurrencyLevels[0]!);
const totalRequests = levels.reduce((sum, level) => sum + level.requests, 0);
const succeeded = levels.reduce((sum, level) => sum + level.succeeded, 0);
const failed = levels.reduce((sum, level) => sum + level.failed, 0);
const report = Object.freeze({
  schemaVersion: "1.0" as const,
  benchmarkType: "ai-openai-compatible-soak" as const,
  startedAt: new Date(startedAt).toISOString(),
  completedAt: new Date(completedAt).toISOString(),
  requestedDurationMs: durationMs,
  actualDurationMs: completedAt - startedAt,
  stoppedBySignal: stopRequested,
  provider: provider.name,
  model,
  concurrency,
  maxTokens,
  totalRequests,
  succeeded,
  failed,
  errorRate: totalRequests === 0 ? 1 : round(failed / totalRequests),
  meanAggregateOutputTokensPerSecond: mean(
    levels.map(({ outputTokensPerSecond }) => outputTokensPerSecond),
  ),
  maximumProviderQueueP95Ms: maximumNullable(
    levels.map(({ providerQueueTimeP95Ms }) => providerQueueTimeP95Ms),
  ),
  maximumTimeToFirstTokenP95Ms: maximumNullable(
    levels.map(({ timeToFirstTokenP95Ms }) => timeToFirstTokenP95Ms),
  ),
  maximumTemperatureC: maximumNullable(
    batches.map(({ gpu }) => gpu.devices[0]?.temperatureC ?? null),
  ),
  maximumPowerDrawW: maximumNullable(
    batches.map(({ gpu }) => gpu.devices[0]?.powerDrawW ?? null),
  ),
  batches: Object.freeze(batches),
});
const outputDirectory = path.resolve(
  values.get("output-dir") ?? path.join(
    fileURLToPath(new URL("../../../", import.meta.url)),
    "runtime-data/ai/benchmarks",
  ),
);
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const baseName = `ai-soak-${stamp}`;
const jsonPath = path.join(outputDirectory, `${baseName}.json`);
const markdownPath = path.join(outputDirectory, `${baseName}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(markdownPath, renderMarkdown(report), "utf8");
process.stdout.write(`${JSON.stringify({ status: "complete", jsonPath, markdownPath, ...summary(report) }, null, 2)}\n`);
if (report.failed > 0 || report.stoppedBySignal) process.exitCode = 1;

function parseArgs(input: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (token === "--") continue;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!["concurrency", "duration-minutes", "duration-seconds", "max-tokens", "output-dir"].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    result.set(key, value);
    index += 1;
  }
  if (result.has("duration-minutes") && result.has("duration-seconds")) {
    throw new Error("Choose only one soak duration option.");
  }
  return result;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

async function collectNvidiaSnapshot(): Promise<Readonly<{
  sampledAt: string;
  devices: readonly Readonly<{
    index: number | null;
    name: string;
    temperatureC: number | null;
    utilizationPercent: number | null;
    powerDrawW: number | null;
  }>[];
}>> {
  const sampledAt = new Date().toISOString();
  try {
    const { stdout } = await executeFile("nvidia-smi", [
      "--query-gpu=index,name,temperature.gpu,utilization.gpu,power.draw",
      "--format=csv,noheader,nounits",
    ], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    return {
      sampledAt,
      devices: stdout.trim().split(/\r?\n/gu).filter(Boolean).map((line) => {
        const [index, name, temperatureC, utilizationPercent, powerDrawW] =
          line.split(",").map((value) => value.trim());
        return { index: numeric(index), name: name ?? "unknown", temperatureC: numeric(temperatureC), utilizationPercent: numeric(utilizationPercent), powerDrawW: numeric(powerDrawW) };
      }),
    };
  } catch {
    return { sampledAt, devices: [] };
  }
}

function numeric(value: string | undefined): number | null {
  if (value === undefined || /^(?:N\/A|\[Not Supported\])$/iu.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maximumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.max(...present);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function summary(value: typeof report) {
  return {
    actualDurationMs: value.actualDurationMs,
    totalRequests: value.totalRequests,
    succeeded: value.succeeded,
    failed: value.failed,
    errorRate: value.errorRate,
    meanAggregateOutputTokensPerSecond: value.meanAggregateOutputTokensPerSecond,
    maximumProviderQueueP95Ms: value.maximumProviderQueueP95Ms,
    maximumTimeToFirstTokenP95Ms: value.maximumTimeToFirstTokenP95Ms,
    maximumTemperatureC: value.maximumTemperatureC,
    maximumPowerDrawW: value.maximumPowerDrawW,
  };
}

function renderMarkdown(value: typeof report): string {
  const result = summary(value);
  return [
    "# AI soak benchmark",
    "",
    `- Started: ${value.startedAt}`,
    `- Completed: ${value.completedAt}`,
    `- Duration: ${(value.actualDurationMs / 60_000).toFixed(2)} minutes`,
    `- Model: ${value.model}`,
    `- Concurrency: ${value.concurrency}`,
    `- Requests: ${result.succeeded}/${result.totalRequests} succeeded`,
    `- Error rate: ${result.errorRate}`,
    `- Mean aggregate output: ${result.meanAggregateOutputTokensPerSecond ?? "N/A"} tok/s`,
    `- Maximum provider queue P95: ${result.maximumProviderQueueP95Ms ?? "N/A"} ms`,
    `- Maximum TTFT P95: ${result.maximumTimeToFirstTokenP95Ms ?? "N/A"} ms`,
    `- Maximum temperature: ${result.maximumTemperatureC ?? "N/A"} °C`,
    `- Maximum power draw: ${result.maximumPowerDrawW ?? "N/A"} W`,
    "",
    "Raw per-batch endpoint, latency, token, queue, KV, and GPU samples are retained in the JSON report.",
    "",
  ].join("\n");
}
