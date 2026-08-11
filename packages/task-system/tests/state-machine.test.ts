import { describe, expect, it } from "vitest";

import {
  TaskSystemError,
  acquireTaskLease,
  expireTaskLease,
  renewTaskLease,
  taskRecordSchema,
  transitionTask,
  type TaskRecord,
} from "../src/index.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const TASK_ID = "11111111-1111-4111-8111-111111111111";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return taskRecordSchema.parse({
    schemaVersion: "1.0",
    taskId: TASK_ID,
    idempotencyScope: "coordinator-main",
    idempotencyKey: "collect-stone-001",
    requestFingerprint: "a".repeat(64),
    taskType: "resource.collect",
    handlerVersion: "1.0.0",
    executionIdempotent: true,
    title: "Collect stone",
    description: "Collect a bounded amount of stone in the isolated world.",
    priority: 50,
    status: "queued",
    assignedBotId: null,
    requiredSkills: [{ skillId: "movement.goto", skillVersion: "1.0.0" }],
    requiredItems: [],
    target: {
      x: 10,
      y: 64,
      z: 10,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-local",
    },
    dependencyIds: [],
    parentTaskId: null,
    createdAt: "2026-07-27T11:59:00.000Z",
    updatedAt: "2026-07-27T11:59:00.000Z",
    startedAt: null,
    finishedAt: null,
    deadline: "2026-07-27T13:00:00.000Z",
    timeoutMs: 60_000,
    retryCount: 0,
    maxRetries: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
    riskLevel: "R1",
    failureReason: null,
    result: null,
    evidence: [],
    traceId: "trace-task-001",
    revision: 0,
    ...overrides,
  });
}

function operationBase(operationId: string, expectedRevision: number) {
  return {
    schemaVersion: "1.0" as const,
    operationId,
    taskId: TASK_ID,
    expectedRevision,
    actorId: "coordinator-agent",
  };
}

describe("task state and lease boundaries", () => {
  it("requires completed dependencies before assigning a bounded lease", () => {
    const command = {
      ...operationBase("22222222-2222-4222-8222-222222222222", 0),
      botId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      leaseDurationMs: 30_000,
    };

    expect(() =>
      acquireTaskLease(task(), command, {
        now: NOW,
        dependenciesReady: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_DEPENDENCIES_INCOMPLETE",
      }),
    );

    expect(
      acquireTaskLease(task(), command, {
        now: NOW,
        dependenciesReady: true,
      }),
    ).toMatchObject({
      status: "assigned",
      assignedBotId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      leaseExpiresAt: "2026-07-27T12:00:30.000Z",
      revision: 1,
    });
  });

  it("caps acquired and renewed leases at the task deadline", () => {
    const deadline = "2026-07-27T12:00:10.000Z";
    const acquired = acquireTaskLease(
      task({ deadline }),
      {
        ...operationBase("12121212-1212-4212-8212-121212121212", 0),
        botId: "worker-01",
        leaseOwner: "coordinator-lease-01",
        leaseDurationMs: 30_000,
      },
      { now: NOW, dependenciesReady: true },
    );
    expect(acquired.leaseExpiresAt).toBe(deadline);

    const renewed = renewTaskLease(
      task({
        deadline,
        status: "assigned",
        assignedBotId: "worker-01",
        leaseOwner: "coordinator-lease-01",
        leaseExpiresAt: "2026-07-27T12:00:05.000Z",
        revision: 1,
      }),
      {
        ...operationBase("13131313-1313-4313-8313-131313131313", 1),
        leaseOwner: "coordinator-lease-01",
        leaseDurationMs: 30_000,
      },
      NOW,
    );
    expect(renewed.leaseExpiresAt).toBe(deadline);
  });

  it("keeps the lease while starting and releases it on completion", () => {
    const assigned = task({
      status: "assigned",
      assignedBotId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      leaseExpiresAt: "2026-07-27T12:01:00.000Z",
      revision: 1,
    });
    const running = transitionTask(
      assigned,
      {
        ...operationBase("33333333-3333-4333-8333-333333333333", 1),
        to: "running",
        reasonCode: "TASK_STARTED",
        leaseOwner: "coordinator-lease-01",
        failureReason: null,
        result: null,
        evidence: [],
      },
      NOW,
    );
    expect(running).toMatchObject({
      status: "running",
      assignedBotId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      revision: 2,
      startedAt: NOW.toISOString(),
    });

    const completed = transitionTask(
      running,
      {
        ...operationBase("44444444-4444-4444-8444-444444444444", 2),
        to: "completed",
        reasonCode: "TASK_COMPLETED",
        leaseOwner: "coordinator-lease-01",
        failureReason: null,
        result: { collected: 16 },
        evidence: [{ kind: "trace", reference: "trace-task-001" }],
      },
      new Date("2026-07-27T12:00:10.000Z"),
    );
    expect(completed).toMatchObject({
      status: "completed",
      assignedBotId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: { collected: 16 },
      revision: 3,
    });
  });

  it("rejects wrong lease owners, stale revisions and exhausted retries", () => {
    const running = task({
      status: "running",
      assignedBotId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      leaseExpiresAt: "2026-07-27T12:01:00.000Z",
      revision: 2,
      startedAt: "2026-07-27T11:59:30.000Z",
    });
    const completeCommand = {
      ...operationBase("55555555-5555-4555-8555-555555555555", 2),
      to: "completed" as const,
      reasonCode: "TASK_COMPLETED",
      leaseOwner: "other-owner",
      failureReason: null,
      result: null,
      evidence: [],
    };
    expect(() => transitionTask(running, completeCommand, NOW)).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_LEASE_OWNER_MISMATCH",
      }),
    );
    expect(() =>
      transitionTask(
        running,
        { ...completeCommand, expectedRevision: 1 },
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_REVISION_CONFLICT",
      }),
    );

    const failed = task({
      status: "failed",
      retryCount: 2,
      maxRetries: 2,
      failureReason: "PATHFINDER_GOTO_FAILED",
      finishedAt: "2026-07-27T11:59:30.000Z",
      revision: 3,
    });
    expect(() =>
      transitionTask(
        failed,
        {
          ...operationBase("66666666-6666-4666-8666-666666666666", 3),
          to: "queued",
          reasonCode: "TASK_RETRY_REQUESTED",
          leaseOwner: null,
          failureReason: null,
          result: null,
          evidence: [],
        },
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_RETRY_EXHAUSTED",
      }),
    );
  });

  it("rejects completion at or after the execution timeout", () => {
    const running = task({
      status: "running",
      assignedBotId: "worker-01",
      leaseOwner: "coordinator-lease-01",
      leaseExpiresAt: "2026-07-27T12:01:00.000Z",
      startedAt: "2026-07-27T11:59:00.000Z",
      timeoutMs: 60_000,
      revision: 2,
    });

    expect(() =>
      transitionTask(
        running,
        {
          ...operationBase("14141414-1414-4414-8414-141414141414", 2),
          to: "completed",
          reasonCode: "TASK_COMPLETED",
          leaseOwner: "coordinator-lease-01",
          failureReason: null,
          result: { collected: 16 },
          evidence: [],
        },
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_TIMEOUT_EXPIRED",
      }),
    );
  });

  it("moves an expired running lease to a traceable failure", () => {
    const expired = expireTaskLease(
      task({
        status: "running",
        assignedBotId: "worker-01",
        leaseOwner: "coordinator-lease-01",
        leaseExpiresAt: "2026-07-27T11:59:59.000Z",
        startedAt: "2026-07-27T11:59:00.000Z",
        revision: 2,
      }),
      {
        ...operationBase("77777777-7777-4777-8777-777777777777", 2),
        reasonCode: "TASK_LEASE_EXPIRED",
      },
      NOW,
    );

    expect(expired).toMatchObject({
      status: "failed",
      assignedBotId: null,
      leaseOwner: null,
      failureReason: "TASK_LEASE_EXPIRED",
      finishedAt: NOW.toISOString(),
      revision: 3,
    });
  });

  it("lets the exact lease owner persist deadline expiry after the lease boundary", () => {
    const expired = transitionTask(
      task({
        status: "running",
        assignedBotId: "worker-01",
        leaseOwner: "coordinator-lease-01",
        leaseExpiresAt: "2026-07-27T12:00:00.000Z",
        startedAt: "2026-07-27T11:59:30.000Z",
        deadline: "2026-07-27T12:00:00.000Z",
        revision: 2,
      }),
      {
        ...operationBase("79797979-7979-4979-8979-797979797979", 2),
        to: "expired",
        reasonCode: "TASK_DEADLINE_EXPIRED",
        leaseOwner: "coordinator-lease-01",
        failureReason: null,
        result: null,
        evidence: [],
      },
      NOW,
    );

    expect(expired).toMatchObject({
      status: "expired",
      assignedBotId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: NOW.toISOString(),
      revision: 3,
    });
  });

  it("keeps R3 and R4 tasks unassigned until trusted approval exists", () => {
    expect(() =>
      acquireTaskLease(
        task({ riskLevel: "R4" }),
        {
          ...operationBase("88888888-8888-4888-8888-888888888888", 0),
          botId: "worker-01",
          leaseOwner: "coordinator-lease-01",
          leaseDurationMs: 30_000,
        },
        { now: NOW, dependenciesReady: true },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<TaskSystemError>>({
        code: "TASK_RISK_APPROVAL_REQUIRED",
      }),
    );
  });
});
