import { describe, expect, it } from "vitest";

import { SparkMetricsCollector } from "../src/index.js";

const METRICS_FIRST = `
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="qwen"} 2
vllm:num_requests_waiting{model_name="qwen"} 1
vllm:kv_cache_usage_perc{model_name="qwen"} 0.42
vllm:prompt_tokens_total{model_name="qwen"} 100
vllm:generation_tokens_total{model_name="qwen"} 40
vllm:request_success_total{finish_reason="stop",model_name="qwen"} 4
vllm:request_success_total{finished_reason="error",model_name="qwen"} 1
vllm:request_success_total{finished_reason="abort",model_name="qwen"} 2
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="qwen"} 2
vllm:time_to_first_token_seconds_bucket{le="0.5",model_name="qwen"} 4
vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="qwen"} 4
vllm:request_time_per_output_token_seconds_bucket{le="0.02",model_name="qwen"} 3
vllm:request_time_per_output_token_seconds_bucket{le="0.05",model_name="qwen"} 4
vllm:request_time_per_output_token_seconds_bucket{le="+Inf",model_name="qwen"} 4
`;

describe("SparkMetricsCollector", () => {
  it("collects documented vLLM endpoints without inventing missing metrics", async () => {
    let now = new Date("2026-08-20T10:00:00.000Z");
    let metrics = METRICS_FIRST;
    const collector = new SparkMetricsCollector({
      baseUrl: "http://127.0.0.1:8000/v1",
      maxConcurrency: 10,
      now: () => now,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/health")) return new Response("", { status: 200 });
        if (url.endsWith("/v1/models")) {
          return Response.json({ data: [{ id: "qwen3.8-27b-nvfp4" }] });
        }
        if (url.endsWith("/metrics")) return new Response(metrics, { status: 200 });
        if (url.endsWith("/version")) return Response.json({ version: "0.15.0" });
        return new Response("", { status: 404 });
      },
    });

    const first = await collector.collect();
    expect(first).toMatchObject({
      status: "online",
      backend: "vllm",
      backendVersion: "0.15.0",
      quantization: null,
      models: ["qwen3.8-27b-nvfp4"],
      runningRequests: 2,
      waitingRequests: 1,
      maxConcurrency: 10,
      kvCacheUsagePercent: 42,
      promptTokensTotal: 100,
      generationTokensTotal: 40,
      successfulRequestsTotal: 4,
      promptTokensPerSecond: null,
      generationTokensPerSecond: null,
      ttft: { p50Ms: 100, p95Ms: 500, p99Ms: 500 },
      tpot: { p50Ms: 20, p95Ms: 50, p99Ms: 50 },
      errorRate: 0.143,
      errorCodes: [],
    });

    now = new Date("2026-08-20T10:00:02.000Z");
    metrics = METRICS_FIRST
      .replace("prompt_tokens_total{model_name=\"qwen\"} 100", "prompt_tokens_total{model_name=\"qwen\"} 140")
      .replace("generation_tokens_total{model_name=\"qwen\"} 40", "generation_tokens_total{model_name=\"qwen\"} 60");
    const second = await collector.collect();
    expect(second.promptTokensPerSecond).toBe(20);
    expect(second.generationTokensPerSecond).toBe(10);
  });

  it("reports an unavailable node and stable endpoint errors", async () => {
    const collector = new SparkMetricsCollector({
      baseUrl: "http://127.0.0.1:8000",
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(collector.collect()).resolves.toMatchObject({
      status: "starting",
      models: [],
      runningRequests: null,
      ttft: { p50Ms: null, p95Ms: null, p99Ms: null },
      errorCodes: [
        "HEALTH_HTTP_503",
        "METRICS_HTTP_503",
        "MODELS_HTTP_503",
        "VERSION_HTTP_503",
      ],
    });
  });

  it("rejects credential, query, and arbitrary-path base URLs", () => {
    expect(() => new SparkMetricsCollector({ baseUrl: "http://user:pass@127.0.0.1:8000" })).toThrow();
    expect(() => new SparkMetricsCollector({ baseUrl: "http://127.0.0.1:8000?token=x" })).toThrow();
    expect(() => new SparkMetricsCollector({ baseUrl: "http://127.0.0.1:8000/admin" })).toThrow();
  });
});
