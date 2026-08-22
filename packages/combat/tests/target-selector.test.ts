import { describe, expect, it } from "vitest";

import {
  CombatPolicyError,
  DEFAULT_ENGAGEMENT_POLICY,
  TargetSelector,
  validateEngagementPolicy,
  type CombatEngagementPolicy,
} from "../src/target-selector.js";
import type {
  CombatThreat,
  CombatThreatAssessment,
} from "../src/threat-analyzer.js";

function threat(overrides: Partial<CombatThreat> = {}): CombatThreat {
  return {
    entityId: 1,
    allegiance: "hostile",
    score: 55,
    distance: 5,
    closingSpeed: null,
    reasons: ["WITHIN_CRYSTAL_RANGE"],
    ...overrides,
  };
}

function assessment(
  threats: readonly CombatThreat[],
): CombatThreatAssessment {
  return {
    evaluatedAtMs: 2_000,
    level: threats.length === 0 ? "none" : "elevated",
    threats,
    hostileCount: threats.length,
    totemDepleted: false,
  };
}

describe("TargetSelector", () => {
  it("picks the highest-threat hostile already ordered by the analyzer", () => {
    const decision = new TargetSelector().select(
      assessment([
        threat({ entityId: 4, score: 80, distance: 3 }),
        threat({ entityId: 9, score: 20, distance: 10 }),
      ]),
      20,
      2,
    );
    expect(decision).toMatchObject({
      evaluatedAtMs: 2_000,
      refusal: null,
      engageableCount: 2,
    });
    expect(decision.target?.entityId).toBe(4);
  });

  it("refuses to engage when health is below the survival floor", () => {
    const decision = new TargetSelector().select(assessment([threat()]), 8, 2);
    expect(decision).toMatchObject({
      target: null,
      refusal: "HEALTH_BELOW_ENGAGE_FLOOR",
    });
  });

  it("refuses to engage without the required totem reserve", () => {
    const decision = new TargetSelector().select(assessment([threat()]), 20, 0);
    expect(decision).toMatchObject({
      target: null,
      refusal: "TOTEM_RESERVE_INSUFFICIENT",
    });
  });

  it("refuses to engage when outnumbered beyond the policy ceiling", () => {
    const crowd = [1, 2, 3, 4].map((entityId) => threat({ entityId }));
    const decision = new TargetSelector().select(assessment(crowd), 20, 2);
    expect(decision).toMatchObject({
      target: null,
      refusal: "OUTNUMBERED",
      engageableCount: 4,
    });
  });

  it("checks self-preservation before the enemy count", () => {
    // 血量不足且寡不敌众时，报的是血量 —— 保命闸门优先，顺序是确定的。
    const crowd = [1, 2, 3, 4].map((entityId) => threat({ entityId }));
    expect(new TargetSelector().select(assessment(crowd), 5, 2).refusal).toBe(
      "HEALTH_BELOW_ENGAGE_FLOOR",
    );
  });

  it("ignores hostiles beyond the engage distance", () => {
    const decision = new TargetSelector().select(
      assessment([threat({ distance: 40 })]),
      20,
      2,
    );
    expect(decision).toMatchObject({
      target: null,
      refusal: "NO_HOSTILE_IN_RANGE",
      engageableCount: 0,
    });
  });

  it("reports no hostile when the field is empty", () => {
    expect(new TargetSelector().select(assessment([]), 20, 2)).toMatchObject({
      target: null,
      refusal: "NO_HOSTILE_IN_RANGE",
    });
  });

  it("honours a tightened operator policy", () => {
    const strict: CombatEngagementPolicy = {
      ...DEFAULT_ENGAGEMENT_POLICY,
      maximumEngageDistance: 4,
      maximumHostileCount: 1,
    };
    const selector = new TargetSelector(strict);
    expect(selector.select(assessment([threat({ distance: 6 })]), 20, 2)).toMatchObject(
      { refusal: "NO_HOSTILE_IN_RANGE" },
    );
    expect(
      selector.select(
        assessment([
          threat({ entityId: 1, distance: 2 }),
          threat({ entityId: 2, distance: 3 }),
        ]),
        20,
        2,
      ),
    ).toMatchObject({ refusal: "OUTNUMBERED", engageableCount: 2 });
    // 收紧后仍能正常交战：距离内、数量不超限时照打。
    expect(
      selector.select(assessment([threat({ entityId: 1, distance: 2 })]), 20, 2)
        .target?.entityId,
    ).toBe(1);
  });

  it("rejects an out-of-bounds policy instead of clamping it", () => {
    // AI 只能调阈值，不能把保命闸门调到失效。
    for (const override of [
      { minimumEngageHealth: 0 },
      { minimumEngageHealth: 999 },
      { minimumTotemCount: -1 },
      { maximumHostileCount: 0 },
      { maximumEngageDistance: 1_000 },
      { maximumEngageDistance: Number.NaN },
    ] satisfies readonly Partial<CombatEngagementPolicy>[]) {
      expect(
        () => new TargetSelector({ ...DEFAULT_ENGAGEMENT_POLICY, ...override }),
      ).toThrowError(CombatPolicyError);
    }
    expect(validateEngagementPolicy(DEFAULT_ENGAGEMENT_POLICY)).toBe(
      DEFAULT_ENGAGEMENT_POLICY,
    );
  });

  it("rejects malformed self state", () => {
    const selector = new TargetSelector();
    expect(() => selector.select(assessment([threat()]), Number.NaN, 1)).toThrowError(
      TypeError,
    );
    expect(() => selector.select(assessment([threat()]), 20, 1.5)).toThrowError(
      TypeError,
    );
  });
});

describe("TargetSelector gear gate", () => {
  const OUTCLASSED = {
    verdict: "outclassed",
    selfPower: 100,
    opponentPower: 400,
    opponentAdvantage: 4,
    shouldAvoid: true,
  } as const;

  it("refuses to engage a target whose gear outclasses ours", () => {
    const decision = new TargetSelector().select(
      assessment([threat()]),
      20,
      2,
      OUTCLASSED,
    );
    expect(decision).toMatchObject({
      target: null,
      refusal: "GEAR_OUTCLASSED",
      engageableCount: 1,
    });
  });

  it("checks gear only after the three survival gates", () => {
    // 血量与装备同时不过时报血量：先看自己撑不撑得住。
    expect(
      new TargetSelector().select(assessment([threat()]), 4, 2, OUTCLASSED)
        .refusal,
    ).toBe("HEALTH_BELOW_ENGAGE_FLOOR");
  });

  it("engages normally when the matchup is favourable", () => {
    const decision = new TargetSelector().select(assessment([threat()]), 20, 2, {
      verdict: "favorable",
      selfPower: 400,
      opponentPower: 100,
      opponentAdvantage: 0.25,
      shouldAvoid: false,
    });
    expect(decision.refusal).toBeNull();
    expect(decision.target?.entityId).toBe(1);
  });

  it("does not treat an unmeasured matchup as no gap", () => {
    // 不传评估 = 没观测，行为与旧调用点一致，不静默拦下交战。
    expect(
      new TargetSelector().select(assessment([threat()]), 20, 2).refusal,
    ).toBeNull();
  });

  it("lets a harassment bot ignore the gear gap entirely", () => {
    const decision = new TargetSelector({
      ...DEFAULT_ENGAGEMENT_POLICY,
      stance: "expendable",
      minimumEngageHealth: 1,
      minimumTotemCount: 0,
      respectGearGap: false,
    }).select(assessment([threat()]), 1, 0, OUTCLASSED);
    expect(decision.refusal).toBeNull();
    expect(decision.target?.entityId).toBe(1);
  });

  it("rejects a non-boolean gear switch", () => {
    expect(() =>
      validateEngagementPolicy({
        ...DEFAULT_ENGAGEMENT_POLICY,
        respectGearGap: "yes" as never,
      }),
    ).toThrowError(CombatPolicyError);
  });
});
