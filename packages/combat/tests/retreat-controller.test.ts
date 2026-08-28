import { describe, expect, it } from "vitest";

import {
  DEFAULT_RETREAT_POLICY,
  RetreatController,
} from "../src/retreat-controller.js";
import type {
  CombatThreat,
  CombatThreatAssessment,
  CombatVector3,
} from "../src/threat-analyzer.js";

function threat(overrides: Partial<CombatThreat> = {}): CombatThreat {
  return {
    entityId: 1,
    allegiance: "hostile",
    score: 50,
    distance: 5,
    closingSpeed: null,
    reasons: ["WITHIN_CRYSTAL_RANGE"],
    ...overrides,
  };
}

function assessment(
  threats: readonly CombatThreat[],
  totemDepleted = false,
): CombatThreatAssessment {
  return {
    evaluatedAtMs: 3_000,
    level: threats.length === 0 ? "none" : "elevated",
    threats,
    hostileCount: threats.length,
    totemDepleted,
  };
}

const SELF: CombatVector3 = { x: 0, y: 64, z: 0 };

function positions(
  ...entries: readonly (readonly [number, CombatVector3])[]
): ReadonlyMap<number, CombatVector3> {
  return new Map(entries);
}

describe("RetreatController", () => {
  it("stays engaged when healthy and not outnumbered", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat({ reasons: ["WITHIN_MELEE_RANGE"] })]),
      20,
      SELF,
      positions([1, { x: 3, y: 64, z: 0 }]),
    );
    expect(decision).toMatchObject({
      urgency: "none",
      reasons: [],
      actions: [],
      direction: null,
      suppressOffense: false,
    });
  });

  it("treats a depleted totem reserve as an emergency disconnect path", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat({ reasons: ["WITHIN_MELEE_RANGE"] })], true),
      20,
      SELF,
      positions([1, { x: 3, y: 64, z: 0 }]),
    );
    expect(decision.urgency).toBe("emergency");
    expect(decision.reasons).toEqual(["TOTEM_DEPLETED"]);
    expect(decision.actions).toEqual([
      "DISENGAGE_MOVE",
      "BREAK_LINE_OF_SIGHT",
      "DISCONNECT",
    ]);
    expect(decision.suppressOffense).toBe(true);
  });

  it("never suggests disconnect when the operator forbids it", () => {
    const decision = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      allowDisconnect: false,
    }).evaluate(
      assessment([threat()], true),
      20,
      SELF,
      positions([1, { x: 3, y: 64, z: 0 }]),
    );
    expect(decision.urgency).toBe("emergency");
    expect(decision.actions).not.toContain("DISCONNECT");
  });

  it("does not escalate to emergency when no hostile is present", () => {
    const decision = new RetreatController().evaluate(
      assessment([], true),
      20,
      SELF,
      positions(),
    );
    expect(decision).toMatchObject({
      urgency: "withdraw",
      reasons: ["TOTEM_DEPLETED"],
      actions: ["DISENGAGE_MOVE"],
      direction: null,
    });
  });

  it("orders reasons by severity, not by detection order", () => {
    const decision = new RetreatController().evaluate(
      assessment(
        [1, 2, 3, 4].map((entityId) =>
          threat({ entityId, reasons: ["CRYSTAL_PLACED"] }),
        ),
        true,
      ),
      3,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
    );
    expect(decision.reasons).toEqual([
      "TOTEM_DEPLETED",
      "HEALTH_CRITICAL",
      "OUTNUMBERED",
      "CRYSTAL_THREAT",
    ]);
    expect(decision.urgency).toBe("emergency");
  });

  it("reports an anchor threat independently from a crystal threat", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat({ reasons: ["ANCHOR_PLACED"] })]),
      20,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
    );
    expect(decision).toMatchObject({
      urgency: "withdraw",
      reasons: ["ANCHOR_THREAT"],
      suppressOffense: true,
    });
  });

  it("withdraws on low health without escalating to emergency", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat({ reasons: ["WITHIN_MELEE_RANGE"] })]),
      10,
      SELF,
      positions([1, { x: 4, y: 64, z: 0 }]),
    );
    expect(decision).toMatchObject({
      urgency: "withdraw",
      reasons: ["HEALTH_LOW"],
      actions: ["DISENGAGE_MOVE"],
      suppressOffense: true,
    });
  });

  it("points the retreat vector away from the weighted threat centroid", () => {
    const decision = new RetreatController().evaluate(
      assessment([
        threat({ entityId: 1, score: 90 }),
        threat({ entityId: 2, score: 10 }),
      ]),
      10,
      SELF,
      positions(
        [1, { x: 10, y: 64, z: 0 }],
        [2, { x: 0, y: 64, z: 10 }],
      ),
    );
    // 高威胁在 +x，低威胁在 +z：撤退方向必须同时为负，且 x 分量更强。
    expect(decision.direction).not.toBeNull();
    expect(decision.direction!.x).toBeLessThan(0);
    expect(decision.direction!.z).toBeLessThan(0);
    expect(Math.abs(decision.direction!.x)).toBeGreaterThan(
      Math.abs(decision.direction!.z),
    );
    expect(
      Math.hypot(
        decision.direction!.x,
        decision.direction!.y,
        decision.direction!.z,
      ),
    ).toBeCloseTo(1, 6);
  });

  it("returns no direction rather than guessing when positions are unknown", () => {
    const withoutPositions = new RetreatController().evaluate(
      assessment([threat()]),
      10,
      SELF,
      positions(),
    );
    expect(withoutPositions.direction).toBeNull();
    // 敌人与自己同位时方向未定义，同样返回 null。
    const coincident = new RetreatController().evaluate(
      assessment([threat()]),
      10,
      SELF,
      positions([1, SELF]),
    );
    expect(coincident.direction).toBeNull();
  });

  it("rejects an incoherent retreat policy", () => {
    expect(
      () =>
        new RetreatController({
          ...DEFAULT_RETREAT_POLICY,
          withdrawHealth: 4,
          emergencyHealth: 6,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new RetreatController({
          ...DEFAULT_RETREAT_POLICY,
          outnumberedAbove: 0,
        }),
    ).toThrowError(TypeError);
    expect(() =>
      new RetreatController().evaluate(
        assessment([threat()]),
        Number.NaN,
        SELF,
        positions(),
      ),
    ).toThrowError(TypeError);
  });
});

describe("RetreatController gear gap", () => {
  const OUTCLASSED = {
    verdict: "outclassed",
    selfPower: 100,
    opponentPower: 400,
    opponentAdvantage: 4,
    shouldAvoid: true,
  } as const;

  it("withdraws from a fight it is outgeared in", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat()]),
      20,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
      OUTCLASSED,
    );
    expect(decision).toMatchObject({
      urgency: "withdraw",
      reasons: ["GEAR_OUTCLASSED"],
      suppressOffense: true,
    });
    // 装备差不是"下一击会死"，不该升级成断线。
    expect(decision.actions).toEqual(["DISENGAGE_MOVE"]);
  });

  it("does not upgrade a gear gap into an emergency on its own", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat()]),
      20,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
      OUTCLASSED,
    );
    expect(decision.urgency).not.toBe("emergency");
    expect(decision.actions).not.toContain("BREAK_LINE_OF_SIGHT");
  });

  it("still reports the health emergency alongside the gear gap", () => {
    const decision = new RetreatController().evaluate(
      assessment([threat()]),
      3,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
      OUTCLASSED,
    );
    expect(decision.urgency).toBe("emergency");
    expect(decision.reasons).toEqual(["HEALTH_CRITICAL", "GEAR_OUTCLASSED"]);
  });

  it("ignores an unobserved matchup rather than assuming the worst", () => {
    expect(
      new RetreatController().evaluate(
        assessment([threat({ reasons: ["WITHIN_MELEE_RANGE"] })]),
        20,
        SELF,
        positions([1, { x: 5, y: 64, z: 0 }]),
      ).urgency,
    ).toBe("none");
  });

  it("lets a harassment bot fight on regardless of the gap", () => {
    const decision = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      stance: "expendable",
      emergencyHealth: 1,
      withdrawHealth: 1,
      respectGearGap: false,
    }).evaluate(
      assessment([threat({ reasons: ["WITHIN_MELEE_RANGE"] })], true),
      20,
      SELF,
      positions([1, { x: 5, y: 64, z: 0 }]),
      OUTCLASSED,
    );
    expect(decision).toMatchObject({
      urgency: "none",
      reasons: [],
      suppressOffense: false,
    });
  });

  it("rejects a non-boolean gear switch", () => {
    expect(
      () =>
        new RetreatController({
          ...DEFAULT_RETREAT_POLICY,
          respectGearGap: "yes" as never,
        }),
    ).toThrowError(TypeError);
  });
});
