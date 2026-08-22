import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEAPON_POLICY,
  WeaponManager,
  type CombatWeaponCandidate,
} from "../src/weapon-manager.js";

function weapon(
  overrides: Partial<CombatWeaponCandidate> = {},
): CombatWeaponCandidate {
  return {
    slot: 0,
    itemName: "minecraft:diamond_sword",
    kind: "sword",
    baseDamage: 7,
    fullCooldownMs: 625,
    durabilityRemaining: 800,
    enchantmentDamageBonus: 0,
    ...overrides,
  };
}

describe("WeaponManager.select", () => {
  it("picks the highest effective damage including enchantments", () => {
    const selection = new WeaponManager().select([
      weapon({ slot: 0, baseDamage: 7, enchantmentDamageBonus: 0 }),
      weapon({
        slot: 1,
        itemName: "minecraft:iron_axe",
        kind: "axe",
        baseDamage: 6,
        enchantmentDamageBonus: 3,
      }),
    ]);
    expect(selection.weapon?.slot).toBe(1);
    expect(selection.effectiveDamage).toBe(9);
    expect(selection.excludedSlots).toEqual([]);
  });

  it("excludes weapons below the durability floor instead of breaking them", () => {
    const selection = new WeaponManager().select([
      weapon({ slot: 0, baseDamage: 9, durabilityRemaining: 5 }),
      weapon({ slot: 1, baseDamage: 4, durabilityRemaining: 500 }),
    ]);
    expect(selection.weapon?.slot).toBe(1);
    expect(selection.excludedSlots).toEqual([0]);
  });

  it("reports no weapon rather than silently falling back to fists", () => {
    const selection = new WeaponManager().select([
      weapon({ slot: 0, durabilityRemaining: 1 }),
      weapon({ slot: 3, durabilityRemaining: 2 }),
    ]);
    expect(selection.weapon).toBeNull();
    expect(selection.effectiveDamage).toBe(0);
    expect(selection.excludedSlots).toEqual([0, 3]);
  });

  it("treats unbreakable items as always eligible", () => {
    const selection = new WeaponManager().select([
      weapon({ slot: 2, durabilityRemaining: null }),
    ]);
    expect(selection.weapon?.slot).toBe(2);
  });

  it("breaks damage ties by the lower slot for a stable result", () => {
    const candidates = [
      weapon({ slot: 5 }),
      weapon({ slot: 2 }),
      weapon({ slot: 8 }),
    ];
    expect(new WeaponManager().select(candidates).weapon?.slot).toBe(2);
    // 顺序颠倒也要得到同一结果。
    expect(
      new WeaponManager().select([...candidates].reverse()).weapon?.slot,
    ).toBe(2);
  });

  it("rejects malformed candidate data", () => {
    expect(() =>
      new WeaponManager().select([weapon({ fullCooldownMs: 0 })]),
    ).toThrowError(TypeError);
    expect(() =>
      new WeaponManager().select([weapon({ baseDamage: Number.NaN })]),
    ).toThrowError(TypeError);
  });
});

describe("WeaponManager.evaluateSwing", () => {
  it("attacks on the first swing and then waits out the cooldown", () => {
    const manager = new WeaponManager();
    const sword = weapon();

    expect(manager.evaluateSwing(sword, 1_000, true)).toMatchObject({
      shouldAttack: true,
      cooldownRatio: 1,
      reason: "READY",
    });
    manager.recordSwing(sword, 1_000);

    // 立刻再打：冷却为 0，必须拒绝。
    const immediate = manager.evaluateSwing(sword, 1_000, true);
    expect(immediate).toMatchObject({ shouldAttack: false, reason: "COOLDOWN" });
    expect(immediate.waitMs).toBeGreaterThan(0);

    // 恢复到 80%：仍低于 0.9 阈值。
    expect(manager.evaluateSwing(sword, 1_500, true).shouldAttack).toBe(false);
    // 恢复到 0.9 以上：可以打。
    expect(manager.evaluateSwing(sword, 1_570, true)).toMatchObject({
      shouldAttack: true,
      reason: "READY",
    });
  });

  it("reports the exact remaining wait so the caller need not poll blindly", () => {
    const manager = new WeaponManager();
    const sword = weapon({ fullCooldownMs: 600 });
    manager.recordSwing(sword, 0);
    const decision = manager.evaluateSwing(sword, 100, true);
    // 需要 0.9 * 600 = 540ms，已过 100ms，还差 440ms。
    expect(decision.waitMs).toBe(440);
    expect(manager.evaluateSwing(sword, 540, true).shouldAttack).toBe(true);
  });

  it("prioritises reach failure over cooldown state", () => {
    const manager = new WeaponManager();
    const sword = weapon();
    manager.recordSwing(sword, 0);
    expect(manager.evaluateSwing(sword, 10, false)).toMatchObject({
      shouldAttack: false,
      reason: "OUT_OF_RANGE",
    });
  });

  it("refuses to attack with no weapon", () => {
    expect(new WeaponManager().evaluateSwing(null, 0, true)).toMatchObject({
      shouldAttack: false,
      reason: "NO_WEAPON",
      cooldownRatio: 0,
    });
  });

  it("scales the cooldown to the weapon that was actually swung", () => {
    const manager = new WeaponManager();
    const axe = weapon({ kind: "axe", fullCooldownMs: 1_000 });
    manager.recordSwing(axe, 0);
    // 慢武器的冷却更长：625ms 对剑够了，对斧不够。
    expect(manager.evaluateSwing(axe, 625, true).shouldAttack).toBe(false);
    expect(manager.evaluateSwing(axe, 900, true).shouldAttack).toBe(true);
  });

  it("clears cooldown memory on reset", () => {
    const manager = new WeaponManager();
    const sword = weapon();
    manager.recordSwing(sword, 10_000);
    expect(manager.evaluateSwing(sword, 10_010, true).shouldAttack).toBe(false);
    manager.reset();
    expect(manager.evaluateSwing(sword, 10_010, true)).toMatchObject({
      shouldAttack: true,
      cooldownRatio: 1,
    });
  });

  it("refuses a swing record that travels backwards in time", () => {
    const manager = new WeaponManager();
    const sword = weapon();
    manager.recordSwing(sword, 5_000);
    expect(() => manager.recordSwing(sword, 4_999)).toThrowError(RangeError);
  });

  it("rejects a policy that would throw away damage", () => {
    expect(
      () =>
        new WeaponManager({
          ...DEFAULT_WEAPON_POLICY,
          minimumCooldownRatio: 0.5,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new WeaponManager({
          ...DEFAULT_WEAPON_POLICY,
          minimumCooldownRatio: 1.5,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new WeaponManager({ ...DEFAULT_WEAPON_POLICY, minimumDrawRatio: 0.1 }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new WeaponManager({ ...DEFAULT_WEAPON_POLICY, meleePreferredRange: 0 }),
    ).toThrowError(TypeError);
  });
});

function bow(
  overrides: Partial<CombatWeaponCandidate> = {},
): CombatWeaponCandidate {
  return {
    slot: 4,
    itemName: "minecraft:bow",
    kind: "bow",
    baseDamage: 9,
    fullCooldownMs: 1_000,
    durabilityRemaining: 300,
    enchantmentDamageBonus: 0,
    ammoRemaining: 64,
    drawTimeMs: 1_000,
    effectiveRange: 40,
    ...overrides,
  };
}

describe("WeaponManager ranged and melee division of labour", () => {
  it("prefers melee inside the melee window even when the bow hits harder", () => {
    const selection = new WeaponManager().select(
      [weapon({ slot: 0, baseDamage: 7 }), bow({ baseDamage: 9 })],
      2,
    );
    expect(selection.mode).toBe("melee");
    expect(selection.weapon?.slot).toBe(0);
  });

  it("switches to the bow once the target is out of the melee window", () => {
    const selection = new WeaponManager().select(
      [weapon({ slot: 0, baseDamage: 7 }), bow({ baseDamage: 9 })],
      20,
    );
    expect(selection.mode).toBe("ranged");
    expect(selection.weapon?.kind).toBe("bow");
    expect(selection.effectiveDamage).toBe(9);
  });

  it("excludes a bow with no arrows and reports it separately from durability", () => {
    const selection = new WeaponManager().select(
      [weapon({ slot: 0 }), bow({ ammoRemaining: 0 })],
      20,
    );
    expect(selection.outOfAmmoSlots).toEqual([4]);
    expect(selection.excludedSlots).toEqual([]);
    // 够不到也没箭：退回近战好过完全不选。
    expect(selection.mode).toBe("melee");
  });

  it("ignores a ranged weapon whose range cannot reach the target", () => {
    const selection = new WeaponManager().select(
      [bow({ effectiveRange: 10 })],
      30,
    );
    expect(selection.weapon).toBeNull();
    expect(selection.mode).toBeNull();
  });

  it("keeps the old melee-only behaviour when no distance is given", () => {
    const selection = new WeaponManager().select([weapon(), bow()]);
    expect(selection.mode).toBe("melee");
  });

  it("holds the draw until the damage threshold and then releases", () => {
    const manager = new WeaponManager();
    const weaponBow = bow();
    expect(manager.evaluateRanged(weaponBow, 0, 20, false)).toMatchObject({
      action: "DRAW",
      reason: "NOT_DRAWING",
    });
    manager.recordDrawStart(0);
    const early = manager.evaluateRanged(weaponBow, 500, 20, true);
    expect(early).toMatchObject({ action: "HOLD", reason: "DRAWING" });
    // 需要 0.85 * 1000 = 850ms，已过 500ms，还差 350ms。
    expect(early.waitMs).toBe(350);
    expect(manager.evaluateRanged(weaponBow, 850, 20, true)).toMatchObject({
      action: "RELEASE",
      reason: "RELEASE_READY",
    });
  });

  it("resets the draw after releasing so the next arrow is drawn again", () => {
    const manager = new WeaponManager();
    const weaponBow = bow();
    manager.recordDrawStart(0);
    expect(manager.evaluateRanged(weaponBow, 900, 20, true).action).toBe(
      "RELEASE",
    );
    manager.recordRelease();
    expect(manager.evaluateRanged(weaponBow, 900, 20, true).action).toBe("DRAW");
  });

  it("tells the caller to close in rather than firing point blank", () => {
    const manager = new WeaponManager();
    manager.recordDrawStart(0);
    expect(manager.evaluateRanged(bow(), 2_000, 2, true)).toMatchObject({
      action: "NONE",
      reason: "TOO_CLOSE",
    });
  });

  it("refuses the ranged path for melee weapons, no ammo, and no target reach", () => {
    const manager = new WeaponManager();
    manager.recordDrawStart(0);
    expect(manager.evaluateRanged(weapon(), 500, 20, true).reason).toBe(
      "NOT_RANGED",
    );
    expect(
      manager.evaluateRanged(bow({ ammoRemaining: 0 }), 500, 20, true).reason,
    ).toBe("OUT_OF_AMMO");
    expect(
      manager.evaluateRanged(bow({ effectiveRange: 10 }), 500, 30, true).reason,
    ).toBe("OUT_OF_RANGE");
    expect(manager.evaluateRanged(null, 500, 20, true).reason).toBe("NO_WEAPON");
  });

  it("clears draw memory on reset", () => {
    const manager = new WeaponManager();
    manager.recordDrawStart(1_000);
    expect(manager.evaluateRanged(bow(), 2_000, 20, true).action).toBe("RELEASE");
    manager.reset();
    expect(manager.evaluateRanged(bow(), 2_000, 20, true).action).toBe("DRAW");
  });

  it("rejects a ranged candidate missing its range or draw time", () => {
    const manager = new WeaponManager();
    expect(() =>
      manager.select([bow({ effectiveRange: undefined })], 20),
    ).toThrowError(TypeError);
    expect(() =>
      manager.select([bow({ drawTimeMs: undefined })], 20),
    ).toThrowError(TypeError);
    expect(() =>
      manager.select([bow({ ammoRemaining: 1.5 })], 20),
    ).toThrowError(TypeError);
    expect(() => manager.select([weapon()], -1)).toThrowError(TypeError);
  });

  it("refuses a draw record that travels backwards in time", () => {
    const manager = new WeaponManager();
    manager.recordDrawStart(5_000);
    expect(() => manager.recordDrawStart(4_999)).toThrowError(RangeError);
  });

  it("treats a loaded crossbow as ready without re-drawing", () => {
    const manager = new WeaponManager();
    const crossbow = bow({
      slot: 5,
      itemName: "minecraft:crossbow",
      kind: "crossbow",
      drawTimeMs: 1_250,
    });
    expect(manager.select([crossbow], 20).mode).toBe("ranged");
    manager.recordDrawStart(0);
    expect(manager.evaluateRanged(crossbow, 1_250, 20, true).action).toBe(
      "RELEASE",
    );
  });
});
