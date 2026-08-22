import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  DashboardControlError,
  fetchDashboardBots,
  fetchDashboardTaskDetail,
  fetchDashboardTasks,
  loadDashboardControlConfig,
  requestDashboardBotStop,
  requestDashboardGoal,
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

  it("reads a bounded task page without exposing redacted task fields", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:3210/v1/tasks?limit=25&status=running&botId=worker-01",
      );
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Studio-Schema-Version": "1.0",
      });
      return jsonResponse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          generatedAt: NOW,
          tasks: [taskSummary()],
          nextCursor: null,
        },
      });
    });

    await expect(fetchDashboardTasks(config(), {
      limit: 25,
      cursor: null,
      status: "running",
      botId: "worker-01",
    }, fetcher)).resolves.toEqual({
      generatedAt: NOW,
      tasks: [taskSummary()],
      nextCursor: null,
    });
  });

  it("reads task detail and rejects a mismatched task identity", async () => {
    const validFetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: UUID,
      data: {
        generatedAt: NOW,
        task: { ...taskSummary(), operatorGoal: "采集附近的木材" },
      },
    }));
    await expect(
      fetchDashboardTaskDetail(config(), UUID, validFetcher),
    ).resolves.toMatchObject({
      task: { taskId: UUID, operatorGoal: "采集附近的木材" },
    });

    const mismatchFetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: UUID,
      data: {
        generatedAt: NOW,
        task: {
          ...taskSummary(),
          taskId: "22222222-2222-4222-8222-222222222222",
          operatorGoal: null,
        },
      },
    }));
    await expect(
      fetchDashboardTaskDetail(config(), UUID, mismatchFetcher),
    ).rejects.toMatchObject({ code: "INVALID_CONTROL_RESPONSE" });
  });

  it("maps explicit task-history availability and not-found errors", async () => {
    const unavailableFetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: UUID,
      error: {
        code: "TASK_HISTORY_UNAVAILABLE",
        message: "private upstream detail",
      },
    }, 503));
    await expect(fetchDashboardTasks(config(), {
      limit: 25,
      cursor: null,
      status: null,
      botId: null,
    }, unavailableFetcher)).rejects.toMatchObject({
      code: "TASK_HISTORY_UNAVAILABLE",
      httpStatus: 503,
      upstreamCode: "TASK_HISTORY_UNAVAILABLE",
      message: "任务历史后端当前不可用。",
    });

    const notFoundFetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: UUID,
      error: { code: "TASK_NOT_FOUND", message: "private upstream detail" },
    }, 404));
    await expect(
      fetchDashboardTaskDetail(config(), UUID, notFoundFetcher),
    ).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
      httpStatus: 404,
      upstreamCode: "TASK_NOT_FOUND",
      message: "未找到该任务。",
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

  it("submits a bounded goal and validates its Bot/task identity", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "1.0",
        requestId: UUID,
        botId: "worker-01",
        operatorGoal: "采集附近的木材",
        timeoutMs: 120_000,
      });
      return jsonResponse({
        schemaVersion: "1.0",
        requestId: "22222222-2222-4222-8222-222222222222",
        data: {
          action: "noop",
          botId: "worker-01",
          taskId: UUID,
          reasonCode: "NO_SAFE_SKILL",
          ai: {
            attempts: 1,
            queueTimeMs: 2,
            executionTimeMs: 98,
            totalTimeMs: 100,
          },
        },
      });
    });

    await expect(requestDashboardGoal(config(), {
      requestId: UUID,
      botId: "worker-01",
      operatorGoal: "采集附近的木材",
    }, fetcher)).resolves.toMatchObject({
      action: "noop",
      taskId: UUID,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(125_000);
  });

  it.each([
    ["AI_QUEUE_FULL", 429, "RATE_LIMITED", 429],
    ["AI_UNAVAILABLE", 503, "CONTROL_API_UNAVAILABLE", 503],
    ["GOAL_TIMEOUT", 504, "GOAL_FAILED", 504],
    ["GOAL_REJECTED", 409, "CONTROL_API_REJECTED", 409],
  ] as const)(
    "maps upstream %s without losing HTTP semantics",
    async (upstreamCode, upstreamStatus, dashboardCode, dashboardStatus) => {
      const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
        schemaVersion: "1.0",
        requestId: "22222222-2222-4222-8222-222222222222",
        error: { code: upstreamCode, message: "bounded upstream error" },
      }, upstreamStatus));

      await expect(requestDashboardGoal(config(), {
        requestId: UUID,
        botId: "worker-01",
        operatorGoal: "采集附近的木材",
      }, fetcher)).rejects.toMatchObject({
        code: dashboardCode,
        httpStatus: dashboardStatus,
        upstreamCode,
      });
    },
  );

  it("rejects an invalid goal response identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({
      schemaVersion: "1.0",
      requestId: "22222222-2222-4222-8222-222222222222",
      data: {
        action: "noop",
        botId: "other-bot",
        taskId: UUID,
        reasonCode: "NO_SAFE_SKILL",
        ai: {
          attempts: 1,
          queueTimeMs: 2,
          executionTimeMs: 98,
          totalTimeMs: 100,
        },
      },
    }));

    await expect(requestDashboardGoal(config(), {
      requestId: UUID,
      botId: "worker-01",
      operatorGoal: "采集附近的木材",
    }, fetcher)).rejects.toMatchObject({
      code: "INVALID_CONTROL_RESPONSE",
      httpStatus: 502,
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

function taskSummary() {
  return {
    taskId: UUID,
    taskType: "operator.goal",
    title: "采集木材",
    status: "running" as const,
    priority: 50,
    riskLevel: "R1" as const,
    botId: "worker-01",
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    revision: 1,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
