import { describe, expect, it } from "vitest";

import {
  InMemoryTaskExecutionStore,
  PersistentTaskStateMachine,
  TaskExecutionError,
  taskExecutionRecordSchema,
} from "../src/index.js";

const PARENT = "task-parent";
const CHILD = "task-child";

function clock() {
  let current = new Date("2026-08-28T06:00:00.000Z");
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

describe("persistent task execution FSM", () => {
  it("persists the closed-loop lifecycle and versions replans", async () => {
    const time = clock();
    const store = new InMemoryTaskExecutionStore();
    const fsm = new PersistentTaskStateMachine({ store, now: time.now });
    const created = await fsm.create({
      taskId: PARENT,
      botId: "bot-01",
      goal: "Acquire an iron pickaxe",
      maxRecoveryCount: 2,
      worldStateVersion: 4,
    });
    expect(created).toMatchObject({ state: "PRECHECK", revision: 0, planVersion: 0 });

    let current = await fsm.transition(PARENT, "PLAN", {
      currentStep: "expand recipe dependencies",
    });
    current = await fsm.transition(PARENT, "EXECUTE", { expectedRevision: current.revision });
    current = await fsm.markProgress(PARENT, {
      currentStep: "craft sticks",
      worldStateVersion: 5,
    });
    current = await fsm.transition(PARENT, "VERIFY", { expectedRevision: current.revision });
    current = await fsm.transition(PARENT, "SUCCESS", {
      expectedRevision: current.revision,
      actualResult: { item: "minecraft:iron_pickaxe" },
    });
    expect(current).toMatchObject({
      state: "SUCCESS",
      executionOwner: null,
      executionLeaseExpiresAt: null,
      planVersion: 0,
      worldStateVersion: 5,
      actualResult: { item: "minecraft:iron_pickaxe" },
    });

    const restored = new PersistentTaskStateMachine({ store, now: time.now });
    expect(await restored.restore(PARENT)).toEqual(current);
  });

  it("loads legacy snapshots without execution ownership fields", () => {
    const parsed = taskExecutionRecordSchema.parse({
      schemaVersion: "1.0",
      taskId: "legacy-task",
      botId: "bot-01",
      goal: "Resume a legacy task",
      parentTask: null,
      childTasks: [],
      state: "PLAN",
      currentStep: "legacy-plan",
      startTime: "2026-08-28T06:00:00.000Z",
      lastProgressTime: "2026-08-28T06:00:00.000Z",
      updatedAt: "2026-08-28T06:00:00.000Z",
      retryCount: 0,
      recoveryCount: 0,
      maxRecoveryCount: 3,
      planVersion: 0,
      worldStateVersion: 0,
      reservedResources: [],
      movementLease: null,
      expectedResult: null,
      actualResult: null,
      failureReason: null,
      cancellationToken: {
        tokenId: "legacy-cancel",
        cancelled: false,
        cancelledAt: null,
        reason: null,
      },
      revision: 1,
    });

    expect(parsed).toMatchObject({
      executionOwner: null,
      executionLeaseExpiresAt: null,
    });
  });

  it("claims unowned and expired executions with revision CAS", async () => {
    const time = clock();
    const fsm = new PersistentTaskStateMachine({ now: time.now });
    const created = await fsm.create({
      taskId: "claim-task",
      botId: "bot-01",
      goal: "Claim task ownership",
    });
    const ownerA = await fsm.claimExecution("claim-task", {
      owner: "coordinator-a",
      leaseExpiresAt: "2026-08-28T06:00:10.000Z",
      expectedRevision: created.revision,
    });
    expect(ownerA).toMatchObject({
      executionOwner: "coordinator-a",
      executionLeaseExpiresAt: "2026-08-28T06:00:10.000Z",
      revision: created.revision + 1,
    });

    await expect(
      fsm.claimExecution("claim-task", {
        owner: "coordinator-b",
        leaseExpiresAt: "2026-08-28T06:00:20.000Z",
        expectedRevision: ownerA.revision,
      }),
    ).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_OWNED",
    });
    expect(await fsm.get("claim-task")).toEqual(ownerA);

    await expect(
      fsm.claimExecution("claim-task", {
        owner: "coordinator-a",
        leaseExpiresAt: "2026-08-28T06:00:30.000Z",
        expectedRevision: ownerA.revision,
      }),
    ).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_OWNED",
    });
    expect(await fsm.get("claim-task")).toEqual(ownerA);

    time.advance(10_001);
    const ownerB = await fsm.claimExecution("claim-task", {
      owner: "coordinator-b",
      leaseExpiresAt: "2026-08-28T06:01:00.000Z",
      expectedRevision: ownerA.revision,
    });
    expect(ownerB).toMatchObject({
      executionOwner: "coordinator-b",
      executionLeaseExpiresAt: "2026-08-28T06:01:00.000Z",
      revision: ownerA.revision + 1,
    });

    await expect(
      fsm.claimExecution("claim-task", {
        owner: "coordinator-c",
        leaseExpiresAt: "2026-08-28T06:02:00.000Z",
        expectedRevision: ownerA.revision,
      }),
    ).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_REVISION_CONFLICT",
    });
    expect(await fsm.get("claim-task")).toEqual(ownerB);
  });

  it("clears execution ownership on terminal transition and cancellation", async () => {
    const time = clock();
    const fsm = new PersistentTaskStateMachine({ now: time.now });
    let task = await fsm.create({
      taskId: "success-owner-task",
      botId: "bot-01",
      goal: "Finish owned task",
      executionOwner: "coordinator-a",
      executionLeaseExpiresAt: "2026-08-28T06:01:00.000Z",
    });
    task = await fsm.transition(task.taskId, "PLAN", {
      expectedRevision: task.revision,
    });
    task = await fsm.transition(task.taskId, "EXECUTE", {
      expectedRevision: task.revision,
    });
    task = await fsm.transition(task.taskId, "VERIFY", {
      expectedRevision: task.revision,
    });
    task = await fsm.transition(task.taskId, "SUCCESS", {
      expectedRevision: task.revision,
    });
    expect(task).toMatchObject({
      state: "SUCCESS",
      executionOwner: null,
      executionLeaseExpiresAt: null,
    });

    const cancellable = await fsm.create({
      taskId: "cancel-owner-task",
      botId: "bot-01",
      goal: "Cancel owned task",
      executionOwner: "coordinator-a",
      executionLeaseExpiresAt: "2026-08-28T06:01:00.000Z",
    });
    const cancelled = await fsm.cancel(cancellable.taskId, "USER_CANCELLED");
    expect(cancelled).toMatchObject({
      state: "ABORT",
      executionOwner: null,
      executionLeaseExpiresAt: null,
    });
  });

  it("rejects cancellation when the root revision changed", async () => {
    const fsm = new PersistentTaskStateMachine();
    const created = await fsm.create({
      taskId: "cancel-cas-task",
      botId: "bot-01",
      goal: "Cancel only the captured revision",
    });
    const planned = await fsm.transition(created.taskId, "PLAN", {
      expectedRevision: created.revision,
    });

    await expect(
      fsm.cancel(created.taskId, "USER_CANCELLED", created.revision),
    ).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_REVISION_CONFLICT",
    });
    expect(await fsm.get(created.taskId)).toEqual(planned);
  });

  it("allows only one concurrent execution claim to win in memory", async () => {
    const time = clock();
    const fsm = new PersistentTaskStateMachine({ now: time.now });
    const created = await fsm.create({
      taskId: "concurrent-claim-task",
      botId: "bot-01",
      goal: "Choose one execution owner",
    });

    const claims = await Promise.allSettled([
      fsm.claimExecution(created.taskId, {
        owner: "coordinator-a",
        leaseExpiresAt: "2026-08-28T06:01:00.000Z",
        expectedRevision: created.revision,
      }),
      fsm.claimExecution(created.taskId, {
        owner: "coordinator-b",
        leaseExpiresAt: "2026-08-28T06:01:00.000Z",
        expectedRevision: created.revision,
      }),
    ]);

    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = claims.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "TASK_EXECUTION_REVISION_CONFLICT" },
    });
    const winner = await fsm.get(created.taskId);
    expect(winner).toMatchObject({ revision: created.revision + 1 });
    expect(["coordinator-a", "coordinator-b"]).toContain(
      winner?.executionOwner,
    );
  });

  it("routes failures through recovery and aborts after the recovery budget", async () => {
    const fsm = new PersistentTaskStateMachine({ defaultMaxRecoveryCount: 1 });
    await fsm.create({ taskId: "recover-task", botId: "bot-01", goal: "Gather wood" });
    await fsm.transition("recover-task", "PLAN");
    await fsm.transition("recover-task", "EXECUTE");
    let next = await fsm.transition("recover-task", "RECOVER", {
      failureReason: "PATH_BLOCKED",
    });
    expect(next).toMatchObject({ state: "RECOVER", recoveryCount: 1 });
    next = await fsm.transition("recover-task", "REPLAN");
    expect(next).toMatchObject({ state: "REPLAN", planVersion: 1 });
    await fsm.transition("recover-task", "EXECUTE");
    next = await fsm.transition("recover-task", "RECOVER", {
      failureReason: "PATH_BLOCKED_AGAIN",
    });
    expect(next).toMatchObject({ state: "ABORT", failureReason: "RECOVERY_BUDGET_EXHAUSTED" });
  });

  it("cancels descendants and rejects stale writes", async () => {
    const fsm = new PersistentTaskStateMachine();
    await fsm.create({ taskId: PARENT, botId: "bot-01", goal: "Build shelter" });
    await fsm.create({ taskId: CHILD, botId: "bot-01", parentTask: PARENT, goal: "Gather logs" });
    const running = await fsm.transition(CHILD, "PLAN");
    await expect(
      fsm.transition(CHILD, "EXECUTE", { expectedRevision: running.revision - 1 }),
    ).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_REVISION_CONFLICT",
    });
    const cancelled = await fsm.cancel(PARENT, "USER_CANCELLED");
    expect(cancelled).toMatchObject({ state: "ABORT", cancellationToken: { cancelled: true } });
    expect(await fsm.get(CHILD)).toMatchObject({
      state: "ABORT",
      cancellationToken: { cancelled: true, reason: "USER_CANCELLED" },
      movementLease: null,
    });
    expect(await fsm.cancel(PARENT, "USER_CANCELLED")).toEqual(cancelled);
    await expect(fsm.transition(CHILD, "EXECUTE")).rejects.toMatchObject<Partial<TaskExecutionError>>({
      code: "TASK_EXECUTION_CANCELLED",
    });
  });
});
