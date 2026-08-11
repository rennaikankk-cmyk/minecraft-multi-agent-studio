import { describe, expect, it } from "vitest";

import {
  taskDispatchJobId,
  TaskQueueError,
} from "../src/bullmq-queue.js";
import {
  TaskHandlerRegistry,
  TaskWorkerError,
} from "../src/bullmq-worker.js";
import { taskCancelCommandSchema } from "../src/model.js";

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
});
