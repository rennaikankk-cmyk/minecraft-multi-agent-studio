import { describe, expect, it } from "vitest";

import {
  parseSkillExecutionResult,
  parseSkillCancellation,
  parseSkillInvocation,
  skillExecutionResultV1Schema,
  skillInvocationV1Schema,
} from "../src/index.js";

const NOW = "2026-07-27T08:00:00.000Z";
const invocation = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-skill-001",
  timestamp: NOW,
  source: { service: "coordinator" as const, instanceId: "coordinator-01" },
  botId: "worker-01",
  taskId: "task-001",
  type: "skill.invoke.v1" as const,
  payload: {
    invocationId: "22222222-2222-4222-8222-222222222222",
    skillId: "movement.step",
    skillVersion: "1.0.0",
    expiresAt: "2026-07-27T08:01:00.000Z",
    input: { direction: "forward", distance: 1 },
    authorization: {
      decisionId: "33333333-3333-4333-8333-333333333333",
      actorId: "coordinator-agent",
      issuedAt: "2026-07-27T07:59:59.000Z",
      expiresAt: "2026-07-27T08:01:00.000Z",
    },
  },
};

describe("SkillInvocationV1", () => {
  it("accepts a bounded, versioned and JSON-only invocation", () => {
    expect(parseSkillInvocation(invocation)).toEqual(invocation);
  });

  it("rejects unknown versions, extra fields and non-JSON input", () => {
    expect(
      skillInvocationV1Schema.safeParse({ ...invocation, schemaVersion: "2.0" })
        .success,
    ).toBe(false);
    expect(
      skillInvocationV1Schema.safeParse({ ...invocation, rawTick: "forward" })
        .success,
    ).toBe(false);
    expect(
      skillInvocationV1Schema.safeParse({
        ...invocation,
        payload: { ...invocation.payload, input: { execute: () => undefined } },
      }).success,
    ).toBe(false);
  });

  it("rejects overlong invocations and authorization that expires early", () => {
    expect(
      skillInvocationV1Schema.safeParse({
        ...invocation,
        payload: {
          ...invocation.payload,
          expiresAt: "2026-07-27T08:06:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      skillInvocationV1Schema.safeParse({
        ...invocation,
        payload: {
          ...invocation.payload,
          authorization: {
            ...invocation.payload.authorization,
            expiresAt: "2026-07-27T08:00:30.000Z",
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("SkillExecutionResultV1", () => {
  const completed = {
    schemaVersion: "1.0" as const,
    messageId: "44444444-4444-4444-8444-444444444444",
    traceId: invocation.traceId,
    timestamp: NOW,
    source: { service: "bot-runtime" as const, instanceId: "runtime-01" },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1" as const,
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      outcome: "completed" as const,
      attempts: 1,
      completedAt: NOW,
      output: { moved: true },
    },
  };

  it("accepts a structured completed result", () => {
    expect(parseSkillExecutionResult(completed)).toEqual(completed);
  });

  it("requires errors only for unsuccessful outcomes", () => {
    expect(
      skillExecutionResultV1Schema.safeParse({
        ...completed,
        payload: { ...completed.payload, output: undefined },
      }).success,
    ).toBe(false);
    expect(
      skillExecutionResultV1Schema.safeParse({
        ...completed,
        payload: {
          ...completed.payload,
          outcome: "failed",
          output: undefined,
          errorCode: "SKILL_HANDLER_FAILED",
        },
      }).success,
    ).toBe(false);
    const { output: _output, ...withoutOutput } = completed.payload;
    expect(
      skillExecutionResultV1Schema.safeParse({
        ...completed,
        payload: {
          ...withoutOutput,
          outcome: "failed",
          errorCode: "SKILL_HANDLER_FAILED",
        },
      }).success,
    ).toBe(true);
  });
});

describe("SkillCancellationV1", () => {
  it("accepts a short-lived correlated cancellation and rejects unknown fields", () => {
    const cancellation = {
      schemaVersion: "1.0" as const,
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      traceId: invocation.traceId,
      timestamp: NOW,
      source: invocation.source,
      botId: invocation.botId,
      taskId: invocation.taskId,
      type: "skill.cancel.v1" as const,
      payload: {
        invocationId: invocation.payload.invocationId,
        reason: "task_cancelled" as const,
        expiresAt: "2026-07-27T08:00:30.000Z",
      },
    };
    expect(parseSkillCancellation(cancellation)).toEqual(cancellation);
    expect(() =>
      parseSkillCancellation({ ...cancellation, rawAction: "stopDigging" }),
    ).toThrow();
  });
});
