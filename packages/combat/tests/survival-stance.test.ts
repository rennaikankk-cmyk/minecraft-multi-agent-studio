import { describe, expect, it } from "vitest";

import {
  DEFAULT_ENGAGEMENT_POLICY,
  TargetSelector,
} from "../src/target-selector.js";
import {
  DEFAULT_RETREAT_POLICY,
  RetreatController,
} from "../src/retreat-controller.js";
import {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "../src/survival-stance.js";
import {
  DEFAULT_TOTEM_POLICY,
  TotemManager,
  type CombatTotemSnapshot,
} from "../src/totem-manager.js";
import type {
  CombatThreat,
  CombatThreatAssessment,
  CombatVector3,
} from "../src/threat-analyzer.js";

const SELF: CombatVector3 = { x: 0, y: 64, z: 0 };

function totemSnapshot(
  overrides: Partial<CombatTotemSnapshot> = {},
): CombatTotemSnapshot {
  return {
    nowMs: 1_000,
    offhandIsTotem: false,
    inventoryTotemCount: 0,
    selfHealth: 20,
    engaged: true,
    ...overrides,
  };
}

function threat(overrides: Partial<CombatThreat> = {}): CombatThreat {
  return {
    entityId: 1,
    allegiance: "hostile",
    score: 50,
    distance: 5,
    closingSpeed: null,
    reasons: ["WITHIN_MELEE_RANGE"],
    ...overrides,
  };
}

function assessment(
  threats: readonly CombatThreat[],
  totemDepleted: boolean,
): CombatThreatAssessment {
  return {
    evaluatedAtMs: 3_000,
    level: threats.length === 0 ? "none" : "elevated",
    threats,
    hostileCount: threats.length,
    totemDepleted,
  };
}

const EXPENDABLE: CombatSurvivalStance = "expendable";

describe("survival stance primitive", () => {
  it("defaults to preserving life so a misconfigured bot errs towards living", () => {
    expect(DEFAULT_SURVIVAL_STANCE).toBe("preserve-life");
    expect(DEFAULT_TOTEM_POLICY.stance).toBe("preserve-life");
    expect(DEFAULT_RETREAT_POLICY.stance).toBe("preserve-life");
    expect(DEFAULT_ENGAGEMENT_POLICY.stance).toBe("preserve-life");
  });

  it("only preserve-life treats a missing totem as forced retreat", () => {
    expect(totemAbsenceForcesRetreat("preserve-life")).toBe(true);
    expect(totemAbsenceForcesRetreat("expendable")).toBe(false);
  });

  it("rejects an unknown stance rather than guessing", () => {
    expect(() =>
      validateSurvivalStance("immortal" as CombatSurvivalStance),
    ).toThrowError(TypeError);
  });
});

describe("expendable bot with no totem at all", () => {
  it("keeps fighting instead of being pinned in a totem retreat", () => {
    const decision = new TotemManager({
      ...DEFAULT_TOTEM_POLICY,
      stance: EXPENDABLE,
    }).decide(totemSnapshot());
    expect(decision).toMatchObject({
      action: "NONE",
      reason: "FIGHTING_WITHOUT_TOTEM",
      preempts: false,
      totemsRemainingAfter: 0,
    });
  });

  it("does not raise a totem retreat reason for the retreat controller", () => {
    const decision = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      stance: EXPENDABLE,
    }).evaluate(assessment([threat()], true), 20, SELF, new Map([[1, { x: 3, y: 64, z: 0 }]]));
    expect(decision.reasons).not.toContain("TOTEM_DEPLETED");
    expect(decision.urgency).toBe("none");
    expect(decision.suppressOffense).toBe(false);
  });

  it("still selects a target with an empty totem reserve", () => {
    const decision = new TargetSelector({
      ...DEFAULT_ENGAGEMENT_POLICY,
      stance: EXPENDABLE,
    }).select(assessment([threat()], true), 20, 0);
    expect(decision.target?.entityId).toBe(1);
    expect(decision.refusal).toBeNull();
  });

  it("fights on down to one hit of health once the thresholds are lowered too", () => {
    // 送死语义要完整：图腾放开之后血量闸门仍会拦，两处都得配。
    const engage = new TargetSelector({
      ...DEFAULT_ENGAGEMENT_POLICY,
      stance: EXPENDABLE,
      minimumEngageHealth: 1,
    }).select(assessment([threat()], true), 1, 0);
    expect(engage.target).not.toBeNull();
    const retreat = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      stance: EXPENDABLE,
      emergencyHealth: 1,
      withdrawHealth: 1,
    }).evaluate(assessment([threat()], true), 1, SELF, new Map());
    expect(retreat.urgency).toBe("none");
  });
});

describe("expendable stance does not loosen anything else", () => {
  it("still withdraws on low health", () => {
    const decision = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      stance: EXPENDABLE,
    }).evaluate(assessment([threat()], true), 4, SELF, new Map());
    expect(decision.reasons).toEqual(["HEALTH_CRITICAL"]);
    expect(decision.suppressOffense).toBe(true);
  });

  it("still refuses to engage when outnumbered", () => {
    const many = [1, 2, 3, 4, 5].map((entityId) => threat({ entityId }));
    expect(
      new TargetSelector({
        ...DEFAULT_ENGAGEMENT_POLICY,
        stance: EXPENDABLE,
      }).select(assessment(many, true), 20, 0).refusal,
    ).toBe("OUTNUMBERED");
  });

  it("still re-equips normally when a totem is actually available", () => {
    const manager = new TotemManager({
      ...DEFAULT_TOTEM_POLICY,
      stance: EXPENDABLE,
    });
    expect(
      manager.decide(totemSnapshot({ inventoryTotemCount: 2 })),
    ).toMatchObject({ action: "REEQUIP_OFFHAND", preempts: true });
  });
});

describe("preserve-life stance is unchanged", () => {
  it("still forces retreat with no totem anywhere", () => {
    expect(new TotemManager().decide(totemSnapshot())).toMatchObject({
      action: "RETREAT",
      reason: "NO_TOTEM_AVAILABLE",
      preempts: true,
    });
    expect(
      new RetreatController().evaluate(
        assessment([threat()], true),
        20,
        SELF,
        new Map(),
      ).urgency,
    ).toBe("emergency");
    expect(
      new TargetSelector().select(assessment([threat()], true), 20, 0).refusal,
    ).toBe("TOTEM_RESERVE_INSUFFICIENT");
  });
});
