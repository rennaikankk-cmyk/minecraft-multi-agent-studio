import type {
  ControlLinkGoalRequestV1,
  GoalDispatchResultV1,
} from "@minecraft-studio/protocol";
import { describe, expect, it } from "vitest";

import {
  GoalLifecycleStoreError,
  InMemoryGoalLifecycleStore,
} from "../src/index.js";

const NOW = new Date("2026-08-27T10:00:00.000Z");
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";

describe("InMemoryGoalLifecycleStore", () => {
  it("owns and verifies a local execution lease through terminal history", async () => {
    const store = new InMemoryGoalLifecycleStore({ now: () => NOW });
    const begin = await store.begin(goalRequest());
    expect(begin.kind).toBe("execute");
    if (begin.kind !== "execute") throw new Error("expected execution lease");
    expect(
      store.isAssignmentLeaseActive({
        taskId: TASK_ID,
        botId: "studio-bot-01",
        leaseOwner: begin.lease.leaseOwner,
      }),
    ).toBe(true);

    const result: GoalDispatchResultV1 = {
      action: "noop",
      botId: "studio-bot-01",
      taskId: TASK_ID,
      reasonCode: "NO_SAFE_SKILL",
      ai: {
        attempts: 1,
        queueTimeMs: 2,
        executionTimeMs: 8,
        totalTimeMs: 10,
      },
    };
    const terminal = await store.recordResult(begin.lease, result);
    expect(terminal).toMatchObject({ status: "failed", result });
    expect(
      store.isAssignmentLeaseActive({
        taskId: TASK_ID,
        botId: "studio-bot-01",
        leaseOwner: begin.lease.leaseOwner,
      }),
    ).toBe(false);

    const page = await store.listTaskHistory({
      limit: 10,
      cursor: null,
      status: null,
      botId: "studio-bot-01",
    });
    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      taskId: TASK_ID,
      status: "failed",
      failureReason: "GOAL_RESULT_FAILED",
    });
    await expect(store.getTaskDetail(TASK_ID)).resolves.toMatchObject({
      task: { operatorGoal: "采集附近的木材" },
    });

    const replay = await store.begin(goalRequest());
    expect(replay).toMatchObject({ kind: "result", result });
  });

  it("rejects operation and task identity conflicts", async () => {
    const store = new InMemoryGoalLifecycleStore({ now: () => NOW });
    await store.begin(goalRequest());
    const conflicting = goalRequest({ operatorGoal: "挖一块石头" });
    await expect(store.begin(conflicting)).rejects.toMatchObject<
      GoalLifecycleStoreError
    >({ code: "GOAL_ID_CONFLICT" });

    await expect(
      store.begin(
        goalRequest({
          operationId: "33333333-3333-4333-8333-333333333333",
        }),
      ),
    ).rejects.toMatchObject<GoalLifecycleStoreError>({
      code: "GOAL_ID_CONFLICT",
    });
  });
});

function goalRequest(
  overrides: Partial<ControlLinkGoalRequestV1["payload"]> = {},
): ControlLinkGoalRequestV1 {
  return {
    schemaVersion: "1.0",
    messageId: "44444444-4444-4444-8444-444444444444",
    timestamp: NOW.toISOString(),
    type: "control.link.goal-request.v1",
    payload: {
      coordinatorInstanceId: "coordinator-test",
      clientId: "dashboard-test",
      controlApiInstanceId: "control-test",
      operationId: OPERATION_ID,
      taskId: TASK_ID,
      botId: "studio-bot-01",
      actorId: "local-dashboard",
      operatorGoal: "采集附近的木材",
      timeoutMs: 60_000,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      ...overrides,
    },
  };
}
