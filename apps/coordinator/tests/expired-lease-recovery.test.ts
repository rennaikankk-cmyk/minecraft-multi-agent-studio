import type { AppLogger } from "@minecraft-studio/observability";
import {
  TaskSystemError,
  type RecoverExpiredLeaseResult,
  type TaskLeaseExpireCommand,
  type TaskOutboxRecord,
  type TaskRecord,
} from "@minecraft-studio/task-system";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExpiredLeaseRecoveryController,
  type ExpiredLeaseRecoveryRepository,
} from "../src/expired-lease-recovery.js";

const NOW = "2026-08-11T08:00:00.000Z";
const EXPIRED_AT = "2026-08-11T07:59:00.000Z";
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.useRealTimers());

function task(
  taskId: string,
  status: "assigned" | "running" = "assigned",
): TaskRecord {
  return {
    schemaVersion: "1.0",
    taskId,
    idempotencyScope: "coordinator-main",
    idempotencyKey: `recover-${taskId}`,
    requestFingerprint: "a".repeat(64),
    taskType: "resource.collect",
    handlerVersion: "1.0.0",
    executionIdempotent: true,
    title: "Recover expired lease",
    description: "Coordinator recovery test task.",
    priority: 50,
    status,
    dispatchBotId: "worker-01",
    assignedBotId: "worker-01",
    requiredSkills: [],
    requiredItems: [],
    target: null,
    dependencyIds: [],
    parentTaskId: null,
    createdAt: "2026-08-11T07:50:00.000Z",
    updatedAt: "2026-08-11T07:55:00.000Z",
    startedAt: status === "running" ? "2026-08-11T07:56:00.000Z" : null,
    finishedAt: null,
    deadline: "2026-08-11T09:00:00.000Z",
    timeoutMs: 60_000,
    retryCount: 0,
    maxRetries: 2,
    leaseOwner: "worker-lease-01",
    leaseExpiresAt: EXPIRED_AT,
    riskLevel: "R1",
    failureReason: null,
    result: null,
    evidence: [],
    traceId: `trace-${taskId}`,
    revision: 4,
  };
}

function recovered(input: TaskRecord): RecoverExpiredLeaseResult {
  if (input.status === "running") {
    return {
      task: {
        ...input,
        status: "failed",
        assignedBotId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureReason: "TASK_LEASE_EXPIRED",
        finishedAt: NOW,
        updatedAt: NOW,
        revision: input.revision + 1,
      },
      dispatch: null,
      outbox: null,
    };
  }
  const next: TaskRecord = {
    ...input,
    status: "queued",
    assignedBotId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: NOW,
    revision: input.revision + 1,
  };
  const dispatch = {
    schemaVersion: "1.0" as const,
    messageId: "33333333-3333-4333-8333-333333333333",
    traceId: next.traceId,
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-test" },
    taskId: next.taskId,
    botId: next.dispatchBotId ?? "worker-01",
    type: "task.dispatch.v1" as const,
    payload: {
      expectedRevision: next.revision,
      taskType: next.taskType,
      handlerVersion: next.handlerVersion,
      executionIdempotent: next.executionIdempotent,
    },
  };
  const outbox: TaskOutboxRecord = {
    messageId: dispatch.messageId,
    taskId: next.taskId,
    expectedRevision: next.revision,
    type: "task.dispatch.v1",
    payload: dispatch,
    status: "pending",
    attemptCount: 0,
    availableAt: NOW,
    claimedBy: null,
    claimExpiresAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: null,
  };
  return { task: next, dispatch, outbox };
}

function logger(): AppLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("ExpiredLeaseRecoveryController", () => {
  it("recovers a bounded batch with strict revision-bound commands", async () => {
    const assigned = task(TASK_A);
    const running = task(TASK_B, "running");
    const recoverExpiredLease = vi.fn(
      async (command: TaskLeaseExpireCommand) =>
        recovered(command.taskId === TASK_A ? assigned : running),
    );
    const listExpiredLeases = vi.fn(async () => [assigned, running]);
    const operationIds = [
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ];
    const controller = new ExpiredLeaseRecoveryController({
      repository: { listExpiredLeases, recoverExpiredLease },
      actorId: "coordinator-recovery",
      logger: logger(),
      batchSize: 2,
      operationIdFactory: () => operationIds.shift() ?? "unexpected",
    });

    await expect(controller.sweepOnce()).resolves.toEqual({
      examined: 2,
      requeued: 1,
      failedTerminal: 1,
      skippedConcurrent: 0,
      errors: 0,
    });
    expect(listExpiredLeases).toHaveBeenCalledWith(2);
    expect(recoverExpiredLease.mock.calls.map(([command]) => command)).toEqual([
      {
        schemaVersion: "1.0",
        operationId: "44444444-4444-4444-8444-444444444444",
        taskId: TASK_A,
        expectedRevision: 4,
        actorId: "coordinator-recovery",
        reasonCode: "TASK_LEASE_EXPIRED",
      },
      {
        schemaVersion: "1.0",
        operationId: "55555555-5555-4555-8555-555555555555",
        taskId: TASK_B,
        expectedRevision: 4,
        actorId: "coordinator-recovery",
        reasonCode: "TASK_LEASE_EXPIRED",
      },
    ]);
  });

  it("coalesces overlapping sweeps so the database scan cannot overlap", async () => {
    let resolveScan: ((tasks: readonly TaskRecord[]) => void) | undefined;
    let scanNumber = 0;
    const listExpiredLeases = vi.fn(
      () => {
        scanNumber += 1;
        if (scanNumber > 1) return Promise.resolve([]);
        return new Promise<readonly TaskRecord[]>((resolve) => {
          resolveScan = resolve;
        });
      },
    );
    const repository: ExpiredLeaseRecoveryRepository = {
      listExpiredLeases,
      recoverExpiredLease: vi.fn(),
    };
    const controller = new ExpiredLeaseRecoveryController({
      repository,
      actorId: "coordinator-recovery",
      logger: logger(),
    });

    const first = controller.sweepOnce();
    const overlapping = controller.sweepOnce();
    expect(overlapping).toBe(first);
    expect(listExpiredLeases).toHaveBeenCalledTimes(1);

    resolveScan?.([]);
    await first;
    await controller.sweepOnce();
    expect(listExpiredLeases).toHaveBeenCalledTimes(2);
  });

  it("skips expected races and isolates unexpected failures per task", async () => {
    const assigned = task(TASK_A);
    const running = task(TASK_B, "running");
    const operationLogger = logger();
    const recoverExpiredLease = vi
      .fn<(command: TaskLeaseExpireCommand) => Promise<RecoverExpiredLeaseResult>>()
      .mockRejectedValueOnce(
        new TaskSystemError("TASK_REVISION_CONFLICT", "Task changed."),
      )
      .mockRejectedValueOnce(new Error("database detail must not be logged"));
    const controller = new ExpiredLeaseRecoveryController({
      repository: {
        listExpiredLeases: async () => [assigned, running],
        recoverExpiredLease,
      },
      actorId: "coordinator-recovery",
      logger: operationLogger,
    });

    await expect(controller.sweepOnce()).resolves.toEqual({
      examined: 2,
      requeued: 0,
      failedTerminal: 0,
      skippedConcurrent: 1,
      errors: 1,
    });
    expect(operationLogger.warn).toHaveBeenCalledWith(
      "coordinator_task_lease_recovery_skipped",
      expect.objectContaining({ code: "TASK_REVISION_CONFLICT", taskId: TASK_A }),
    );
    expect(operationLogger.error).toHaveBeenCalledWith(
      "coordinator_task_lease_recovery_failed",
      expect.objectContaining({
        code: "TASK_LEASE_RECOVERY_FAILED",
        taskId: TASK_B,
      }),
    );
    expect(JSON.stringify((operationLogger.error as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain("database detail");
  });

  it("starts immediately, schedules one loop, and stops future scans", async () => {
    vi.useFakeTimers();
    const listExpiredLeases = vi.fn(async () => []);
    const controller = new ExpiredLeaseRecoveryController({
      repository: {
        listExpiredLeases,
        recoverExpiredLease: vi.fn(),
      },
      actorId: "coordinator-recovery",
      logger: logger(),
      intervalMs: 100,
    });

    controller.start();
    controller.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(listExpiredLeases).toHaveBeenCalledTimes(3);

    await controller.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(listExpiredLeases).toHaveBeenCalledTimes(3);
  });

  it("returns a stable failure summary when the bounded scan is unavailable", async () => {
    const operationLogger = logger();
    const controller = new ExpiredLeaseRecoveryController({
      repository: {
        listExpiredLeases: async () => {
          throw new Error("connection string must not be logged");
        },
        recoverExpiredLease: vi.fn(),
      },
      actorId: "coordinator-recovery",
      logger: operationLogger,
    });

    await expect(controller.sweepOnce()).resolves.toEqual({
      examined: 0,
      requeued: 0,
      failedTerminal: 0,
      skippedConcurrent: 0,
      errors: 1,
    });
    expect(operationLogger.error).toHaveBeenCalledWith(
      "coordinator_task_lease_recovery_scan_failed",
      { code: "TASK_LEASE_RECOVERY_FAILED" },
    );
  });
});
