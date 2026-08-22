import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEAR_POLICY,
  assessGearMatchup,
  assessWorstMatchup,
  gearPower,
  type CombatGearSnapshot,
} from "../src/gear-assessor.js";

function gear(
  overrides: Partial<CombatGearSnapshot> = {},
): CombatGearSnapshot {
  return {
    armorMaterial: "iron",
    protectionLevel: 0,
    weaponDamage: 7,
    health: 20,
    hasTotem: false,
    ...overrides,
  };
}

const IRON_KIT = gear();
const NETHERITE_KIT = gear({
  armorMaterial: "netherite",
  protectionLevel: 4,
  weaponDamage: 10,
  hasTotem: true,
});

describe("gearPower", () => {
  it("ranks armour materials monotonically", () => {
    const materials = [
      "none",
      "leather",
      "golden",
      "chainmail",
      "iron",
      "diamond",
      "netherite",
    ] as const;
    const scores = materials.map((armorMaterial) =>
      gearPower(gear({ armorMaterial })),
    );
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeGreaterThanOrEqual(scores[index - 1] ?? 0);
    }
    // 两端必须真的分开，不能全都并列。
    expect(scores.at(-1)).toBeGreaterThan(scores[0] ?? 0);
  });

  it("counts protection enchantments and a held totem as durability", () => {
    expect(gearPower(gear({ protectionLevel: 4 }))).toBeGreaterThan(
      gearPower(gear({ protectionLevel: 0 })),
    );
    expect(gearPower(gear({ hasTotem: true }))).toBeGreaterThan(
      gearPower(gear({ hasTotem: false })),
    );
  });

  it("does not collapse to zero for a bare fist", () => {
    expect(gearPower(gear({ weaponDamage: 0 }))).toBeGreaterThan(0);
  });

  it("rejects malformed gear", () => {
    expect(() => gearPower(gear({ protectionLevel: 5 }))).toThrowError(TypeError);
    expect(() => gearPower(gear({ health: 21 }))).toThrowError(TypeError);
    expect(() => gearPower(gear({ weaponDamage: Number.NaN }))).toThrowError(
      TypeError,
    );
    expect(() =>
      gearPower({ ...gear(), armorMaterial: "mythril" as never }),
    ).toThrowError(TypeError);
  });
});

describe("assessGearMatchup", () => {
  it("calls a full netherite opponent outclassing an iron kit", () => {
    const assessment = assessGearMatchup(IRON_KIT, NETHERITE_KIT);
    expect(assessment.verdict).toBe("outclassed");
    expect(assessment.shouldAvoid).toBe(true);
    expect(assessment.opponentAdvantage).toBeGreaterThan(1.5);
  });

  it("calls the reverse matchup favourable", () => {
    const assessment = assessGearMatchup(NETHERITE_KIT, IRON_KIT);
    expect(assessment.verdict).toBe("favorable");
    expect(assessment.shouldAvoid).toBe(false);
  });

  it("calls an identical kit even", () => {
    expect(assessGearMatchup(IRON_KIT, IRON_KIT)).toMatchObject({
      verdict: "even",
      shouldAvoid: false,
    });
  });

  it("fails closed when the opponent's gear was never observed", () => {
    expect(assessGearMatchup(IRON_KIT, null)).toMatchObject({
      verdict: "unknown",
      opponentPower: null,
      opponentAdvantage: null,
      shouldAvoid: true,
    });
  });

  it("lets an expendable bot opt out of the unknown-gear refusal", () => {
    expect(
      assessGearMatchup(IRON_KIT, null, {
        ...DEFAULT_GEAR_POLICY,
        treatUnknownAsOutclassed: false,
      }).shouldAvoid,
    ).toBe(false);
  });

  it("treats a dead-weight self as outclassed instead of dividing by zero", () => {
    const assessment = assessGearMatchup(gear({ health: 0 }), IRON_KIT);
    expect(assessment.opponentAdvantage).toBe(Number.POSITIVE_INFINITY);
    expect(assessment.verdict).toBe("outclassed");
  });

  it("honours a stricter ratio", () => {
    const slightlyBetter = gear({ weaponDamage: 8 });
    expect(assessGearMatchup(IRON_KIT, slightlyBetter).verdict).toBe("even");
    expect(
      assessGearMatchup(IRON_KIT, slightlyBetter, {
        ...DEFAULT_GEAR_POLICY,
        outclassedRatio: 1.05,
      }).verdict,
    ).toBe("outclassed");
  });

  it("rejects an out-of-bounds policy", () => {
    expect(() =>
      assessGearMatchup(IRON_KIT, IRON_KIT, {
        ...DEFAULT_GEAR_POLICY,
        outclassedRatio: 1,
      }),
    ).toThrowError(TypeError);
    expect(() =>
      assessGearMatchup(IRON_KIT, IRON_KIT, {
        ...DEFAULT_GEAR_POLICY,
        favorableRatio: 0.5,
      }),
    ).toThrowError(TypeError);
  });
});

describe("assessWorstMatchup", () => {
  it("reports the strongest opponent in the group", () => {
    const assessment = assessWorstMatchup(IRON_KIT, [
      gear({ armorMaterial: "leather", weaponDamage: 1 }),
      NETHERITE_KIT,
    ]);
    expect(assessment.verdict).toBe("outclassed");
  });

  it("ranks an unobserved opponent above a merely even one", () => {
    expect(
      assessWorstMatchup(IRON_KIT, [IRON_KIT, null]).verdict,
    ).toBe("unknown");
  });

  it("is order-independent", () => {
    const group = [gear({ armorMaterial: "leather" }), NETHERITE_KIT, null];
    expect(assessWorstMatchup(IRON_KIT, group)).toEqual(
      assessWorstMatchup(IRON_KIT, [...group].reverse()),
    );
  });

  it("treats an empty group as unobserved rather than safe", () => {
    expect(assessWorstMatchup(IRON_KIT, []).verdict).toBe("unknown");
  });
});
