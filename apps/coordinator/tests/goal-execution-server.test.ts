import { describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  coordinatorGoalExecutionResponseV1Schema,
} from "@minecraft-studio/protocol";

import {
  CoordinatorGoalExecutionServer,
  type GoalExecutionServerOptions,
} from "../src/goal-execution-server.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(32);

function runningTask() {
  return {
    taskId: TASK_ID,
    idempotencyScope: "control-goal-v1",
    idempotencyKey: TASK_ID,
    taskType: "coordinator.goal",
    handlerVersion: "1.0.0",
    executionIdempotent: false,
    maxRetries: 0,
    riskLevel: "R1",
    timeoutMs: 30_000,
    traceId: TASK_ID,
    status: "running",
    dispatchBotId: "bot-01",
    assignedBotId: "bot-01",
    leaseOwner: "lease-01",
    input: {
      schemaVersion: "1.0",
      kind: "coordinator.goal.v1",
      operationId: TASK_ID,
      taskId: TASK_ID,
      clientId: "control-api",
      actorId: "operator-01",
      botId: "bot-01",
      operatorGoal: "collect one oak log",
      timeoutMs: 30_000,
    },
  } as never;
}

function logger(): AppLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function withServer(
  overrides: Partial<GoalExecutionServerOptions>,
  run: (url: string) => Promise<void>,
) {
  const server = new CoordinatorGoalExecutionServer({
    host: "127.0.0.1",
    port: 0,
    secret: SECRET,
    repository: {
      getTask: vi.fn(async () => runningTask()),
      isTaskAssignmentLeaseActive: vi.fn(async () => true),
    },
    planner: {
      planAndDispatch: vi.fn(async () => ({
        action: "noop",
        reasonCode: "NO_SAFE_ACTION",
        ai: {
          value: {},
          attempts: 1,
          queueTimeMs: 0,
          executionTimeMs: 1,
          totalTimeMs: 1,
        },
      })) as never,
    },
    logger: logger(),
    ...overrides,
  });
  const address = await server.start();
  try {
    await run(`http://${address.host}:${address.port}`);
  } finally {
    await server.stop();
  }
}

function execute(url: string, secret = SECRET, leaseOwner = "lease-01") {
  return fetch(`${url}/v1/internal/coordinator-goal-execution`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      taskId: TASK_ID,
      assignmentLeaseOwner: leaseOwner,
      workerInstanceId: "task-worker-01",
    }),
  });
}

describe("Coordinator goal execution bridge", () => {
  it("requires the shared secret before reading durable state", async () => {
    const getTask = vi.fn(async () => runningTask());
    await withServer(
      {
        repository: {
          getTask,
          isTaskAssignmentLeaseActive: vi.fn(async () => true),
        },
      },
      async (url) => {
        const response = await execute(url, "x".repeat(32));
        expect(response.status).toBe(401);
        expect(getTask).not.toHaveBeenCalled();
      },
    );
  });

  it("executes only a matching active PostgreSQL lease", async () => {
    const planAndDispatch = vi.fn(async () => ({
      action: "noop" as const,
      reasonCode: "NO_SAFE_ACTION",
      ai: {
        value: {},
        attempts: 1,
        queueTimeMs: 0,
        executionTimeMs: 1,
        totalTimeMs: 1,
      },
    }));
    await withServer(
      { planner: { planAndDispatch: planAndDispatch as never } },
      async (url) => {
        const denied = coordinatorGoalExecutionResponseV1Schema.parse(
          await (await execute(url, SECRET, "wrong-lease")).json(),
        );
        expect(denied).toMatchObject({
          ok: false,
          errorCode: "AUTHORIZATION_REJECTED",
        });
        expect(planAndDispatch).not.toHaveBeenCalled();

        const accepted = coordinatorGoalExecutionResponseV1Schema.parse(
          await (await execute(url)).json(),
        );
        expect(accepted).toMatchObject({
          ok: true,
          result: { taskId: TASK_ID, botId: "bot-01" },
        });
        expect(planAndDispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            taskId: TASK_ID,
            botId: "bot-01",
            operatorGoal: "collect one oak log",
            assignmentLeaseOwner: "lease-01",
          }),
        );
      },
    );
  });
});
