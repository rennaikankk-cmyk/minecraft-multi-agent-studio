#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { runAIConcurrencyBenchmark } from "./benchmark.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { MockAIProvider } from "./providers/mock-provider.js";

const executeFile = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const mock = args.flags.has("mock");
const baseUrl = process.env.AI_BASE_URL;
const model = process.env.AI_MODEL;
if (!mock && (baseUrl === undefined || model === undefined)) {
  throw new Error("AI_BASE_URL and AI_MODEL are required unless --mock is used.");
}
const provider = mock
  ? new MockAIProvider("mock", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        content: "Mock benchmark response.",
        model: "mock",
        usage: { promptTokens: 12, completionTokens: 8 },
      };
    })
  : new OpenAICompatibleProvider({
      name: "spark-vllm",
      baseUrl: baseUrl!,
      model: model!,
      ...(process.env.AI_API_KEY === undefined ? {} : { apiKey: process.env.AI_API_KEY }),
    });

const health = await provider.health();
if (!health.available) {
  throw new Error(`AI provider health check failed: ${health.errorCode ?? "unavailable"}`);
}
const concurrencyLevels = parseIntegerList(args.values.get("concurrency") ?? "1,2,5,10");
const requests = args.values.has("requests")
  ? positiveInteger(args.values.get("requests")!, "requests")
  : undefined;
const beforeGpu = await collectNvidiaSnapshot();
const benchmark = await runAIConcurrencyBenchmark({
  provider,
  concurrencyLevels,
  ...(requests === undefined ? {} : { requestsPerLevel: requests }),
  maxTokens: positiveInteger(args.values.get("max-tokens") ?? "128", "max-tokens"),
  timeoutMs: positiveInteger(args.values.get("timeout-ms") ?? "60000", "timeout-ms"),
});
const afterGpu = await collectNvidiaSnapshot();
const report = {
  ...benchmark,
  mode: mock ? "mock-validation" : "real-openai-compatible-endpoint",
  host: { platform: process.platform, architecture: process.arch, nodeVersion: process.version },
  providerHealth: health,
  gpu: { before: beforeGpu, after: afterGpu },
};
const outputDirectory = path.resolve(args.values.get("output-dir") ?? "artifacts");
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const baseName = `ai-benchmark-${stamp}`;
const jsonPath = path.join(outputDirectory, `${baseName}.json`);
const markdownPath = path.join(outputDirectory, `${baseName}.md`);
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(markdownPath, renderMarkdown(report), "utf8");
process.stdout.write(`${JSON.stringify({
  status: "complete",
  mode: report.mode,
  recommendedMaxConcurrency: report.recommendedMaxConcurrency,
  jsonPath,
  markdownPath,
}, null, 2)}\n`);

type ParsedArgs = Readonly<{
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
}>;

function parseArgs(input: readonly string[]): ParsedArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "mock") {
      flags.add(key);
      continue;
    }
    const value = input[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    if (!["concurrency", "requests", "max-tokens", "timeout-ms", "output-dir"].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    values.set(key, value);
    index += 1;
  }
  return { flags, values };
}

function parseIntegerList(value: string): number[] {
  const result = value.split(",").map((item) => positiveInteger(item, "concurrency"));
  if (result.length === 0) throw new Error("concurrency cannot be empty.");
  return result;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

type NvidiaSnapshot = Readonly<{
  status: "available" | "unavailable";
  sampledAt: string;
  devices: readonly Readonly<Record<string, string | number | null>>[];
  reason?: string;
}>;

async function collectNvidiaSnapshot(): Promise<NvidiaSnapshot> {
  const sampledAt = new Date().toISOString();
  try {
    const { stdout } = await executeFile("nvidia-smi", [
      "--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit",
      "--format=csv,noheader,nounits",
    ], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    const devices = stdout.trim().split(/\r?\n/gu).filter(Boolean).map((line) => {
      const [index, name, temperatureC, utilizationPercent, memoryUsedMiB,
        memoryTotalMiB, powerDrawW, powerLimitW] = line.split(",").map((value) => value.trim());
      return {
        index: numeric(index),
        name: name ?? "unknown",
        temperatureC: numeric(temperatureC),
        utilizationPercent: numeric(utilizationPercent),
        memoryUsedMiB: numeric(memoryUsedMiB),
        memoryTotalMiB: numeric(memoryTotalMiB),
        powerDrawW: numeric(powerDrawW),
        powerLimitW: numeric(powerLimitW),
      };
    });
    return { status: "available", sampledAt, devices };
  } catch (error) {
    return {
      status: "unavailable",
      sampledAt,
      devices: [],
      reason: error instanceof Error && "code" in error ? String(error.code) : "NVIDIA_SMI_FAILED",
    };
  }
}

function numeric(value: string | undefined): number | null {
  if (value === undefined || /^(?:N\/A|\[Not Supported\])$/iu.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderMarkdown(report: typeof benchmark & {
  mode: string;
  host: Readonly<Record<string, string>>;
  providerHealth: typeof health;
  gpu: Readonly<{ before: NvidiaSnapshot; after: NvidiaSnapshot }>;
}): string {
  const rows = report.concurrencyLevels.map((level) =>
    `| ${level.concurrency} | ${level.requests} | ${level.succeeded} | ${level.failed} | ${level.latencyP50Ms ?? "N/A"} | ${level.latencyP95Ms ?? "N/A"} | ${level.requestsPerSecond} | ${level.outputTokensPerSecond} |`,
  );
  return [
    "# AI concurrency benchmark",
    "",
    `- Mode: ${report.mode}`,
    `- Provider: ${report.provider}`,
    `- Measured: ${report.measuredAt}`,
    `- Recommended AI_MAX_CONCURRENCY: ${report.recommendedMaxConcurrency ?? "none"}`,
    `- Warning: ${report.warning}`,
    "",
    "| Concurrency | Requests | Succeeded | Failed | P50 ms | P95 ms | Requests/s | Output tokens/s |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    `Recommendation rule: ${report.recommendationRule}`,
    "",
    "GPU snapshots are stored in the JSON report. Unsupported unified-memory or power fields are `null`, not estimated.",
    "",
  ].join("\n");
}
