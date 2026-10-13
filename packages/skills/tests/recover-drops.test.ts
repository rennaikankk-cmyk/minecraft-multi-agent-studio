import { describe, expect, it, vi } from "vitest";

import {
  recoverDropsSkill,
  SkillExecutor,
  SkillFault,
  SkillRegistry,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-07-27T10:00:00.000Z";
const input = {
  target: {
    x: 12,
    y: 64,
    z: -6,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
};
const invocation = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-recover-001",
  timestamp: NOW,
  source: { service: "coordinator" as const, instanceId: "coordinator-01" },
  botId: "worker-01",
  taskId: "task-recover-001",
  type: "skill.invoke.v1" as const,
  payload: {
    invocationId: "22222222-2222-4222-8222-222222222222",
    skillId: "recover.drops",
    skillVersion: "1.0.0",
    expiresAt: "2026-07-27T10:01:00.000Z",
    input,
    authorization: {
      decisionId: "33333333-3333-4333-8333-333333333333",
      actorId: "coordinator-agent",
      issuedAt: "2026-07-27T09:59:59.000Z",
      expiresAt: "2026-07-27T10:01:00.000Z",
    },
  },
};
const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: "isolated-local",
  position: {
    x: 10,
    y: 64,
    z: -5,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
};
const cleared = {
  reached: true as const,
  finalPosition: { ...input.target, x: 12.2, y: 64, z: -5.8 },
  distanceToTarget: 0.4,
  recovered: [{ itemId: "diamond_sword", count: 1 }],
  stillNearby: 0,
  expectedMissing: [],
};

function authorization(): SkillExecutionAuthorization {
  return {
    decisionId: invocation.payload.authorization.decisionId,
    actorId: invocation.payload.authorization.actorId,
    sourceInstanceId: invocation.source.instanceId,
    traceId: invocation.traceId,
    taskId: invocation.taskId,
    botId: invocation.botId,
    invocationId: invocation.payload.invocationId,
    skillId: invocation.payload.skillId,
    skillVersion: invocation.payload.skillVersion,
    issuedAt: invocation.payload.authorization.issuedAt,
    expiresAt: invocation.payload.authorization.expiresAt,
    allowedCapabilities: new Set(["bot.move"]),
  };
}

function executor(invoke = vi.fn()) {
  const registry = new SkillRegistry();
  registry.register(recoverDropsSkill);
  return new SkillExecutor(registry, {
    runtimeInstanceId: "runtime-01",
    capabilityAdapter: { invoke },
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => "44444444-4444-4444-8444-444444444444",
  });
}

describe("recover.drops@1.0.0", () => {
  it("asks the runtime to prove the drops are gone", async () => {
    const invoke = vi.fn(async () => cleared);
    const result = await executor(invoke).execute(invocation, authorization(), state);
    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { stillNearby: 0, recovered: [{ itemId: "diamond_sword", count: 1 }] },
    });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      capability: "bot.move",
      operation: "drops.recover-safe",
      input,
    }));
  });

  it("retries once when the item is still on the ground", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new SkillFault("DROPS_STILL_PRESENT"))
      .mockResolvedValueOnce(cleared);
    const result = await executor(invoke).execute(invocation, authorization(), state);
    expect(result.payload).toMatchObject({ outcome: "completed", attempts: 2 });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("refuses a death point outside the safe path before moving", async () => {
    const invoke = vi.fn();
    const far = {
      ...invocation,
      payload: {
        ...invocation.payload,
        input: { target: { ...input.target, x: 10 + 65 } },
      },
    };
    const result = await executor(invoke).execute(far, authorization(), state);
    expect(result.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "TARGET_OUT_OF_SAFE_RANGE",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
