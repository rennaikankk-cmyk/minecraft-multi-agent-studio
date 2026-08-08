import { describe, expect, it, vi } from "vitest";

import {
  decideSlot,
  equipArmorSkill,
  SkillExecutor,
  SkillRegistry,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-08-08T10:00:00.000Z";
const SERVER = "isolated-local";

const invocation = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-armor-001",
  timestamp: NOW,
  source: { service: "coordinator" as const, instanceId: "coordinator-01" },
  botId: "worker-01",
  taskId: "task-armor-001",
  type: "skill.invoke.v1" as const,
  payload: {
    invocationId: "22222222-2222-4222-8222-222222222222",
    skillId: "inventory.equip-armor",
    skillVersion: "1.0.0",
    expiresAt: "2026-08-08T10:01:00.000Z",
    input: { serverProfileId: SERVER },
    authorization: {
      decisionId: "33333333-3333-4333-8333-333333333333",
      actorId: "coordinator-agent",
      issuedAt: "2026-08-08T09:59:59.000Z",
      expiresAt: "2026-08-08T10:01:00.000Z",
    },
  },
};

const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  // The runtime passes a shared skill-state object that also carries position;
  // the equip-armor state schema strips it. Included here to prove that.
  position: {
    x: 0,
    y: 64,
    z: 0,
    dimension: "minecraft:overworld",
    serverProfileId: SERVER,
  },
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
    allowedCapabilities: new Set(["inventory.read", "inventory.write"]),
  };
}

function executor(invoke = vi.fn()) {
  const registry = new SkillRegistry();
  registry.register(equipArmorSkill);
  return {
    invoke,
    executor: new SkillExecutor(registry, {
      runtimeInstanceId: "runtime-01",
      capabilityAdapter: { invoke },
      now: () => new Date(NOW),
      random: () => 0,
      messageId: () => "44444444-4444-4444-8444-444444444444",
    }),
  };
}

function snapshot(
  slots: ReadonlyArray<{
    slot: "head" | "torso" | "legs" | "feet";
    equipped: string | null;
    candidates: string[];
  }>,
) {
  return { serverProfileId: SERVER, slots };
}

describe("decideSlot (re-authored ranking, pure)", () => {
  it("picks the strictly-better candidate over the equipped piece", () => {
    expect(
      decideSlot({ equipped: "iron_chestplate", candidates: ["diamond_chestplate"] }),
    ).toEqual({ best: "diamond_chestplate", bestScore: 8, needsEquip: true });
  });

  it("keeps the equipped piece on a tie (no churn)", () => {
    expect(
      // netherite and diamond chestplate both score 8 — keep what is worn.
      decideSlot({ equipped: "diamond_chestplate", candidates: ["netherite_chestplate"] }),
    ).toEqual({ best: "diamond_chestplate", bestScore: 8, needsEquip: false });
  });

  it("equips when the slot is empty and a candidate exists", () => {
    expect(
      decideSlot({ equipped: null, candidates: ["leather_boots"] }),
    ).toEqual({ best: "leather_boots", bestScore: 1, needsEquip: true });
  });

  it("reports nothing to do for an empty slot with no candidates", () => {
    expect(decideSlot({ equipped: null, candidates: [] })).toEqual({
      best: null,
      bestScore: 0,
      needsEquip: false,
    });
  });
});

describe("inventory.equip-armor@1.0.0", () => {
  it("equips only slots that improve and reports per-slot telemetry", async () => {
    const adapter = vi.fn(async (request: { operation: string; input: unknown }) => {
      if (request.operation === "armor.snapshot") {
        return snapshot([
          // upgrade available
          { slot: "head", equipped: "leather_helmet", candidates: ["diamond_helmet"] },
          // already best (tie) — keep
          { slot: "torso", equipped: "diamond_chestplate", candidates: ["iron_chestplate"] },
          // empty but has a candidate — equip
          { slot: "legs", equipped: null, candidates: ["iron_leggings"] },
          // empty, nothing to wear
          { slot: "feet", equipped: null, candidates: [] },
        ]);
      }
      const equipInput = request.input as { slot: string; itemName: string };
      return { equipped: true, slot: equipInput.slot, itemName: equipInput.itemName };
    });
    const run = executor(adapter);

    const result = await run.executor.execute(invocation, authorization(), state);

    expect(result.payload.outcome).toBe("completed");
    const output = (result.payload as { output: any }).output;
    expect(output.changedCount).toBe(2);
    // snapshot + 2 equips
    expect(output.capabilityCallCount).toBe(3);
    expect(output.slots).toEqual([
      { slot: "head", before: "leather_helmet", after: "diamond_helmet", action: "equipped", beforeScore: 1, afterScore: 3 },
      { slot: "torso", before: "diamond_chestplate", after: "diamond_chestplate", action: "kept", beforeScore: 8, afterScore: 8 },
      { slot: "legs", before: null, after: "iron_leggings", action: "equipped", beforeScore: 0, afterScore: 5 },
      { slot: "feet", before: null, after: null, action: "none-available", beforeScore: 0, afterScore: 0 },
    ]);
    // exactly one read + two writes
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(adapter.mock.calls[0][0]).toMatchObject({
      capability: "inventory.read",
      operation: "armor.snapshot",
    });
  });

  it("makes no writes when everything worn is already best", async () => {
    const adapter = vi.fn(async () =>
      snapshot([
        { slot: "head", equipped: "diamond_helmet", candidates: ["iron_helmet"] },
        { slot: "torso", equipped: "diamond_chestplate", candidates: [] },
        { slot: "legs", equipped: "diamond_leggings", candidates: [] },
        { slot: "feet", equipped: "diamond_boots", candidates: [] },
      ]),
    );
    const run = executor(adapter);

    const result = await run.executor.execute(invocation, authorization(), state);
    const output = (result.payload as { output: any }).output;
    expect(output.changedCount).toBe(0);
    expect(output.capabilityCallCount).toBe(1);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("records action=kept when a physical equip does not stick", async () => {
    const adapter = vi.fn(async (request: { operation: string; input: unknown }) => {
      if (request.operation === "armor.snapshot") {
        return snapshot([
          { slot: "head", equipped: null, candidates: ["iron_helmet"] },
          { slot: "torso", equipped: null, candidates: [] },
          { slot: "legs", equipped: null, candidates: [] },
          { slot: "feet", equipped: null, candidates: [] },
        ]);
      }
      const equipInput = request.input as { slot: string; itemName: string };
      // Client reports the equip did not take effect (fail-closed, no lie).
      return { equipped: false, slot: equipInput.slot, itemName: equipInput.itemName };
    });
    const run = executor(adapter);

    const result = await run.executor.execute(invocation, authorization(), state);
    const output = (result.payload as { output: any }).output;
    expect(output.changedCount).toBe(0);
    expect(output.slots[0]).toEqual({
      slot: "head",
      before: null,
      after: null,
      action: "kept",
      beforeScore: 0,
      afterScore: 0,
    });
  });

  it("rejects when normal actions are paused, before any capability call", async () => {
    const run = executor();
    const result = await run.executor.execute(invocation, authorization(), {
      ...state,
      normalActionsAllowed: false,
    });
    expect(result.payload.errorCode).toBe("NORMAL_ACTIONS_PAUSED");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("rejects a server-profile mismatch before any capability call", async () => {
    const run = executor();
    const result = await run.executor.execute(invocation, authorization(), {
      ...state,
      serverProfileId: "some-other-server",
    });
    expect(result.payload.errorCode).toBe("TARGET_SERVER_PROFILE_MISMATCH");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});
