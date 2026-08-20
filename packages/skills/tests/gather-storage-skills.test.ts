import type { SkillCapability } from "@minecraft-studio/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  collectDropsSkill,
  farmCropSkill,
  fishOnceSkill,
  SkillExecutor,
  SkillRegistry,
  storageAccountSkill,
  type SkillCapabilityRequest,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-08-20T10:00:00.000Z";
const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";
const RUNTIME = "runtime-gather-test";
const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  position: { x: 0, y: 64, z: 0, dimension: DIMENSION, serverProfileId: SERVER },
};

function command(skillId: string, input: unknown) {
  return {
    schemaVersion: "1.0" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-gather-skills",
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-01" },
    botId: "worker-01",
    taskId: "task-gather-skills",
    type: "skill.invoke.v1" as const,
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expectedRuntimeInstanceId: RUNTIME,
      expectedStateSequence: 1,
      taskVersion: 1,
      expiresAt: "2026-08-20T10:01:00.000Z",
      input,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "coordinator-agent",
        issuedAt: "2026-08-20T09:59:59.000Z",
        expiresAt: "2026-08-20T10:01:00.000Z",
      },
    },
  };
}

function authorization(
  invocation: ReturnType<typeof command>,
  capabilities: readonly SkillCapability[],
): SkillExecutionAuthorization {
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
    allowedCapabilities: new Set(capabilities),
  };
}

function executor(adapter: (request: SkillCapabilityRequest) => Promise<unknown>) {
  const registry = new SkillRegistry();
  registry.register(storageAccountSkill);
  registry.register(collectDropsSkill);
  registry.register(farmCropSkill);
  registry.register(fishOnceSkill);
  return new SkillExecutor(registry, {
    runtimeInstanceId: RUNTIME,
    capabilityAdapter: { invoke: adapter },
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => "44444444-4444-4444-8444-444444444444",
  });
}

const compatibility = {
  minecraftVersion: "1.21.8",
  protocolVersion: 772,
  supportsFeature: () => undefined,
  hasResource: (kind: "item" | "block" | "entity", name: string) =>
    (kind === "block" && name === "wheat") ||
    (kind === "item" && name === "fishing_rod"),
  serverCapability: () => undefined,
};

describe("gathering and storage built-ins", () => {
  it("accounts only requested resources with read-only capabilities", async () => {
    const adapter = vi.fn(async () => ({
      containerName: "chest",
      containerUsedSlots: 2,
      containerTotalSlots: 27,
      items: [{ itemName: "cobblestone", inventoryCount: 8, containerCount: 64, totalCount: 72 }],
    }));
    const invocation = command("storage.account", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      container: { x: 1, y: 64, z: 0 },
      itemNames: ["cobblestone"],
    });
    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation, ["container.read", "inventory.read"]),
      state,
    )).payload).toMatchObject({ outcome: "completed", output: { containerUsedSlots: 2 } });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      capability: "container.read",
      operation: "container.account-safe",
    }));
  });

  it("collects only explicitly named dropped items through bounded movement", async () => {
    const adapter = vi.fn(async () => ({
      targetsFound: 2,
      itemsCollected: 5,
      items: [{ itemName: "oak_log", count: 5 }],
    }));
    const invocation = command("collect.drops", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      itemNames: ["oak_log"],
      maxCount: 4,
      maxDistance: 16,
    });
    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation, ["bot.move", "inventory.write"]),
      state,
    )).payload).toMatchObject({ outcome: "completed", output: { itemsCollected: 5 } });
  });

  it("harvests only mature supported crops and requires replant telemetry", async () => {
    const adapter = vi.fn(async () => ({
      cropName: "wheat",
      seedItemName: "wheat_seeds",
      matureTargetsFound: 3,
      harvested: 3,
      replanted: 3,
    }));
    const invocation = command("farm.crop", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      cropName: "wheat",
      maxCount: 4,
      maxDistance: 16,
    });
    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation, ["bot.move", "world.interact", "inventory.write"]),
      state,
      undefined,
      compatibility,
    )).payload).toMatchObject({ outcome: "completed", output: { harvested: 3, replanted: 3 } });
  });

  it("casts once and reports only inventory read-back gains", async () => {
    const adapter = vi.fn(async () => ({ caught: true, itemsGained: 1, itemName: "cod" }));
    const invocation = command("gather.fish-once", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
    });
    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation, ["world.interact", "inventory.write"]),
      state,
      undefined,
      compatibility,
    )).payload).toMatchObject({ outcome: "completed", output: { caught: true, itemName: "cod" } });
  });
});
