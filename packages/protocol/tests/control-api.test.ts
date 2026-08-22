import { describe, expect, it } from "vitest";

import {
  botDetailResponseV1Schema,
  botListResponseV1Schema,
  botStreamEventV1Schema,
  botStreamSnapshotV1Schema,
  controlApiErrorV1Schema,
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardGoalRequestV1Schema,
  dashboardGoalResponseV1Schema,
  dashboardStopRequestV1Schema,
  stopBotHttpRequestV1Schema,
  stopBotHttpResponseV1Schema,
  submitGoalHttpRequestV1Schema,
  submitGoalHttpResponseV1Schema,
  dashboardTaskDetailResponseV1Schema,
  dashboardTaskListResponseV1Schema,
  publicTaskDetailV1Schema,
  publicTaskSummaryV1Schema,
  taskDetailResponseV1Schema,
  taskListResponseV1Schema,
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
};
const taskSummary = {
  taskId: UUID,
  taskType: "planner.goal",
  title: "Collect nearby wood",
  status: "completed" as const,
  priority: 50,
  riskLevel: "R1" as const,
  botId: "worker-01",
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
  revision: 3,
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

  it("validates bounded goal submission and redacted results", () => {
    const request = {
      schemaVersion: "1.0",
      requestId: UUID,
      botId: "worker-01",
      operatorGoal: "采集附近的木材",
      timeoutMs: 60_000,
    } as const;
    const result = {
      action: "noop",
      botId: "worker-01",
      taskId: UUID,
      reasonCode: "NO_SAFE_SKILL",
      ai: {
        attempts: 1,
        queueTimeMs: 3,
        executionTimeMs: 100,
        totalTimeMs: 103,
      },
    } as const;
    expect(submitGoalHttpRequestV1Schema.parse(request)).toEqual(request);
    expect(
      submitGoalHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: result,
      }).data,
    ).toEqual(result);
    expect(
      dashboardGoalRequestV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        botId: request.botId,
        operatorGoal: request.operatorGoal,
      }).operatorGoal,
    ).toBe(request.operatorGoal);
    expect(
      dashboardGoalResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: result,
      }).data.action,
    ).toBe("noop");
    expect(
      submitGoalHttpRequestV1Schema.safeParse({
        ...request,
        operatorGoal: "bad\u0000goal",
      }).success,
    ).toBe(false);
  });

  it("keeps goal skill results semantically consistent by outcome", () => {
    const completed = {
      action: "skill_result" as const,
      botId: "worker-01",
      taskId: UUID,
      reasonCode: "SKILL_COMPLETED",
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      outcome: "completed" as const,
      ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 2, totalTimeMs: 3 },
    };
    expect(
      submitGoalHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: completed,
      }).data,
    ).toEqual(completed);
    expect(
      submitGoalHttpResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { ...completed, errorCode: "SHOULD_NOT_BE_PRESENT" },
      }).success,
    ).toBe(false);
    expect(
      submitGoalHttpResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { ...completed, errorCode: undefined },
      }).success,
    ).toBe(false);

    const failed = {
      ...completed,
      outcome: "failed" as const,
      errorCode: "SKILL_HANDLER_FAILED",
    };
    expect(
      submitGoalHttpResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: failed,
      }).data,
    ).toEqual(failed);
    expect(
      submitGoalHttpResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { ...completed, outcome: "failed" },
      }).success,
    ).toBe(false);
    expect(
      submitGoalHttpResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { ...failed, errorCode: "not-stable" },
      }).success,
    ).toBe(false);
  });

  it("validates redacted task history summaries and bounded details", () => {
    expect(publicTaskSummaryV1Schema.parse(taskSummary)).toEqual(taskSummary);
    for (const forbidden of ["description", "target", "result", "evidence"] as const) {
      expect(
        publicTaskSummaryV1Schema.safeParse({
          ...taskSummary,
          [forbidden]: forbidden === "evidence" ? [] : "secret",
        }).success,
      ).toBe(false);
    }
    const task = { ...taskSummary, operatorGoal: "采集附近的木材" };
    expect(publicTaskDetailV1Schema.parse(task)).toEqual(task);
    expect(
      publicTaskDetailV1Schema.safeParse({ ...task, result: { raw: true } }).success,
    ).toBe(false);

    const page = {
      generatedAt: NOW,
      tasks: [taskSummary],
      nextCursor: "eyJjcmVhdGVkQXQiOiIyMDI2In0",
    };
    expect(
      taskListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: page,
      }).data.tasks,
    ).toEqual([taskSummary]);
    expect(
      taskDetailResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, task },
      }).data.task.operatorGoal,
    ).toBe(task.operatorGoal);
    expect(
      dashboardTaskListResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { source: "control-api", ...page },
      }).data.source,
    ).toBe("control-api");
    expect(
      dashboardTaskDetailResponseV1Schema.parse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { source: "control-api", generatedAt: NOW, task },
      }).data.task.taskId,
    ).toBe(UUID);
    expect(
      taskListResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { ...page, source: "database" },
      }).success,
    ).toBe(false);
    expect(
      taskDetailResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { generatedAt: NOW, task, internal: true },
      }).success,
    ).toBe(false);
    expect(
      dashboardTaskListResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: { source: "simulated", ...page },
      }).success,
    ).toBe(false);
    expect(
      dashboardTaskDetailResponseV1Schema.safeParse({
        schemaVersion: "1.0",
        requestId: UUID,
        data: {
          source: "control-api",
          generatedAt: NOW,
          task,
          rawResult: true,
        },
      }).success,
    ).toBe(false);
  });
});
