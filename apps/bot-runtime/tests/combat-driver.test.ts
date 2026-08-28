import { baselineServerPolicy, ServerPolicyGate } from "@minecraft-studio/skills";
import type {
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "../src/combat-driver.js";
import { CombatDriver } from "../src/combat-driver.js";
import { describe, expect, it, vi } from "vitest";

const SERVER = "local-isolated-test";
const selfGear = {
  armorMaterial: "iron" as const,
  protectionLevel: 0,
  blastProtectionLevel: 0,
  armorPieceCount: 4,
  weaponDamage: 6,
  health: 20,
  hasTotem: true,
};
const weapon = {
  slot: 0,
  itemName: "iron_sword",
  kind: "sword" as const,
  baseDamage: 6,
  fullCooldownMs: 625,
  durabilityRemaining: 100,
  enchantmentDamageBonus: 0,
};

function observation(
  overrides: Partial<CombatDriverObservation> = {},
): CombatDriverObservation {
  const entity = {
    entity: {
      entityId: 42,
      kind: "player" as const,
      username: "Enemy",
      uuid: null,
    },
    position: { x: 2, y: 64, z: 0 },
    velocity: null,
    health: 20,
    armorPoints: 15,
    wieldingWeapon: true,
    crystalNearby: false,
    anchorNearby: false,
    gear: {
      armorMaterial: "iron" as const,
      protectionLevel: 0,
      blastProtectionLevel: 0,
      armorPieceCount: 4,
      weaponDamage: 6,
      health: 20,
      hasTotem: true,
    },
  };
  return {
    observedAtMs: 1_000,
    serverProfileId: SERVER,
    dimension: "minecraft:overworld",
    latencyMs: 0,
    explosionRuleSet: "java-1.21-release",
    self: {
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      offhandIsTotem: true,
      inventoryTotemCount: 2,
      gear: selfGear,
      orientation: { yaw: -90, pitch: 0 },
      heldItemSlot: 0,
      onGround: true,
      fallDistance: 0,
    },
    entities: [entity],
    weapons: [weapon],
    crystalCandidates: null,
    mineCandidates: null,
    hazards: [],
    ...overrides,
  };
}

function driver(
  overrides: Partial<ConstructorParameters<typeof CombatDriver>[0]> = {},
) {
  return new CombatDriver({
    serverProfileId: SERVER,
    selfUsername: "StudioBot",
    stance: "preserve-life",
    whitelist: { usernames: [], uuids: [] },
    policyGate: new ServerPolicyGate(baselineServerPolicy(SERVER, "VANILLA_COMPATIBLE")),
    reflexProbe: {
      p99LoopDelayMs: 20,
      samples: 1_000,
      underRepresentativeLoad: true,
      serverProfileId: SERVER,
    },
    ...overrides,
  });
}

async function ackExecutor(actions: CombatPrimitiveAction[]) {
  return async (action: CombatPrimitiveAction) => {
    actions.push(action);
    return { outcome: "executed" as const, executedAtMs: 1_005 };
  };
}

describe("CombatDriver W0 deterministic wiring", () => {
  it("treats a non-whitelisted player as hostile and executes only after an ack", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const execute = await ackExecutor(actions);
    const result = await driver().engage(
      observation(),
      1_000,
      execute,
      new AbortController().signal,
    );

    expect(result.actual).toMatchObject({
      disposition: "executed",
      action: "ENGAGE",
      executedAtMs: 1_005,
      targetEntityId: 42,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "MELEE_ATTACK", targetEntityId: 42 });
  });

  it("uses a self POP before a stale offhand snapshot and does not re-equip it twice", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const execute = await ackExecutor(actions);
    const combat = driver();
    const popped = observation({
      self: {
        ...observation().self,
        offhandIsTotem: true,
        totemPopObservedAtMs: 1_000,
      },
    });

    await expect(
      combat.engage(popped, 1_000, execute, new AbortController().signal),
    ).resolves.toMatchObject({
      actual: {
        primitiveAction: "REEQUIP_TOTEM",
        reasonCode: "COMBAT_TOTEM_REEQUIPPED",
      },
    });
    expect(actions).toHaveLength(1);

    const stale = observation({
      observedAtMs: 1_010,
      self: {
        ...observation().self,
        offhandIsTotem: false,
        totemPopObservedAtMs: 1_000,
      },
    });
    await combat.engage(stale, 1_010, execute, new AbortController().signal);
    expect(actions.filter((action) => action.kind === "REEQUIP_TOTEM")).toHaveLength(1);
  });

  it("records use ACKs and throttles repeated placement without blocking attack", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const combat = driver();
    const crystalCandidate = {
      position: { x: 2, y: 64, z: 0 },
      hasValidBase: true,
      spaceObstructed: false,
      targetOcclusion: 0,
      selfOcclusion: 1,
    } as const;
    const first = await combat.engage(
      observation({ crystalCandidates: [crystalCandidate] }),
      1_000,
      async (action) => {
        actions.push(action);
        return { outcome: "executed" as const, executedAtMs: 1_005 };
      },
      new AbortController().signal,
    );
    expect(first.actual.primitiveAction).toBe("PLACE_CRYSTAL");
    expect(combat.interactionAudit()[0]).toMatchObject({
      interactionClass: "use",
      requestedAtMs: 1_000,
      executedAtMs: 1_005,
      ackRttMs: 5,
    });

    const repeated = await combat.engage(
      observation({
        observedAtMs: 1_150,
        crystalCandidates: [crystalCandidate],
      }),
      1_150,
      async (action) => {
        actions.push(action);
        return { outcome: "executed" as const, executedAtMs: 1_155 };
      },
      new AbortController().signal,
    );
    expect(repeated.actual).toMatchObject({
      disposition: "delayed",
      primitiveAction: "NONE",
      reasonCode: "COMBAT_INTERACTION_THROTTLED",
    });
    expect(actions).toHaveLength(1);

    const attack = await combat.engage(
      observation({ observedAtMs: 1_150, crystalCandidates: null }),
      1_150,
      async (action) => {
        actions.push(action);
        return { outcome: "executed" as const, executedAtMs: 1_155 };
      },
      new AbortController().signal,
    );
    expect(attack.actual.primitiveAction).toBe("MELEE_ATTACK");
    expect(actions).toHaveLength(2);
  });

  it("repositions during an observed i-frame instead of wasting a melee swing", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const execute = await ackExecutor(actions);
    const base = observation();
    const entity = base.entities[0]!;
    const result = await driver().engage(
      observation({
        entities: [{ ...entity, invulnerableRemainingMs: 300 }],
      }),
      1_000,
      execute,
      new AbortController().signal,
    );

    expect(result.actual).toMatchObject({
      primitiveAction: "MOVE",
      reasonCode: "COMBAT_HIT_WINDOW_SPACING",
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("MOVE");
  });

  it("withdraws from an independently observed hostile anchor", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const execute = await ackExecutor(actions);
    const base = observation();
    const result = await driver().engage(
      observation({
        entities: [{ ...base.entities[0]!, anchorNearby: true }],
      }),
      1_000,
      execute,
      new AbortController().signal,
    );

    expect(result.actual).toMatchObject({
      action: "RETREAT",
      primitiveAction: "RETREAT_MOVE",
      reasonCode: "COMBAT_ANCHOR_THREAT",
    });
    expect(actions[0]?.kind).toBe("RETREAT_MOVE");
  });

  it("reports an exact i-frame delay once already inside the spacing band", async () => {
    const execute = vi.fn(async () => ({
      outcome: "executed" as const,
      executedAtMs: 1_005,
    }));
    const base = observation();
    const entity = base.entities[0]!;
    const result = await driver().engage(
      observation({
        entities: [{
          ...entity,
          position: { x: 3, y: 64, z: 0 },
          invulnerableRemainingMs: 250,
        }],
      }),
      1_000,
      execute,
      new AbortController().signal,
    );

    expect(result.actual).toMatchObject({
      disposition: "delayed",
      primitiveAction: "NONE",
      reasonCode: "COMBAT_TARGET_INVULNERABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps whitelisted players and animals out of the hostile target set", async () => {
    const execute = vi.fn(async () => ({ outcome: "executed" as const, executedAtMs: 1_005 }));
    const whitelisted = driver({
      whitelist: { usernames: ["Enemy"], uuids: [] },
    });
    const whitelistedResult = await whitelisted.engage(
      observation(),
      1_000,
      execute,
      new AbortController().signal,
    );
    expect(whitelistedResult.actual.reasonCode).toBe("COMBAT_NO_HOSTILE_TARGET");

    const animal = observation({
      entities: [{
        ...observation().entities[0]!,
        entity: {
          ...observation().entities[0]!.entity,
          kind: "animal",
          username: null,
        },
      }],
    });
    const animalResult = await driver().engage(
      animal,
      1_000,
      execute,
      new AbortController().signal,
    );
    expect(animalResult.actual.reasonCode).toBe("COMBAT_NO_HOSTILE_TARGET");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed on a profile mismatch before evaluating target identity", async () => {
    const execute = vi.fn(async () => ({ outcome: "executed" as const, executedAtMs: 1_005 }));
    const result = await driver().engage(
      observation({ serverProfileId: "other-server" }),
      1_000,
      execute,
      new AbortController().signal,
    );
    expect(result.actual.reasonCode).toBe("COMBAT_OBSERVATION_PROFILE_MISMATCH");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a stable unavailable receipt for a malformed observation", async () => {
    const execute = vi.fn(async () => ({ outcome: "executed" as const, executedAtMs: 1_005 }));
    const malformed = observation({
      self: {
        ...observation().self,
        position: { x: Number.NaN, y: 64, z: 0 },
      },
    });
    const result = await driver().engage(
      malformed,
      1_000,
      execute,
      new AbortController().signal,
    );
    expect(result.actual.reasonCode).toBe("COMBAT_OBSERVATION_UNAVAILABLE");
    expect(execute).not.toHaveBeenCalled();
  });

  it("turns an uncleared reflex path into a deterministic retreat and never sends crystal actions", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const execute = await ackExecutor(actions);
    const noProbe = driver({ reflexProbe: null });
    const result = await noProbe.engage(
      observation({ self: { ...observation().self, offhandIsTotem: false } }),
      1_000,
      execute,
      new AbortController().signal,
    );

    expect(result.actual).toMatchObject({
      action: "RETREAT",
      reasonCode: "COMBAT_REFLEX_NOT_CLEARED",
      executedAtMs: 1_005,
    });
    expect(actions.every((action) => action.kind !== "PLACE_CRYSTAL")).toBe(true);
  });

  it("serializes separate combat requests so an ACK records before the next policy check", async () => {
    const actions: CombatPrimitiveAction[] = [];
    let releaseFirst!: () => void;
    const firstAck = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const execute = async (action: CombatPrimitiveAction) => {
      actions.push(action);
      calls += 1;
      if (calls === 1) await firstAck;
      return { outcome: "executed" as const, executedAtMs: calls === 1 ? 1_005 : 1_010 };
    };
    const combat = driver();
    const first = combat.engage(observation(), 1_000, execute, new AbortController().signal);
    const second = combat.engage(observation({ observedAtMs: 1_010 }), 1_010, execute, new AbortController().signal);
    await Promise.resolve();
    expect(actions).toHaveLength(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ actual: { disposition: "executed" } });
    await expect(second).resolves.toMatchObject({
      actual: { disposition: "delayed", reasonCode: "POLICY_ACTION_INTERVAL_TOO_SHORT" },
    });
    expect(actions).toHaveLength(1);
  });

  it("does not carry a cleared probe across reset until the new connection installs one", async () => {
    const actions: CombatPrimitiveAction[] = [];
    const combat = driver();
    combat.reset();
    const blocked = await combat.engage(
      observation(),
      1_000,
      await ackExecutor(actions),
      new AbortController().signal,
    );
    expect(blocked.actual.reasonCode).toBe("COMBAT_REFLEX_NOT_CLEARED");

    combat.setReflexProbe({
      p99LoopDelayMs: 20,
      samples: 1_000,
      underRepresentativeLoad: true,
      serverProfileId: SERVER,
    });
    const laterExecute = async (action: CombatPrimitiveAction) => {
      actions.push(action);
      return { outcome: "executed" as const, executedAtMs: 2_005 };
    };
    const allowed = await combat.engage(
      observation({ observedAtMs: 2_000 }),
      2_000,
      laterExecute,
      new AbortController().signal,
    );
    expect(allowed.actual.executedAtMs).toBe(2_005);
  });

  it("turns a malformed executor acknowledgement into a stable contract failure", async () => {
    const malformed = async () => null as never;
    const result = await driver().engage(
      observation(),
      1_000,
      malformed,
      new AbortController().signal,
    );
    expect(result.actual).toMatchObject({
      disposition: "dropped",
      reasonCode: "COMBAT_EXECUTION_ACK_INVALID",
      executedAtMs: null,
    });
  });

  it("does not execute a queued request from the previous connection", async () => {
    const combat = driver();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const execute = async () => {
      await firstGate;
      return { outcome: "executed" as const, executedAtMs: 1_005 };
    };
    const first = combat.engage(
      observation(),
      1_000,
      execute,
      new AbortController().signal,
    );
    const second = combat.engage(
      observation({ observedAtMs: 1_010 }),
      1_010,
      execute,
      new AbortController().signal,
    );
    await Promise.resolve();
    combat.reset();
    releaseFirst();
    await expect(first).resolves.toMatchObject({
      actual: { reasonCode: "SKILL_EXECUTION_INTERRUPTED" },
    });
    await expect(second).resolves.toMatchObject({
      actual: { reasonCode: "SKILL_EXECUTION_INTERRUPTED" },
    });
  });

  it("does not record an ACK that arrives after cancellation", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = async () => {
      await gate;
      return { outcome: "executed" as const, executedAtMs: 1_005 };
    };
    const request = driver().engage(
      observation(),
      1_000,
      execute,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    release();
    await expect(request).resolves.toMatchObject({
      actual: { reasonCode: "SKILL_CANCELLED", executedAtMs: null },
    });
  });
});
