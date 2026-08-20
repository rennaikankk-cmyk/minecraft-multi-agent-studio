import type { SkillCapability } from "@minecraft-studio/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  consumeFoodSkill,
  inventoryCompactSkill,
  movementRecoverSkill,
  sleepSkill,
  SkillExecutor,
  SkillRegistry,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-08-20T08:00:00.000Z";
const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";
const RUNTIME = "runtime-survival-test";

const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  position: {
    x: 0,
    y: 64,
    z: 0,
    dimension: DIMENSION,
    serverProfileId: SERVER,
  },
};

const compatibility = {
  minecraftVersion: "1.21.8",
  protocolVersion: 772,
  supportsFeature: () => undefined,
  hasResource: (kind: "item" | "block" | "entity", name: string) =>
    kind === "block" && name === "red_bed",
  serverCapability: () => undefined,
};

function invocation(skillId: string, input: unknown) {
  return {
    schemaVersion: "1.0" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-survival-skills",
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-01" },
    botId: "worker-01",
    taskId: "task-survival-skills",
    type: "skill.invoke.v1" as const,
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expectedRuntimeInstanceId: RUNTIME,
      expectedStateSequence: 1,
      taskVersion: 1,
      expiresAt: "2026-08-20T08:01:00.000Z",
      input,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "coordinator-agent",
        issuedAt: "2026-08-20T07:59:59.000Z",
        expiresAt: "2026-08-20T08:01:00.000Z",
      },
    },
  };
}

function authorization(
  command: ReturnType<typeof invocation>,
  capabilities: readonly SkillCapability[],
): SkillExecutionAuthorization {
  return {
    decisionId: command.payload.authorization.decisionId,
    actorId: command.payload.authorization.actorId,
    sourceInstanceId: command.source.instanceId,
    traceId: command.traceId,
    taskId: command.taskId,
    botId: command.botId,
    invocationId: command.payload.invocationId,
    skillId: command.payload.skillId,
    skillVersion: command.payload.skillVersion,
    issuedAt: command.payload.authorization.issuedAt,
    expiresAt: command.payload.authorization.expiresAt,
    allowedCapabilities: new Set(capabilities),
  };
}

function executor(adapter: (request: { operation: string }) => Promise<unknown>) {
  const registry = new SkillRegistry();
  registry.register(consumeFoodSkill);
  registry.register(sleepSkill);
  registry.register(inventoryCompactSkill);
  registry.register(movementRecoverSkill);
  return new SkillExecutor(registry, {
    runtimeInstanceId: RUNTIME,
    capabilityAdapter: { invoke: adapter as never },
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => "44444444-4444-4444-8444-444444444444",
  });
}

describe("survival and recovery built-ins", () => {
  it("consumes only through the bounded safe-food operation", async () => {
    const adapter = vi.fn(async () => ({
      consumed: true,
      itemName: "bread",
      foodLevelBefore: 12,
      foodLevelAfter: 17,
    }));
    const command = invocation("survival.consume-food", {
      serverProfileId: SERVER,
      maximumFoodLevel: 18,
    });
    const result = await executor(adapter).execute(
      command,
      authorization(command, ["inventory.write"]),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { consumed: true, itemName: "bread", foodLevelAfter: 17 },
    });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      capability: "inventory.write",
      operation: "food.consume-best-safe",
    }));
  });

  it("requires an authorized nearby bed in the current world", async () => {
    const adapter = vi.fn(async () => ({ sleeping: true, bed: { x: 1, y: 64, z: 0 } }));
    const valid = invocation("survival.sleep", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      bed: { x: 1, y: 64, z: 0 },
    });
    expect((await executor(adapter).execute(
      valid,
      authorization(valid, ["world.interact"]),
      state,
      undefined,
      compatibility,
    )).payload.outcome).toBe("completed");

    const remote = invocation("survival.sleep", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      bed: { x: 20, y: 64, z: 0 },
    });
    expect((await executor(adapter).execute(
      remote,
      authorization(remote, ["world.interact"]),
      state,
      undefined,
      compatibility,
    )).payload).toMatchObject({
      outcome: "rejected",
      errorCode: "BED_OUT_OF_REACH",
    });
  });

  it("compacts without accepting output that cannot prove preservation", async () => {
    const command = invocation("inventory.compact", {
      serverProfileId: SERVER,
      maxMoves: 12,
    });
    const result = await executor(async () => ({
      movedStacks: 2,
      occupiedSlotsBefore: 10,
      occupiedSlotsAfter: 10,
      totalItemsBefore: 64,
      totalItemsAfter: 64,
      preserved: true,
    })).execute(command, authorization(command, ["inventory.write"]), state);

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { movedStacks: 2, preserved: true },
    });
  });

  it("runs bounded recovery and rejects it while L0 has paused actions", async () => {
    const command = invocation("movement.recover", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      maxAttempts: 3,
    });
    const run = executor(async () => ({
      recovered: true,
      attempts: 1,
      distanceMoved: 0.75,
      finalPosition: { ...state.position, x: 0.75 },
    }));
    expect((await run.execute(
      command,
      authorization(command, ["bot.move"]),
      state,
    )).payload.outcome).toBe("completed");

    expect((await run.execute(
      { ...command, messageId: "55555555-5555-4555-8555-555555555555", payload: {
        ...command.payload,
        invocationId: "66666666-6666-4666-8666-666666666666",
      } },
      {
        ...authorization(command, ["bot.move"]),
        invocationId: "66666666-6666-4666-8666-666666666666",
      },
      { ...state, normalActionsAllowed: false },
    )).payload).toMatchObject({
      outcome: "rejected",
      errorCode: "NORMAL_ACTIONS_PAUSED",
    });
  });
});
