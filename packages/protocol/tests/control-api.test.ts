import { describe, expect, it } from "vitest";

import {
  botDetailResponseV1Schema,
  aiNodeMetricsHttpResponseV1Schema,
  botListResponseV1Schema,
  botStreamEventV1Schema,
  botStreamSnapshotV1Schema,
  controlApiErrorV1Schema,
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardStopRequestV1Schema,
  executeTeamTaskHttpRequestV1Schema,
  executeTeamTaskHttpResponseV1Schema,
  stopBotHttpRequestV1Schema,
  stopBotHttpResponseV1Schema,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-20T06:00:00.000Z";
const summary = {
  botId: "worker-01",
  connectionState: "online" as const,
  lastMessageAt: NOW,
  lastHeartbeatAt: NOW,
  lastStatusAt: NOW,
};
const detail = {
  ...summary,
  health: { current: 20, maximum: 20 },
  food: { level: 20, saturation: 5 },
  armorPoints: 0,
  latencyMs: 12,
  currentTask: null,
  position: null,
  positionRedacted: true,
  minecraftVersion: null,
  aiPerformance: {
    state: "completed" as const,
    observedAt: NOW,
    botId: "worker-01",
    requestId: UUID,
    taskId: null,
    taskType: "planner",
    provider: "spark-vllm",
    model: "qwen3.8-27b-nvfp4",
    queueTimeMs: 3,
    providerQueueTimeMs: 1,
    totalLatencyMs: 100,
    timeToFirstTokenMs: 40,
    generationTimeMs: 50,
    meanInterTokenLatencyMs: 5,
    generationTokensPerSecond: 20,
    promptTokens: 100,
    outputTokens: 10,
    errorCode: null,
  },
};

describe("Control API v1 protocol", () => {
  it("validates versioned list and detail responses", () => {
    expect(
      botListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, bots: [summary] },
      }).data.bots,
    ).toEqual([summary]);
    expect(
      botDetailResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, bot: detail },
      }).data.bot.positionRedacted,
    ).toBe(true);
  });

  it("rejects unknown response fields and protocol versions", () => {
    expect(
      botListResponseV1Schema.safeParse({
        schemaVersion: "2.0",
        requestId: UUID,
        data: { generatedAt: NOW, bots: [] },
      }).success,
    ).toBe(false);
    expect(
      botDetailResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, bot: { ...detail, serverHost: "secret" } },
      }).success,
    ).toBe(false);
  });

  it("validates snapshot-before-increment stream messages", () => {
    expect(
      botStreamSnapshotV1Schema.parse({
        schemaVersion: "1.0",
        messageId: UUID,
        timestamp: NOW,
        streamSequence: 2,
        type: "bot.stream.snapshot.v1",
        payload: { bots: [detail] },
      }).type,
    ).toBe("bot.stream.snapshot.v1");
    expect(
      botStreamEventV1Schema.parse({
        schemaVersion: "1.0",
        messageId: UUID,
        timestamp: NOW,
        streamSequence: 3,
        type: "bot.stream.event.v1",
        payload: { event: "upsert", bot: detail },
      }).streamSequence,
    ).toBe(3);
  });

  it("only accepts stable public error codes", () => {
    expect(
      controlApiErrorV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
      }).error.code,
    ).toBe("AUTH_REQUIRED");
    expect(
      controlApiErrorV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        error: { code: "RAW_SERVER_ERROR", message: "secret" },
      }).success,
    ).toBe(false);
  });

  it("validates confirmed stop requests and redacted stop results", () => {
    expect(
      stopBotHttpRequestV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        confirmation: "confirmed",
      }).confirmation,
    ).toBe("confirmed");
    expect(
      stopBotHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          botId: "worker-01",
          traceId: UUID,
          commandId: UUID,
          outcome: "completed",
          errorCode: null,
        },
      }).data.outcome,
    ).toBe("completed");
    expect(
      stopBotHttpRequestV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        confirmation: "yes",
      }).success,
    ).toBe(false);
  });

  it("validates the Dashboard real-source boundary", () => {
    expect(
      dashboardBotListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          source: "control-api",
          generatedAt: NOW,
          bots: [detail],
          capabilities: { stopConfirmationConfigured: true },
        },
      }).data.source,
    ).toBe("control-api");
    expect(
      dashboardStopRequestV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        confirmationCode: "short",
      }).success,
    ).toBe(false);
    expect(
      dashboardApiErrorV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        error: {
          code: "CONTROL_API_UNAVAILABLE",
          message: "Control API is unavailable.",
        },
      }).error.code,
    ).toBe("CONTROL_API_UNAVAILABLE");
  });

  it("strictly binds a team task to its objective, lease, and selected Bot", () => {
    const request = executeTeamTaskHttpRequestV1Schema.parse({
      schemaVersion: "1.0",
      requestId: UUID,
      objective: {
        objectiveId: "objective-01",
        serverProfileId: "survival-01",
        title: "Prepare the work site",
        maxBots: 5,
        preferredRoles: ["infrastructure", "logistics"],
      },
      assignment: {
        taskId: "team-task-01",
        objectiveId: "objective-01",
        requiredSkills: ["movement.goto"],
        preferredRoles: ["infrastructure"],
        claims: [{ kind: "named", key: "work-site" }],
        leaseMs: 60_000,
      },
      task: "Move to the work site",
      taskVersion: 1,
      priority: 50,
    });
    expect(request.objective.maxBots).toBe(5);
    expect(
      executeTeamTaskHttpRequestV1Schema.safeParse({
        ...request,
        assignment: { ...request.assignment, objectiveId: "objective-02" },
      }).success,
    ).toBe(false);

    const response = executeTeamTaskHttpResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId: UUID,
      data: {
        objectiveId: "objective-01",
        taskId: "team-task-01",
        operationId: UUID,
        plannerRequestId: "22222222-2222-4222-8222-222222222222",
        assignment: {
          taskId: "team-task-01",
          objectiveId: "objective-01",
          serverProfileId: "survival-01",
          botId: "worker-01",
          role: "infrastructure",
          requiredSkills: ["movement.goto"],
          claims: [{ kind: "named", key: "work-site" }],
          assignedAt: NOW,
          leaseExpiresAt: "2026-07-20T06:01:00.000Z",
        },
        action: "wait",
        provider: "spark-vllm",
        model: "qwen3.8-27b-nvfp4",
        reason: "State is insufficient.",
        confidence: 0.7,
      },
    });
    expect(response.data.assignment.botId).toBe("worker-01");
  });

  it("validates nullable evidence-backed AI node metrics", () => {
    const response = aiNodeMetricsHttpResponseV1Schema.parse({
      schemaVersion: "1.0",
      requestId: UUID,
      data: {
        schemaVersion: "1.0",
        nodeName: "MSI DGX Spark",
        status: "online",
        sampledAt: NOW,
        backend: "vllm",
        backendVersion: "0.15.0",
        quantization: "modelopt_fp4",
        models: ["qwen3.8-27b-nvfp4"],
        networkRttMs: 2,
        runningRequests: 2,
        waitingRequests: 1,
        maxConcurrency: 10,
        kvCacheUsagePercent: 42,
        promptTokensPerSecond: null,
        generationTokensPerSecond: null,
        promptTokensTotal: 100,
        generationTokensTotal: 40,
        successfulRequestsTotal: 4,
        ttft: { p50Ms: 100, p95Ms: 500, p99Ms: 500 },
        tpot: { p50Ms: 20, p95Ms: 50, p99Ms: 50 },
        queueLatency: { p50Ms: null, p95Ms: null, p99Ms: null },
        endToEndLatency: { p50Ms: null, p95Ms: null, p99Ms: null },
        errorRate: null,
        errorCodes: [],
      },
    });
    expect(response.data.promptTokensPerSecond).toBeNull();
    expect(
      aiNodeMetricsHttpResponseV1Schema.safeParse({
        ...response,
        data: { ...response.data, kvCacheUsagePercent: 101 },
      }).success,
    ).toBe(false);
  });
});
