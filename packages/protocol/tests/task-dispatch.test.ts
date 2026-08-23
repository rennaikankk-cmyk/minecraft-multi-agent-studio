import { describe, expect, it } from "vitest";

import {
  parseTaskDispatch,
  taskDispatchV1Schema,
  taskQueueSourceSchema,
} from "../src/index.js";

const dispatch = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-dispatch-001",
  timestamp: "2026-07-27T11:00:00.000Z",
  source: {
    service: "coordinator" as const,
    instanceId: "coordinator-01",
  },
  taskId: "22222222-2222-4222-8222-222222222222",
  botId: "worker-01",
  type: "task.dispatch.v1" as const,
  payload: {
    expectedRevision: 7,
    taskType: "resource.collect",
    handlerVersion: "1.0.0",
    executionIdempotent: true,
  },
};

describe("TaskDispatchV1", () => {
  it("accepts a strict, versioned coordinator dispatch", () => {
    expect(parseTaskDispatch(dispatch)).toEqual(dispatch);
  });

  it("accepts an optional durable assignment lease owner", () => {
    const preassigned = {
      ...dispatch,
      payload: {
        ...dispatch.payload,
        assignmentLeaseOwner: "coordinator-assignment-01",
      },
    };
    expect(parseTaskDispatch(preassigned)).toEqual(preassigned);
  });

  it("requires the coordinator source and rejects source extensions", () => {
    expect(taskQueueSourceSchema.parse(dispatch.source)).toEqual(
      dispatch.source,
    );
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        source: { ...dispatch.source, service: "bot-runtime" },
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        source: { ...dispatch.source, modelName: "planner" },
      }).success,
    ).toBe(false);
  });

  it("requires UUID message and task identifiers plus an identifier bot", () => {
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        messageId: "message-1",
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        taskId: "task-1",
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        botId: "worker 01",
      }).success,
    ).toBe(false);
  });

  it("accepts only canonical UTC timestamps", () => {
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        timestamp: "2026-07-27T19:00:00.000+08:00",
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        timestamp: "2026-07-27 11:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("bounds expectedRevision to a nonnegative safe integer", () => {
    for (const expectedRevision of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
    ]) {
      expect(
        taskDispatchV1Schema.safeParse({
          ...dispatch,
          payload: { ...dispatch.payload, expectedRevision },
        }).success,
      ).toBe(false);
    }
  });

  it("matches the existing task type naming rules", () => {
    for (const taskType of [
      "ab",
      ".resource.collect",
      "resource.collect.",
      "Resource.Collect",
      "resource collect",
      "https://example.invalid/task",
    ]) {
      expect(
        taskDispatchV1Schema.safeParse({
          ...dispatch,
          payload: { ...dispatch.payload, taskType },
        }).success,
      ).toBe(false);
    }
  });

  it("requires the exact handler version and persisted idempotency policy", () => {
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        payload: { ...dispatch.payload, handlerVersion: "latest" },
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        payload: {
          ...dispatch.payload,
          executionIdempotent: "true",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects model text, code, shell, URLs and arbitrary payload fields", () => {
    for (const field of [
      "modelText",
      "code",
      "shell",
      "url",
      "arguments",
    ]) {
      expect(
        taskDispatchV1Schema.safeParse({
          ...dispatch,
          payload: {
            ...dispatch.payload,
            [field]: "untrusted",
          },
        }).success,
      ).toBe(false);
    }
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        arbitrary: "untrusted",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown schema and message versions", () => {
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        schemaVersion: "2.0",
      }).success,
    ).toBe(false);
    expect(
      taskDispatchV1Schema.safeParse({
        ...dispatch,
        type: "task.dispatch.v2",
      }).success,
    ).toBe(false);
  });
});
