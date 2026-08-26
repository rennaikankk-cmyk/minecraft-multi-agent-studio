import {
  controlLinkGoalRequestV1Schema,
  type ControlLinkGoalRequestV1,
  type GoalDispatchResultV1,
} from "@minecraft-studio/protocol";
import {
  PostgresTaskRepository,
  TaskSystemError,
  type TaskRecord,
} from "@minecraft-studio/task-system";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresGoalLifecycleStore,
  durableGoalFingerprint,
} from "../src/goal-lifecycle-store.js";

const NOW = new Date("2026-08-22T08:00:00.000Z");
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

function request(): ControlLinkGoalRequestV1 {
  return controlLinkGoalRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId: "22222222-2222-4222-8222-222222222222",
    timestamp: NOW.toISOString(),
    type: "control.link.goal-request.v1",
    payload: {
      coordinatorInstanceId: "coordinator-test",
      clientId: "control-api",
      controlApiInstanceId: "control-api-instance-a",
      operationId: OPERATION_ID,
      taskId: OPERATION_ID,
      botId: "worker-01",
      actorId: "operator-01",
      operatorGoal: "采集附近的木材",
      timeoutMs: 30_000,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 35_000).toISOString(),
    },
  });
}

function task(
  status: TaskRecord["status"],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    schemaVersion: "1.0",
    taskId: OPERATION_ID,
    idempotencyScope: "control-goal-v1",
    idempotencyKey: OPERATION_ID,
    requestFingerprint: "a".repeat(64),
    taskType: "coordinator.goal",
    handlerVersion: "1.0.0",
    executionIdempotent: false,
    title: "Submitted goal",
    description: "Authenticated operator goal.",
    input: {
      schemaVersion: "1.0",
      kind: "coordinator.goal.v1",
      operationId: OPERATION_ID,
      taskId: OPERATION_ID,
      clientId: "control-api",
      actorId: "operator-01",
      botId: "worker-01",
      operatorGoal: "采集附近的木材",
      timeoutMs: 30_000,
    },
    priority: 50,
    status,
    dispatchBotId: null,
    assignedBotId:
      status === "assigned" || status === "running" ? "worker-01" : null,
    requiredSkills: [],
    requiredItems: [],
    target: null,
    dependencyIds: [],
    parentTaskId: null,
    createdAt: new Date(NOW.getTime() - 1_000).toISOString(),
    updatedAt: NOW.toISOString(),
    startedAt: status === "running" ? NOW.toISOString() : null,
    finishedAt: null,
    deadline: null,
    timeoutMs: 30_000,
    retryCount: 0,
    maxRetries: 0,
    leaseOwner:
      status === "assigned" || status === "running" ? "goal-old-lease" : null,
    leaseExpiresAt:
      status === "assigned" || status === "running"
        ? new Date(NOW.getTime() + 60_000).toISOString()
        : null,
    riskLevel: "R1",
    failureReason: null,
    result: null,
    evidence: [],
    traceId: OPERATION_ID,
    revision: status === "queued" ? 0 : 2,
    ...overrides,
  };
}

function repository(overrides: Record<string, unknown>): PostgresTaskRepository {
  return overrides as unknown as PostgresTaskRepository;
}

describe("PostgresGoalLifecycleStore", () => {
  it("submits production goals through the durable dispatch outbox", async () => {
    const queued = task("queued", { dispatchBotId: "worker-01" });
    const submitTask = vi.fn(async () => ({
      task: queued,
      created: true,
      dispatch: {},
      outbox: {},
    }));
    const store = new PostgresGoalLifecycleStore({
      repository: repository({ submitTask }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.submitQueued(request())).resolves.toMatchObject({
      taskId: OPERATION_ID,
      botId: "worker-01",
      status: "queued",
    });
    expect(submitTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "coordinator.goal",
        handlerVersion: "1.0.0",
        executionIdempotent: false,
        dispatchBotId: "worker-01",
      }),
    );
  });

  it("verifies the migration contract before loading lifecycle state", async () => {
    const verifyGoalLifecycleSchema = vi.fn(async () => undefined);
    const getDatabaseTime = vi.fn(async () => NOW);
    const listTaskLifecycle = vi.fn(async () => []);
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        verifyGoalLifecycleSchema,
        getDatabaseTime,
        listTaskLifecycle,
      }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.initialize(5 * 60_000)).resolves.toEqual([]);
    expect(verifyGoalLifecycleSchema).toHaveBeenCalledBefore(getDatabaseTime);
    expect(listTaskLifecycle).toHaveBeenCalledWith({
      taskType: "coordinator.goal",
      terminalUpdatedAfter: new Date(
        NOW.getTime() - 5 * 60_000,
      ).toISOString(),
    });
  });

  it("uses a stable fingerprint across transport instance changes", () => {
    const original = request();
    const reconnected = controlLinkGoalRequestV1Schema.parse({
      ...original,
      messageId: "77777777-7777-4777-8777-777777777777",
      payload: {
        ...original.payload,
        coordinatorInstanceId: "coordinator-after-restart",
        controlApiInstanceId: "control-api-instance-b",
      },
    });
    const differentActor = controlLinkGoalRequestV1Schema.parse({
      ...reconnected,
      payload: { ...reconnected.payload, actorId: "operator-02" },
    });

    expect(durableGoalFingerprint(reconnected)).toBe(
      durableGoalFingerprint(original),
    );
    expect(durableGoalFingerprint(differentActor)).not.toBe(
      durableGoalFingerprint(original),
    );

    // PostgreSQL JSONB can return the same persisted object in a different
    // key order after a restart. The durable identity must not change with it.
    const reordered = {
      timeoutMs: original.payload.timeoutMs,
      operatorGoal: original.payload.operatorGoal,
      botId: original.payload.botId,
      actorId: original.payload.actorId,
      clientId: original.payload.clientId,
      taskId: original.payload.taskId,
      operationId: original.payload.operationId,
      kind: "coordinator.goal.v1" as const,
      schemaVersion: "1.0" as const,
    };
    expect(durableGoalFingerprint(reordered)).toBe(
      durableGoalFingerprint(original),
    );
  });

  it("durably creates, leases, and starts a goal before execution", async () => {
    const queued = task("queued");
    const assigned = task("assigned", { revision: 1, leaseOwner: "goal-test" });
    const running = task("running", { revision: 2, leaseOwner: "goal-test" });
    const createTask = vi.fn(async () => ({ task: queued, created: true }));
    const acquireLease = vi.fn(async (command: any) => ({
      ...assigned,
      leaseOwner: command.leaseOwner,
    }));
    const transition = vi.fn(async (command: any) => ({
      ...running,
      leaseOwner: command.leaseOwner,
    }));
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask,
        getDatabaseTime: vi.fn(async () => NOW),
        acquireLease,
        transition,
      }),
      coordinatorInstanceId: "coordinator-test",
      randomId: vi
        .fn()
        .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
        .mockReturnValueOnce("44444444-4444-4444-8444-444444444444"),
    });

    const begun = await store.begin(request());

    expect(begun.kind).toBe("execute");
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        taskId: OPERATION_ID,
        taskType: "coordinator.goal",
        executionIdempotent: false,
        maxRetries: 0,
        input: expect.objectContaining({
          actorId: "operator-01",
          botId: "worker-01",
          operatorGoal: "采集附近的木材",
        }),
      }),
    );
    expect(acquireLease).toHaveBeenCalledBefore(transition);
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ to: "running", expectedRevision: 1 }),
    );
  });

  it("uses the synchronous durable assignment boundary when live Bot context is available", async () => {
    const queued = task("queued");
    const assigned = task("assigned", {
      revision: 1,
      dispatchBotId: "worker-01",
      leaseOwner: "goal-test",
    });
    const running = task("running", {
      revision: 2,
      dispatchBotId: "worker-01",
      leaseOwner: "goal-test",
    });
    const acquireSynchronousAssignment = vi.fn(async (command: any) => ({
      ...assigned,
      dispatchBotId: command.botId,
      leaseOwner: command.leaseOwner,
    }));
    const acquireLease = vi.fn();
    const transition = vi.fn(async (command: any) => ({
      ...running,
      dispatchBotId: "worker-01",
      leaseOwner: command.leaseOwner,
    }));
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({ task: queued, created: true })),
        getDatabaseTime: vi.fn(async () => NOW),
        acquireSynchronousAssignment,
        acquireLease,
        transition,
      }),
      coordinatorInstanceId: "coordinator-test",
      resolveBotContext: () => ({
        serverProfileId: "isolated-test",
        dimension: "minecraft:overworld",
      }),
    });

    await expect(store.begin(request())).resolves.toMatchObject({
      kind: "execute",
      snapshot: { status: "running" },
    });
    expect(acquireSynchronousAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "worker-01",
        serverProfileId: "isolated-test",
        dimension: "minecraft:overworld",
      }),
    );
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("fails closed when the production context resolver cannot prove a live Bot", async () => {
    const acquireSynchronousAssignment = vi.fn();
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({ task: task("queued"), created: false })),
        getDatabaseTime: vi.fn(async () => NOW),
        acquireSynchronousAssignment,
      }),
      coordinatorInstanceId: "coordinator-test",
      resolveBotContext: () => null,
    });

    await expect(store.begin(request())).rejects.toMatchObject({
      code: "BOT_UNAVAILABLE",
    });
    expect(acquireSynchronousAssignment).not.toHaveBeenCalled();
  });

  it("returns busy for an active persisted lease without executing twice", async () => {
    const acquireLease = vi.fn();
    const active = task("running");
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({ task: active, created: false })),
        getDatabaseTime: vi.fn(async () => NOW),
        acquireLease,
      }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.begin(request())).resolves.toMatchObject({
      kind: "busy",
      snapshot: { status: "running" },
    });
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("expires a queued goal whose timeout elapsed before execution", async () => {
    const queued = task("queued", {
      createdAt: new Date(NOW.getTime() - 30_001).toISOString(),
    });
    const expired = task("expired", {
      createdAt: queued.createdAt,
      finishedAt: NOW.toISOString(),
      revision: 1,
    });
    const transition = vi.fn(async () => expired);
    const acquireLease = vi.fn();
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({ task: queued, created: false })),
        getDatabaseTime: vi.fn(async () => NOW),
        transition,
        acquireLease,
      }),
      coordinatorInstanceId: "coordinator-test",
      randomId: () => "88888888-8888-4888-8888-888888888888",
    });

    await expect(store.begin(request())).resolves.toMatchObject({
      kind: "error",
      errorCode: "AI_TIMEOUT",
      snapshot: { status: "expired" },
    });
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ to: "expired", expectedRevision: 0 }),
    );
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("rejects reuse of an operation ID with different persisted input", async () => {
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => {
          throw new TaskSystemError(
            "TASK_IDEMPOTENCY_CONFLICT",
            "injected conflict",
          );
        }),
      }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.begin(request())).rejects.toMatchObject({
      code: "GOAL_ID_CONFLICT",
    });
  });

  it("rejects a persisted task whose execution contract was altered", async () => {
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({
          task: task("queued", { timeoutMs: 60_000 }),
          created: false,
        })),
      }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.begin(request())).rejects.toMatchObject({
      code: "GOAL_ID_CONFLICT",
    });
  });

  it("replays an exact persisted terminal result without executing again", async () => {
    const result: GoalDispatchResultV1 = {
      action: "noop",
      botId: "worker-01",
      taskId: OPERATION_ID,
      reasonCode: "NO_SAFE_ACTION",
      ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 2, totalTimeMs: 3 },
    };
    const acquireLease = vi.fn();
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({
          task: task("failed", {
            result,
            failureReason: "GOAL_RESULT_FAILED",
            finishedAt: NOW.toISOString(),
            revision: 3,
          }),
          created: false,
        })),
        acquireLease,
      }),
      coordinatorInstanceId: "coordinator-test",
    });

    await expect(store.begin(request())).resolves.toMatchObject({
      kind: "result",
      result,
    });
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("fails closed after an expired running lease instead of replaying execution", async () => {
    const expiredRunning = task("running", {
      leaseExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
    });
    const failed = task("failed", {
      failureReason: "TASK_LEASE_EXPIRED",
      finishedAt: NOW.toISOString(),
      revision: 3,
    });
    const acquireLease = vi.fn();
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        createTask: vi.fn(async () => ({ task: expiredRunning, created: false })),
        getDatabaseTime: vi.fn(async () => NOW),
        recoverExpiredLease: vi.fn(async () => ({
          task: failed,
          dispatch: null,
          outbox: null,
        })),
        acquireLease,
      }),
      coordinatorInstanceId: "coordinator-test",
      randomId: () => "55555555-5555-4555-8555-555555555555",
    });

    await expect(store.begin(request())).resolves.toMatchObject({
      kind: "error",
      errorCode: "CONTROL_LINK_INTERNAL_ERROR",
      snapshot: { status: "failed" },
    });
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("rebuilds dispatch state while refreshing an expired assigned lease", async () => {
    const assigned = task("assigned", {
      leaseExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
    });
    const queued = task("queued", {
      revision: assigned.revision + 1,
      updatedAt: NOW.toISOString(),
    });
    const recoverExpiredLease = vi.fn(async () => ({
      task: queued,
      dispatch: null,
      outbox: null,
    }));
    const expireLease = vi.fn();
    const store = new PostgresGoalLifecycleStore({
      repository: repository({
        getDatabaseTime: vi.fn(async () => NOW),
        listTaskLifecycle: vi.fn(async () => [assigned]),
        recoverExpiredLease,
        expireLease,
      }),
      coordinatorInstanceId: "coordinator-test",
      randomId: () => "99999999-9999-4999-8999-999999999999",
    });

    await expect(store.refresh(5 * 60_000)).resolves.toMatchObject([
      { status: "queued" },
    ]);
    expect(recoverExpiredLease).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: assigned.taskId,
        expectedRevision: assigned.revision,
        reasonCode: "TASK_LEASE_EXPIRED",
      }),
    );
    expect(expireLease).not.toHaveBeenCalled();
  });

  it("records unsuccessful planner outcomes as replayable terminal results", async () => {
    const result: GoalDispatchResultV1 = {
      action: "noop",
      botId: "worker-01",
      taskId: OPERATION_ID,
      reasonCode: "NO_SAFE_ACTION",
      ai: { attempts: 1, queueTimeMs: 1, executionTimeMs: 2, totalTimeMs: 3 },
    };
    const transition = vi.fn(async () =>
      task("failed", {
        result,
        failureReason: "GOAL_RESULT_FAILED",
        finishedAt: NOW.toISOString(),
        revision: 3,
      }),
    );
    const store = new PostgresGoalLifecycleStore({
      repository: repository({ transition }),
      coordinatorInstanceId: "coordinator-test",
      randomId: () => "66666666-6666-4666-8666-666666666666",
    });

    await expect(
      store.recordResult(
        { taskId: OPERATION_ID, leaseOwner: "goal-test", revision: 2 },
        result,
      ),
    ).resolves.toMatchObject({ status: "failed", result });
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "failed",
        failureReason: "GOAL_RESULT_FAILED",
        result,
      }),
    );
  });
});
