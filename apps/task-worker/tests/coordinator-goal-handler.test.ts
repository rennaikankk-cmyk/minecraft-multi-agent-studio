import { describe, expect, it, vi } from "vitest";

import {
  coordinatorGoalExecutionResponseV1Schema,
  type GoalDispatchResultV1,
} from "@minecraft-studio/protocol";
import { TaskHandlerRegistry } from "@minecraft-studio/task-system";

import {
  COORDINATOR_GOAL_HANDLER_VERSION,
  COORDINATOR_GOAL_TASK_TYPE,
  createCoordinatorGoalHandler,
} from "../src/coordinator-goal-handler.js";

const taskId = "11111111-1111-4111-8111-111111111111";

function context(overrides: Record<string, unknown> = {}) {
  return {
    task: {
      taskType: COORDINATOR_GOAL_TASK_TYPE,
      handlerVersion: COORDINATOR_GOAL_HANDLER_VERSION,
      executionIdempotent: false,
      taskId,
      leaseOwner: "lease-01",
      ...overrides,
    },
    dispatch: { source: { instanceId: "worker-01" } },
    signal: new AbortController().signal,
  } as never;
}

describe("Coordinator goal worker handler", () => {
  it("registers the non-idempotent production contract", () => {
    const handler = createCoordinatorGoalHandler({
      baseUrl: "http://127.0.0.1:3222",
      secret: "s".repeat(32),
      workerInstanceId: "worker-01",
      fetchImplementation: vi.fn(),
    });
    expect(handler).toMatchObject({
      taskType: COORDINATOR_GOAL_TASK_TYPE,
      handlerVersion: COORDINATOR_GOAL_HANDLER_VERSION,
      idempotent: false,
    });
    const registry = new TaskHandlerRegistry();
    registry.register(handler);
    expect(
      registry.get(COORDINATOR_GOAL_TASK_TYPE, COORDINATOR_GOAL_HANDLER_VERSION),
    ).toMatchObject({ idempotent: false });
  });

  it("maps a completed bridge result to a completed handler output", async () => {
    const result: GoalDispatchResultV1 = {
      action: "noop",
      taskId,
      botId: "bot-01",
      reasonCode: "NO_SAFE_ACTION",
      ai: { attempts: 1, queueTimeMs: 0, executionTimeMs: 1, totalTimeMs: 1 },
    };
    const fetchImplementation = vi.fn(async () =>
      new Response(
        JSON.stringify(
          coordinatorGoalExecutionResponseV1Schema.parse({
            schemaVersion: "1.0",
            taskId,
            ok: true,
            result,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const handler = createCoordinatorGoalHandler({
      baseUrl: "http://127.0.0.1:3222",
      secret: "s".repeat(32),
      workerInstanceId: "worker-actual",
      fetchImplementation,
    });
    await expect(handler.execute(context())).resolves.toMatchObject({
      terminal: { status: "failed", failureReason: "NO_SAFE_ACTION" },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://127.0.0.1:3222/v1/internal/coordinator-goal-execution",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "1.0",
          taskId,
          assignmentLeaseOwner: "lease-01",
          workerInstanceId: "worker-actual",
        }),
      }),
    );
  });
});
