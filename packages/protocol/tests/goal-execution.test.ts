import { describe, expect, it } from "vitest";

import {
  coordinatorGoalExecutionRequestV1Schema,
  coordinatorGoalExecutionResponseV1Schema,
} from "../src/goal-execution.js";

describe("Coordinator goal execution protocol", () => {
  it("accepts only identity and lease data in execution requests", () => {
    const request = {
      schemaVersion: "1.0",
      taskId: "11111111-1111-4111-8111-111111111111",
      assignmentLeaseOwner: "task-worker-lease-01",
      workerInstanceId: "task-worker-01",
    };
    expect(coordinatorGoalExecutionRequestV1Schema.parse(request)).toEqual(
      request,
    );
    expect(() =>
      coordinatorGoalExecutionRequestV1Schema.parse({
        ...request,
        operatorGoal: "must not travel in the queue bridge request",
      }),
    ).toThrow();
  });

  it("rejects a result for a different durable task", () => {
    expect(() =>
      coordinatorGoalExecutionResponseV1Schema.parse({
        schemaVersion: "1.0",
        taskId: "11111111-1111-4111-8111-111111111111",
        ok: true,
        result: {
          action: "noop",
          taskId: "22222222-2222-4222-8222-222222222222",
          botId: "worker-01",
          reasonCode: "NO_SAFE_ACTION",
          ai: {
            attempts: 1,
            queueTimeMs: 0,
            executionTimeMs: 1,
            totalTimeMs: 1,
          },
        },
      }),
    ).toThrow();
  });
});
