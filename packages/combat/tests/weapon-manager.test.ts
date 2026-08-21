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
  });
});
