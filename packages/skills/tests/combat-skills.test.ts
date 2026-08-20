import type { SkillCapability } from "@minecraft-studio/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  combatPveMeleeSkill,
  combatPvpMeleeSkill,
  SkillExecutor,
  SkillRegistry,
  type SkillCapabilityRequest,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-08-20T09:00:00.000Z";
const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";
const RUNTIME = "runtime-combat-test";
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

function command(skillId: string, input: unknown) {
  return {
    schemaVersion: "1.0" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-combat-skills",
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-01" },
    botId: "worker-01",
    taskId: "task-combat-skills",
    type: "skill.invoke.v1" as const,
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expectedRuntimeInstanceId: RUNTIME,
      expectedStateSequence: 1,
      taskVersion: 1,
      expiresAt: "2026-08-20T09:01:00.000Z",
      input,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "coordinator-agent",
        issuedAt: "2026-08-20T08:59:59.000Z",
        expiresAt: "2026-08-20T09:01:00.000Z",
      },
    },
  };
}

function authorization(
  invocation: ReturnType<typeof command>,
  capabilities: readonly SkillCapability[] = ["combat.execute"],
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
  registry.register(combatPveMeleeSkill);
  registry.register(combatPvpMeleeSkill);
  return new SkillExecutor(registry, {
    runtimeInstanceId: RUNTIME,
    capabilityAdapter: { invoke: adapter },
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => "44444444-4444-4444-8444-444444444444",
  });
}

const pvpCompatibility = {
  minecraftVersion: "1.21.8",
  protocolVersion: 772,
  supportsFeature: () => undefined,
  hasResource: () => undefined,
  serverCapability: (name: string) => name === "combat.pvp-enabled",
};

describe("bounded combat skills", () => {
  it("allows PvE only for the fixed hostile-mob schema", async () => {
    const adapter = vi.fn(async () => ({
      targetFound: true,
      targetName: "zombie",
      targetEntityId: 42,
      weaponName: "iron_sword",
      attackAttempts: 2,
      targetStillTracked: false,
      retreated: false,
      finalDistance: null,
    }));
    const valid = command("combat.pve-melee", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      targetTypes: ["zombie", "skeleton"],
      maxDistance: 4,
      maxAttackAttempts: 3,
      retreatHealth: 10,
    });
    expect((await executor(adapter).execute(
      valid,
      authorization(valid),
      state,
    )).payload).toMatchObject({
      outcome: "completed",
      output: { targetName: "zombie", attackAttempts: 2 },
    });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      capability: "combat.execute",
      operation: "combat.pve-melee-safe",
    }));

    const playerAsMob = command("combat.pve-melee", {
      ...valid.payload.input as object,
      targetTypes: ["player"],
    });
    expect((await executor(adapter).execute(
      playerAsMob,
      authorization(playerAsMob),
      state,
    )).payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SKILL_INPUT_INVALID",
    });
  });

  it("keeps PvP unavailable unless the ServerProfile capability was proved", async () => {
    const adapter = vi.fn(async () => ({
      targetFound: false,
      targetName: null,
      targetEntityId: null,
      weaponName: null,
      attackAttempts: 0,
      targetStillTracked: false,
      retreated: false,
      finalDistance: null,
    }));
    const invocation = command("combat.pvp-melee", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      targetUsername: "ArenaBot",
      maxDistance: 4,
      maxAttackAttempts: 2,
      retreatHealth: 10,
    });

    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation),
      state,
    )).payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SKILL_VERSION_UNAVAILABLE",
    });
    expect((await executor(adapter).execute(
      invocation,
      authorization(invocation),
      state,
      undefined,
      pvpCompatibility,
    )).payload.outcome).toBe("completed");
  });

  it("refuses combat when the exact capability is absent", async () => {
    const invocation = command("combat.pve-melee", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      targetTypes: ["zombie"],
      maxDistance: 4,
      maxAttackAttempts: 2,
      retreatHealth: 10,
    });
    expect((await executor(vi.fn()).execute(
      invocation,
      authorization(invocation, ["world.interact"]),
      state,
    )).payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SKILL_CAPABILITY_DENIED",
    });
  });
});
