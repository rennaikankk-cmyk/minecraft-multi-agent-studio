import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DashboardControlError,
  fetchDashboardAiMetrics,
  fetchDashboardBots,
  loadDashboardControlConfig,
  requestDashboardBotStop,
  verifyStopConfirmation,
} from "../lib/control-api-client";

const TOKEN = "dashboard-test-token-000000000000000001";
const NOW = "2026-07-20T08:00:00.000Z";
const UUID = "11111111-1111-4111-8111-111111111111";

describe("Dashboard Control API client", () => {
  it("only accepts a loopback Control API and a server-only token", () => {
    expect(
      loadDashboardControlConfig({
        DASHBOARD_CONTROL_API_URL: "http://127.0.0.1:3210",
        DASHBOARD_CONTROL_API_TOKEN: TOKEN,
      }).baseUrl,
    ).toBe("http://127.0.0.1:3210");
    expect(() =>
      loadDashboardControlConfig({
        DASHBOARD_CONTROL_API_URL: "https://example.com",
        DASHBOARD_CONTROL_API_TOKEN: TOKEN,
      }),
    ).toThrowError(DashboardControlError);
    expect(() =>
      loadDashboardControlConfig({ DASHBOARD_CONTROL_API_URL: "http://127.0.0.1:3210" }),
    ).toThrowError(/访问令牌/u);
  });

  it("reads and validates real list/detail responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/bots")) {
        return jsonResponse({
          schemaVersion: "1.0",
          requestId: UUID,
          data: { generatedAt: NOW, bots: [summary()] },
        });
      }
      return jsonResponse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, bot: detail() },
      });
    });
    const result = await fetchDashboardBots(config(), fetcher);
    expect(result.bots).toEqual([detail()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a detail that does not match the list identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/v1/bots")) {
        return jsonResponse({
          schemaVersion: "1.0",
          requestId: UUID,
          data: { generatedAt: NOW, bots: [summary()] },
        });
      }
      return jsonResponse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, bot: { ...detail(), botId: "other-bot" } },
      });
    });
    await expect(fetchDashboardBots(config(), fetcher)).rejects.toMatchObject({
      code: "INVALID_CONTROL_RESPONSE",
    });
  });

  it("verifies the local stop code with its SHA-256 only", () => {
    const confirmationCode = "safe-stop-123";
    const stopConfig = {
      ...config(),
      stopConfirmationSha256: createHash("sha256")
        .update(confirmationCode)
        .digest("hex"),
    };
    expect(verifyStopConfirmation(stopConfig, confirmationCode)).toBe(true);
    expect(verifyStopConfirmation(stopConfig, "wrong-code")).toBe(false);
  });

  it("preserves and validates the stop trace across Control API", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: "22222222-2222-4222-8222-222222222222",
      data: {
        botId: "worker-01",
        traceId: UUID,
        commandId: UUID,
        outcome: "completed",
        errorCode: null,
      },
    }));
    const result = await requestDashboardBotStop(
      config(),
      "worker-01",
      UUID,
      fetcher,
    );
    expect(result.data.traceId).toBe(UUID);
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
  });

  it("reads strict AI metrics without exposing the Spark endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:3210/v1/ai/metrics");
      return jsonResponse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: aiMetrics(),
      });
    });
    await expect(fetchDashboardAiMetrics(config(), fetcher)).resolves.toEqual(aiMetrics());
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
    });
  });
});

function config() {
  return {
    baseUrl: "http://127.0.0.1:3210",
    token: TOKEN,
    stopConfirmationSha256: null,
  } as const;
}

function summary() {
  return {
    botId: "worker-01",
    connectionState: "online" as const,
    lastMessageAt: NOW,
    lastHeartbeatAt: NOW,
    lastStatusAt: NOW,
  };
}

function detail() {
  return {
    ...summary(),
    health: { current: 18, maximum: 20 },
    food: { level: 16, saturation: 4 },
    armorPoints: 4,
    latencyMs: 22,
    currentTask: null,
    safety: {
      mode: "monitoring" as const,
      activeRisks: [],
      normalTasksPaused: false,
      lastDecisionId: "l0-dashboard-test",
      lastAction: null,
    },
    position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
    positionRedacted: false,
    minecraftVersion: null,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function aiMetrics() {
  return {
    schemaVersion: "1.0" as const,
    nodeName: "MSI DGX Spark",
    status: "online" as const,
    sampledAt: NOW,
    backend: "vllm" as const,
    backendVersion: "0.15.0",
    quantization: "modelopt_fp4",
    models: ["qwen3.8-27b-nvfp4"],
    networkRttMs: 2,
    runningRequests: 2,
    waitingRequests: 1,
    maxConcurrency: 10,
    kvCacheUsagePercent: 42,
    promptTokensPerSecond: 120,
    generationTokensPerSecond: 40,
    promptTokensTotal: 1_000,
    generationTokensTotal: 400,
    successfulRequestsTotal: 20,
    ttft: { p50Ms: 100, p95Ms: 500, p99Ms: 800 },
    tpot: { p50Ms: 20, p95Ms: 50, p99Ms: 80 },
    queueLatency: { p50Ms: 0, p95Ms: 20, p99Ms: 50 },
    endToEndLatency: { p50Ms: 500, p95Ms: 1_000, p99Ms: 2_000 },
    errorRate: null,
    errorCodes: [],
  };
}
