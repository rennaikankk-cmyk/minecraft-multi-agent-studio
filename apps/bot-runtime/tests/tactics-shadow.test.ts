import { describe, expect, it } from "vitest";

import { DEFAULT_TACTICS_PROFILE, scoreTacticalActions } from "@minecraft-studio/combat";

import type { BotClientSnapshot } from "../src/client.js";
import type { CombatDriverObservation } from "../src/combat-driver.js";
import {
  buildTacticsShadowSnapshot,
  emergencySignalFromObservation,
  resolveTacticsCoreEnabled,
} from "../src/tactics-shadow.js";

const SERVER = "local-isolated-test";

const snapshot: BotClientSnapshot = {
  health: { current: 18, maximum: 20 },
  food: { level: 16, saturation: 4.5 },
  armorPoints: 7,
  armorSlots: { head: null, chest: null, legs: null, feet: null },
  inventory: [{ itemName: "golden_apple", count: 3 }],
  position: { x: 10.25, y: 64, z: -20.5, dimension: "minecraft:overworld" },
  latencyMs: 45,
  safety: {
    oxygenLevel: 20,
    inWater: false,
    inLava: false,
    onGround: true,
    velocityY: 0,
    inventory: { usedSlots: 4, totalSlots: 36 },
    hasSafeFood: true,
    movementRequested: false,
  },
};

function observation(): CombatDriverObservation {
  return {
    observedAtMs: 1_000,
    serverProfileId: SERVER,
    dimension: "minecraft:overworld",
    latencyMs: 0,
    explosionRuleSet: "java-1.21-release",
    self: {
      position: { x: 10, y: 64, z: -20 },
      health: 18,
      offhandIsTotem: true,
      inventoryTotemCount: 1,
      gear: {
        armorMaterial: "iron",
        protectionLevel: 0,
        blastProtectionLevel: 0,
        armorPieceCount: 4,
        weaponDamage: 6,
        health: 18,
        hasTotem: true,
      },
      orientation: { yaw: -90, pitch: 0 },
      heldItemSlot: 0,
      onGround: true,
      fallDistance: 0,
    },
    entities: [{
      entity: { entityId: 42, kind: "player", username: "Enemy", uuid: null },
      position: { x: 12, y: 64, z: -20 },
      velocity: null,
      health: null,
      armorPoints: 7,
      wieldingWeapon: true,
      crystalNearby: false,
      anchorNearby: false,
      recentlyPopped: true,
      gear: null,
    }],
    weapons: [{
      slot: 0,
      itemName: "iron_sword",
      kind: "sword",
      baseDamage: 6,
      fullCooldownMs: 625,
      durabilityRemaining: 100,
      enchantmentDamageBonus: 0,
    }],
    crystalCandidates: null,
    mineCandidates: null,
    hazards: [],
  };
}

describe("resolveTacticsCoreEnabled", () => {
  it("defaults OFF for unset/empty and fails closed on garbage", () => {
    expect(resolveTacticsCoreEnabled({})).toBe(false);
    expect(resolveTacticsCoreEnabled({ STUDIO_TACTICS_CORE: "" })).toBe(false);
    expect(resolveTacticsCoreEnabled({ STUDIO_TACTICS_CORE: "1" })).toBe(true);
    expect(() => resolveTacticsCoreEnabled({ STUDIO_TACTICS_CORE: "0" })).toThrow();
    expect(() => resolveTacticsCoreEnabled({ STUDIO_TACTICS_CORE: "yes" })).toThrow(
      /STUDIO_TACTICS_CORE/,
    );
  });
});

describe("buildTacticsShadowSnapshot", () => {
  it("maps honest sources, keeps player health as prior, and is scoreable", () => {
    const combatSnapshot = buildTacticsShadowSnapshot({
      nowMonotonicMs: 10_000,
      stepMs: 100,
      observation: observation(),
      snapshot,
      gameplayProfile: "standard",
      stance: "preserve-life",
      compatMode: "STRICT",
      serverRejectionSignals: 2,
    });
    expect(combatSnapshot.self).toMatchObject({
      health: 18,
      food: 16,
      totemsAvailable: 1,
      stance: "preserve-life",
    });
    expect(combatSnapshot.self.consumables.goldenApples).toBe(3);
    expect(combatSnapshot.self.offhand.totemReady).toBe(true);
    expect(combatSnapshot.self.weapon).toEqual({ id: "iron_sword", cooldownProgress: 0 });
    // 玩家血量不可知 → 保持先验区间，不编造。
    expect(combatSnapshot.target?.health.intervalHp).toEqual({ lo: 8, hi: 20 });
    expect(combatSnapshot.world.dimension).toBe("overworld");
    expect(combatSnapshot.policy).toMatchObject({
      gameplayProfile: "standard",
      compatMode: "STRICT",
      explosiveCrystalGateOpen: false,
      serverRejectionSignals: 2,
    });

    const verdict = scoreTacticalActions(combatSnapshot, DEFAULT_TACTICS_PROFILE);
    expect(verdict.scores.length).toBeGreaterThan(0);
  });

  it("maps a pop-window target to the TOTEM_POP_EVENT emergency signal", () => {
    expect(emergencySignalFromObservation(observation())).toBe("TOTEM_POP_EVENT");
    const withoutPop = observation();
    delete (withoutPop.entities[0] as { recentlyPopped?: boolean }).recentlyPopped;
    expect(emergencySignalFromObservation(withoutPop)).toBeNull();
  });
});
