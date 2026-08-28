import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEAR_POLICY,
  JAVA_1_21_EXPLOSION_RULES,
  assessExplosionProtection,
  assessGearMatchup,
  assessWorstMatchup,
  explosionKnockbackResistance01,
  explosionMitigation01,
  explosionRuleSetForMinecraftVersion,
  gearPower,
  type CombatGearSnapshot,
} from "../src/gear-assessor.js";

function gear(
  overrides: Partial<CombatGearSnapshot> = {},
): CombatGearSnapshot {
  return {
    armorMaterial: "iron",
    protectionLevel: 0,
    blastProtectionLevel: 0,
    armorPieceCount: 4,
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
    expect(() => gearPower(gear({ blastProtectionLevel: 5 }))).toThrowError(
      TypeError,
    );
    expect(() => gearPower(gear({ armorPieceCount: 5 }))).toThrowError(
      TypeError,
    );
    expect(() => gearPower(gear({ health: 21 }))).toThrowError(TypeError);
    expect(() => gearPower(gear({ weaponDamage: Number.NaN }))).toThrowError(
      TypeError,
    );
    expect(() =>
      gearPower({ ...gear(), armorMaterial: "mythril" as never }),
    ).toThrowError(TypeError);
  });
});

describe("explosion protection axis", () => {
  const RULES = JAVA_1_21_EXPLOSION_RULES.id;

  it("combines generic and blast protection under the 80% cap", () => {
    const protectedGear = gear({
      protectionLevel: 1,
      blastProtectionLevel: 4,
      armorPieceCount: 4,
    });
    expect(assessExplosionProtection(protectedGear, RULES)).toMatchObject({
      verified: true,
      totalProtectionLevel: 4,
      totalBlastProtectionLevel: 16,
      mitigation01: 0.8,
      knockbackResistance01: 1,
    });
  });

  it("keeps mitigation and knockback as independent exported scalars", () => {
    const onePiece = gear({
      protectionLevel: 0,
      blastProtectionLevel: 2,
      armorPieceCount: 1,
    });
    expect(explosionMitigation01(onePiece, RULES)).toBeCloseTo(0.16, 10);
    expect(explosionKnockbackResistance01(onePiece, RULES)).toBeCloseTo(
      0.3,
      10,
    );
  });

  it("fails closed to zero mitigation when version rules are unknown", () => {
    const observed = gear({ blastProtectionLevel: 4, armorPieceCount: 4 });
    expect(assessExplosionProtection(observed, null)).toMatchObject({
      verified: false,
      ruleSet: null,
      mitigation01: 0,
      knockbackResistance01: 0,
    });
  });

  it("guards the constants to stable Java 1.21.x only", () => {
    expect(explosionRuleSetForMinecraftVersion("1.21")).toBe(RULES);
    expect(explosionRuleSetForMinecraftVersion("1.21.11")).toBe(RULES);
    expect(explosionRuleSetForMinecraftVersion("1.20.6")).toBeNull();
    expect(explosionRuleSetForMinecraftVersion("1.21-pre4")).toBeNull();
    expect(explosionRuleSetForMinecraftVersion("1.22")).toBeNull();
  });

  it("exposes blast resistance without changing the general verdict", () => {
    const assessment = assessGearMatchup(
      gear({ blastProtectionLevel: 4 }),
      gear({ blastProtectionLevel: 0 }),
      DEFAULT_GEAR_POLICY,
      RULES,
    );
    expect(assessment.verdict).toBe("even");
    expect(assessment.selfExplosionProtection.mitigation01).toBeGreaterThan(
      assessment.opponentExplosionProtection?.mitigation01 ?? 1,
    );
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
