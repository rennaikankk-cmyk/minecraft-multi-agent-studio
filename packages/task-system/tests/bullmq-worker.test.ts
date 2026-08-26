import { describe, expect, it, vi } from "vitest";

import {
  taskDispatchV1Schema,
  type TaskDispatchV1,
} from "@minecraft-studio/protocol";

import {
  taskDispatchJobId,
  TaskQueueError,
} from "../src/bullmq-queue.js";
import {
  TaskHandlerRegistry,
  TaskWorkerError,
} from "../src/bullmq-worker.js";
import {
  taskCancelCommandSchema,
  taskRecordSchema,
  type TaskRecord,
} from "../src/model.js";
import { BullMqTaskWorker } from "../src/bullmq-worker.js";
import type { PostgresTaskRepository } from "../src/postgres-repository.js";

describe("BullMQ task boundaries", () => {
  it("creates stable BullMQ-safe job IDs without colons", () => {
    expect(
      taskDispatchJobId(
        "2a7f5a33-05c7-4336-a037-27c196256978",
        42,
      ),
    ).toBe("2a7f5a33-05c7-4336-a037-27c196256978-r42");
    expect(() => taskDispatchJobId("not-a-uuid", 0)).toThrow(
      TaskQueueError,
    );
  });

  it("registers exact deterministic handlers without fallback", () => {
    const registry = new TaskHandlerRegistry();
    const handler = {
      taskType: "test.wait",
      handlerVersion: "1.0.0",
      idempotent: true,
      execute: async () => ({ result: null, evidence: [] }),
    } as const;
    registry.register(handler);
    registry.register({ ...handler, handlerVersion: "2.0.0" });

    expect(registry.get("test.wait", "1.0.0")).toBeTruthy();
    expect(registry.get("test.wait", "2.0.0")).toBeTruthy();
    expect(registry.get("test.wait", "3.0.0")).toBeNull();
    expect(() => registry.register(handler)).toThrowError(
      expect.objectContaining<TaskWorkerError>({
        code: "TASK_HANDLER_ALREADY_REGISTERED",
      }),
    );
  });

  it("validates durable cancellation without a race-prone revision field", () => {
    const command = {
      schemaVersion: "1.0",
      operationId: "8aab3bdd-5eb0-44c4-9be5-52ad9245e866",
      taskId: "55da44dd-f3e8-43fc-a48d-d82921e46f80",
      actorId: "trusted-task-worker",
      leaseOwner: "worker-instance-a",
      reasonCode: "TASK_CANCELLED_BY_OPERATOR",
    };
    expect(taskCancelCommandSchema.parse(command)).toEqual(command);
    expect(() =>
      taskCancelCommandSchema.parse({
        ...command,
        expectedRevision: 4,
      }),
    ).toThrow();
  });

  it.each(["completed", "cancelled", "expired"] as const)(
    "persists a handler-provided %s terminal state without acquiring a second lease",
    async (terminal) => {
    const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const assignmentLeaseOwner = "coordinator-assignment-01";
    let current: TaskRecord = taskRecordSchema.parse({
      schemaVersion: "1.0",
      taskId,
      idempotencyScope: "worker-test",
      idempotencyKey: "assignment-test-01",
      requestFingerprint: "a".repeat(64),
      taskType: "test.assignment",
      handlerVersion: "1.0.0",
      executionIdempotent: true,
      title: "Preassigned task",
      description: "Task-system assignment test.",
      priority: 50,
      status: "assigned",
      dispatchBotId: "worker-01",
      assignedBotId: "worker-01",
      requiredSkills: [],
      requiredItems: [],
      target: null,
      dependencyIds: [],
      parentTaskId: null,
      createdAt: "2026-08-22T08:00:00.000Z",
      updatedAt: "2026-08-22T08:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      deadline: null,
      timeoutMs: 60_000,
      retryCount: 0,
      maxRetries: 0,
      leaseOwner: assignmentLeaseOwner,
      leaseExpiresAt: "2099-08-22T08:00:00.000Z",
      riskLevel: "R1",
      failureReason: null,
      result: null,
      evidence: [],
      traceId: "trace-assignment-test",
      revision: 1,
    });
    const dispatch: TaskDispatchV1 = taskDispatchV1Schema.parse({
      schemaVersion: "1.0",
      messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      traceId: current.traceId,
      timestamp: "2026-08-22T08:00:00.000Z",
      source: { service: "coordinator", instanceId: "coordinator-test" },
      taskId,
      botId: "worker-01",
      type: "task.dispatch.v1",
      payload: {
        expectedRevision: 1,
        taskType: current.taskType,
        handlerVersion: current.handlerVersion,
        executionIdempotent: true,
        assignmentLeaseOwner,
      },
    });
    const acquireLease = vi.fn(async () => {
      throw new Error("worker must not acquire a preassigned lease");
    });
    const transition = vi.fn(async (input: { to: TaskRecord["status"] }) => {
      const becomesTerminal = [
        "completed",
        "failed",
        "cancelled",
        "expired",
      ].includes(input.to);
      current = taskRecordSchema.parse({
        ...current,
        status: input.to,
        revision: current.revision + 1,
        startedAt:
          input.to === "running"
            ? "2026-08-22T08:00:01.000Z"
            : current.startedAt,
        updatedAt: "2026-08-22T08:00:01.000Z",
        ...(becomesTerminal
          ? {
              assignedBotId: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              finishedAt: "2026-08-22T08:00:01.000Z",
            }
          : {}),
      });
      return current;
    });
    const repository = {
      getTask: vi.fn(async () => current),
      getTaskCancellationRequest: vi.fn(async () => null),
      getDatabaseTime: vi.fn(async () => new Date("2026-08-22T08:00:01.000Z")),
      acquireLease,
      transition,
    } as unknown as PostgresTaskRepository;
    const handlers = new TaskHandlerRegistry();
    handlers.register({
      taskType: current.taskType,
      handlerVersion: current.handlerVersion,
      idempotent: true,
      execute: async () => ({
        result: { ok: true },
        evidence: [],
        terminal: { status: terminal },
      }),
    });
    const worker = new BullMqTaskWorker(repository, handlers, {
      redisUrl: "redis://127.0.0.1:6399/0",
      queueName: "studio_tasks_v1",
      prefix: "task-system-test",
      instanceId: "worker-test",
      concurrency: 1,
      leaseDurationMs: 5_000,
      renewIntervalMs: 2_000,
      lockDurationMs: 10_000,
      stalledIntervalMs: 1_000,
      cancellationWaitMs: 1_000,
      cancellationPollIntervalMs: 100,
    });

    const job = {
      id: `${taskId}-r1`,
      name: "task.dispatch.v1",
      attemptsStarted: 1,
      data: dispatch,
    };
    const result = await (
      worker as unknown as {
        process(value: typeof job): Promise<unknown>;
      }
    ).process(job);
    await worker.close();

    expect(result).toMatchObject({
      taskId,
      status: terminal === "expired" ? "already-terminal" : terminal,
    });
    expect(transition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: terminal,
        reasonCode:
          terminal === "completed"
            ? "TASK_HANDLER_COMPLETED"
            : `TASK_HANDLER_${terminal.toUpperCase()}`,
      }),
    );
    expect(acquireLease).not.toHaveBeenCalled();
    },
  );
});
