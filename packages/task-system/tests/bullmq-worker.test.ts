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
import { TaskSystemError } from "../src/errors.js";
import {
  taskCancelCommandSchema,
  taskRecordSchema,
  type TaskRecord,
} from "../src/model.js";
import { BullMqTaskWorker } from "../src/bullmq-worker.js";
import type { PostgresTaskRepository } from "../src/postgres-repository.js";
import { TASK_RETRY_SCHEDULED_REASON_CODE } from "../src/retry-policy.js";

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

describe("BullMQ task worker retryable failure budget", () => {
  const taskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const messageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const now = "2026-08-22T08:00:00.000Z";

  function createHarness(
    options: Readonly<{
      retryCount?: number;
      maxRetries?: number;
      idempotent?: boolean;
      retryableErrorCodes?: readonly string[];
      retryFailure?: unknown;
    }> = {},
  ) {
    const idempotent = options.idempotent ?? true;
    let current: TaskRecord = taskRecordSchema.parse({
      schemaVersion: "1.0",
      taskId,
      idempotencyScope: "worker-retry-test",
      idempotencyKey: "worker-retry-01",
      requestFingerprint: "b".repeat(64),
      taskType: "test.retry",
      handlerVersion: "1.0.0",
      executionIdempotent: idempotent,
      title: "Retryable task",
      description: "Task-system retry budget test.",
      priority: 50,
      status: "queued",
      dispatchBotId: "worker-01",
      assignedBotId: null,
      requiredSkills: [],
      requiredItems: [],
      target: null,
      dependencyIds: [],
      parentTaskId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      deadline: null,
      timeoutMs: 60_000,
      retryCount: options.retryCount ?? 0,
      maxRetries: options.maxRetries ?? 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      riskLevel: "R1",
      failureReason: null,
      result: null,
      evidence: [],
      traceId: "trace-worker-retry",
      revision: 1,
    });
    const retryCalls: Array<Record<string, unknown>> = [];
    const transitions: Array<{ to: TaskRecord["status"] }> = [];
    const repository = {
      getTask: vi.fn(async () => current),
      getTaskCancellationRequest: vi.fn(async () => null),
      getDatabaseTime: vi.fn(async () => new Date(now)),
      acquireLease: vi.fn(async () => {
        current = taskRecordSchema.parse({
          ...current,
          status: "assigned",
          assignedBotId: "worker-01",
          leaseOwner: "worker-lease-01",
          leaseExpiresAt: "2099-08-22T08:00:00.000Z",
          revision: current.revision + 1,
        });
        return current;
      }),
      transition: vi.fn(
        async (input: { to: TaskRecord["status"]; failureReason: unknown }) => {
          transitions.push({ to: input.to });
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
            updatedAt: now,
            startedAt: input.to === "running" ? now : current.startedAt,
            finishedAt: becomesTerminal ? now : null,
            failureReason:
              input.to === "failed" ? input.failureReason : null,
            ...(becomesTerminal
              ? {
                  assignedBotId: null,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                }
              : {}),
          });
          return current;
        },
      ),
      retryTaskDispatch: vi.fn(async (input: unknown) => {
        retryCalls.push(input as Record<string, unknown>);
        if (options.retryFailure !== undefined) throw options.retryFailure;
        current = taskRecordSchema.parse({
          ...current,
          status: "queued",
          retryCount: current.retryCount + 1,
          failureReason: null,
          finishedAt: null,
          revision: current.revision + 1,
        });
        return {
          task: current,
          dispatch: { taskId, botId: "worker-01" },
          outbox: { taskId, expectedRevision: current.revision },
        };
      }),
    } as unknown as PostgresTaskRepository;
    return { repository, retryCalls, transitions, task: () => current };
  }

  function createWorker(
    repository: PostgresTaskRepository,
    execute: () => Promise<never>,
    options: Readonly<{ idempotent?: boolean; retryableErrorCodes?: readonly string[] }> = {},
  ): BullMqTaskWorker {
    const handlers = new TaskHandlerRegistry();
    handlers.register({
      taskType: "test.retry",
      handlerVersion: "1.0.0",
      idempotent: options.idempotent ?? true,
      ...(options.retryableErrorCodes === undefined
        ? {}
        : { retryableErrorCodes: options.retryableErrorCodes }),
      execute,
    });
    return new BullMqTaskWorker(repository, handlers, {
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
  }

  function dispatch(idempotent = true) {
    return taskDispatchV1Schema.parse({
      schemaVersion: "1.0",
      messageId,
      traceId: "trace-worker-retry",
      timestamp: now,
      source: { service: "coordinator", instanceId: "coordinator-test" },
      taskId,
      botId: "worker-01",
      type: "task.dispatch.v1",
      payload: {
        expectedRevision: 1,
        taskType: "test.retry",
        handlerVersion: "1.0.0",
        executionIdempotent: idempotent,
      },
    });
  }

  async function run(
    harness: ReturnType<typeof createHarness>,
    execute: () => Promise<never>,
    idempotent = true,
    handlerOptions: Readonly<{
      retryableErrorCodes?: readonly string[];
    }> = {},
  ): Promise<unknown> {
    const worker = createWorker(
      harness.repository,
      execute,
      { idempotent, ...handlerOptions },
    );
    const job = {
      id: `${taskId}-r1`,
      name: "task.dispatch.v1",
      attemptsStarted: 1,
      data: dispatch(idempotent),
    };
    try {
      return await (
        worker as unknown as {
          process(value: typeof job): Promise<unknown>;
        }
      ).process(job);
    } finally {
      await worker.close();
    }
  }

  it("schedules a bounded jittered retry after a retryable handler failure", async () => {
    const harness = createHarness({ maxRetries: 3 });

    const result = await run(harness, async () => {
      throw new TaskSystemError(
        "TASK_WORKER_UNAVAILABLE",
        "Queue infrastructure became unavailable.",
      );
    });

    // The attempt result stays truthful: this execution failed.
    // revision 1 queued -> 2 assigned -> 3 running -> 4 failed.
    expect(result).toEqual({
      schemaVersion: "1.0",
      taskId,
      status: "failed",
      revision: 4,
    });
    expect(harness.transitions).toEqual([
      { to: "running" },
      { to: "failed" },
    ]);
    expect(harness.retryCalls).toHaveLength(1);
    expect(harness.retryCalls[0]).toMatchObject({
      schemaVersion: "1.0",
      taskId,
      expectedRevision: 4,
      actorId: "worker-test",
      reasonCode: TASK_RETRY_SCHEDULED_REASON_CODE,
    });
    // Attempt 1 of base 1000ms: equal jitter inside [500, 1000].
    const delayMs = harness.retryCalls[0]?.delayMs;
    expect(typeof delayMs).toBe("number");
    expect(delayMs as number).toBeGreaterThanOrEqual(500);
    expect(delayMs as number).toBeLessThanOrEqual(1_000);
    expect(String(harness.retryCalls[0]?.operationId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("keeps the retry scheduled by a handler-declared retryable code", async () => {
    const harness = createHarness({ maxRetries: 2 });

    await run(
      harness,
      async () => {
        throw { code: "PATHFINDER_GOTO_FAILED" };
      },
      true,
      { retryableErrorCodes: ["PATHFINDER_GOTO_FAILED"] },
    );

    expect(harness.retryCalls).toHaveLength(1);
    expect(harness.retryCalls[0]).toMatchObject({ expectedRevision: 4 });
  });

  it.each([
    [
      "an unclassified throw",
      new Error("Coordinator execution bridge returned 503."),
      undefined,
    ],
    [
      "a schema/validation failure",
      new TaskSystemError(
        "TASK_HANDLER_OUTPUT_INVALID",
        "Handler returned invalid structured output.",
      ),
      undefined,
    ],
    [
      "a safety cancellation",
      new TaskSystemError(
        "TASK_EXECUTION_CANCELLED",
        "Task execution was cancelled.",
      ),
      undefined,
    ],
    [
      "a permission/lease failure",
      new TaskSystemError(
        "TASK_LEASE_OWNER_MISMATCH",
        "Task lease belongs to another owner.",
      ),
      undefined,
    ],
    [
      "an undeclared handler code",
      { code: "PATHFINDER_GOTO_FAILED" },
      undefined,
    ],
    [
      "a declared code that §5 forbids retrying",
      new TaskSystemError("SKILL_INPUT_INVALID", "Input schema rejected."),
      ["SKILL_INPUT_INVALID"],
    ],
  ] as const)(
    "leaves %s terminal without a retry",
    async (_label, error, retryableErrorCodes) => {
      const harness = createHarness({ maxRetries: 3 });

      const result = await run(
        harness,
        async () => {
          throw error;
        },
        true,
        retryableErrorCodes === undefined ? {} : { retryableErrorCodes },
      );

      expect(result).toMatchObject({ taskId, status: "failed" });
      expect(harness.retryCalls).toHaveLength(0);
    },
  );

  it("never exceeds the retry budget", async () => {
    const harness = createHarness({ retryCount: 1, maxRetries: 1 });

    const result = await run(harness, async () => {
      throw new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "PostgreSQL task operation failed.",
      );
    });

    expect(result).toMatchObject({ taskId, status: "failed" });
    expect(harness.retryCalls).toHaveLength(0);
  });

  it("does not auto-retry a non-idempotent task", async () => {
    const harness = createHarness({ idempotent: false, maxRetries: 3 });

    const result = await run(
      harness,
      async () => {
        throw new TaskSystemError(
          "TASK_WORKER_UNAVAILABLE",
          "Queue infrastructure became unavailable.",
        );
      },
      false,
    );

    expect(result).toMatchObject({ taskId, status: "failed" });
    expect(harness.retryCalls).toHaveLength(0);
  });

  it("keeps the durable failure when another actor already decided the task", async () => {
    const harness = createHarness({
      maxRetries: 3,
      retryFailure: new TaskSystemError(
        "TASK_CANCELLATION_PENDING",
        "Task cancellation must resolve before dispatch retry.",
      ),
    });

    const result = await run(harness, async () => {
      throw new TaskSystemError(
        "TASK_WORKER_UNAVAILABLE",
        "Queue infrastructure became unavailable.",
      );
    });

    expect(result).toMatchObject({ taskId, status: "failed" });
    expect(harness.retryCalls).toHaveLength(1);
  });

  it("surfaces an infrastructure failure of the scheduled retry", async () => {
    const harness = createHarness({
      maxRetries: 3,
      retryFailure: new TaskSystemError(
        "TASK_PERSISTENCE_FAILED",
        "PostgreSQL task operation failed.",
      ),
    });

    await expect(
      run(harness, async () => {
        throw new TaskSystemError(
          "TASK_WORKER_UNAVAILABLE",
          "Queue infrastructure became unavailable.",
        );
      }),
    ).rejects.toMatchObject({ code: "TASK_PERSISTENCE_FAILED" });
    expect(harness.retryCalls).toHaveLength(1);
  });
});
