import { describe, expect, it } from "vitest";

import { CombatReflexNotClearedError } from "../src/reflex-clearance.js";
import {
  DEFAULT_MINE_POLICY,
  MAX_CONCURRENT_MINE,
  PacketMineController,
  type CombatMineCandidate,
  type CombatMineSnapshot,
} from "../src/packetmine-controller.js";

const SELF = { x: 0, y: 64, z: 0 } as const;

function candidate(
  overrides: Partial<CombatMineCandidate> = {},
): CombatMineCandidate {
  return {
    position: { x: 1, y: 64, z: 0 },
    estimatedBreakMs: 400,
    unbreakable: false,
    hasMatchingTool: true,
    distanceToTarget: 1,
    ...overrides,
  };
}

function snapshot(
  candidates: readonly CombatMineCandidate[],
  overrides: Partial<CombatMineSnapshot> = {},
): CombatMineSnapshot {
  return {
    evaluatedAtMs: 1_000,
    selfPosition: SELF,
    engaged: false,
    suppressOffense: false,
    totemPreempting: false,
    candidates,
    ...overrides,
  };
}

/** 可弃立场：交战中也允许把副手拿去挖。多数用例需要它才走得到候选筛选。 */
const EXPENDABLE = { ...DEFAULT_MINE_POLICY, stance: "expendable" } as const;

describe("PacketMineController hand budget", () => {
  it("never assigns more than two blocks at once", () => {
    const plan = new PacketMineController().plan(
      snapshot([
        candidate({ position: { x: 1, y: 64, z: 0 }, distanceToTarget: 1 }),
        candidate({ position: { x: 2, y: 64, z: 0 }, distanceToTarget: 2 }),
        candidate({ position: { x: 3, y: 64, z: 0 }, distanceToTarget: 3 }),
      ]),
    );
    expect(MAX_CONCURRENT_MINE).toBe(2);
    expect(plan.assignments).toHaveLength(2);
    expect(plan.excluded).toContainEqual({
      position: { x: 3, y: 64, z: 0 },
      reason: "CONCURRENCY_CAP",
    });
  });

  it("puts the first block in the main hand and the second in the offhand", () => {
    const plan = new PacketMineController().plan(
      snapshot([
        candidate({ position: { x: 2, y: 64, z: 0 }, distanceToTarget: 2 }),
        candidate({ position: { x: 1, y: 64, z: 0 }, distanceToTarget: 1 }),
      ]),
    );
    expect(plan.assignments.map(({ hand }) => hand)).toEqual(["main", "off"]);
    // 贴身的那块先挖，不看输入顺序。
    expect(plan.assignments[0]?.position).toEqual({ x: 1, y: 64, z: 0 });
    expect(plan.handsOccupied).toBe(true);
  });

  it("still reports both hands occupied for a single block", () => {
    const plan = new PacketMineController().plan(snapshot([candidate()]));
    expect(plan.assignments).toHaveLength(1);
    expect(plan.handsOccupied).toBe(true);
  });

  it("rejects a policy asking for three concurrent blocks", () => {
    expect(
      () => new PacketMineController({ ...DEFAULT_MINE_POLICY, maximumConcurrent: 3 }),
    ).toThrowError(TypeError);
    expect(
      () => new PacketMineController({ ...DEFAULT_MINE_POLICY, maximumConcurrent: 0 }),
    ).toThrowError(TypeError);
  });
});

describe("PacketMineController totem conflict", () => {
  it("refuses to take the offhand while a preserve-life bot is engaged", () => {
    const plan = new PacketMineController().plan(
      snapshot([candidate()], { engaged: true }),
    );
    expect(plan).toMatchObject({
      refusal: "TOTEM_OFFHAND_RESERVED",
      assignments: [],
      handsOccupied: false,
    });
  });

  it("lets an expendable bot mine while engaged", () => {
    const plan = new PacketMineController(EXPENDABLE).plan(
      snapshot([candidate()], { engaged: true }),
    );
    expect(plan.refusal).toBeNull();
    expect(plan.assignments).toHaveLength(1);
  });

  it("stands down the moment TotemManager preempts, even for an expendable bot", () => {
    const plan = new PacketMineController(EXPENDABLE).plan(
      snapshot([candidate()], { engaged: true, totemPreempting: true }),
    );
    expect(plan.refusal).toBe("TOTEM_REEQUIP_PREEMPTS");
  });

  it("yields to a retreat in progress", () => {
    const plan = new PacketMineController(EXPENDABLE).plan(
      snapshot([candidate()], { suppressOffense: true }),
    );
    expect(plan.refusal).toBe("RETREAT_IN_PROGRESS");
  });

  it("ranks the totem above the retreat when both apply", () => {
    const plan = new PacketMineController(EXPENDABLE).plan(
      snapshot([candidate()], { suppressOffense: true, totemPreempting: true }),
    );
    expect(plan.refusal).toBe("TOTEM_REEQUIP_PREEMPTS");
  });
});

describe("PacketMineController candidate filtering", () => {
  it("excludes bedrock, out-of-reach blocks and missing tools", () => {
    const plan = new PacketMineController().plan(
      snapshot([
        candidate({ position: { x: 1, y: 64, z: 0 }, unbreakable: true }),
        candidate({ position: { x: 40, y: 64, z: 0 } }),
        candidate({ position: { x: 2, y: 64, z: 0 }, hasMatchingTool: false }),
      ]),
    );
    expect(plan.refusal).toBe("ALL_CANDIDATES_EXCLUDED");
    expect(plan.excluded).toEqual([
      { position: { x: 1, y: 64, z: 0 }, reason: "UNBREAKABLE" },
      { position: { x: 40, y: 64, z: 0 }, reason: "OUT_OF_REACH" },
      { position: { x: 2, y: 64, z: 0 }, reason: "NO_MATCHING_TOOL" },
    ]);
  });

  it("reads reach from the injected policy rather than a fixed constant", () => {
    const far = [candidate({ position: { x: 8, y: 64, z: 0 } })];
    expect(new PacketMineController().plan(snapshot(far)).refusal).toBe(
      "ALL_CANDIDATES_EXCLUDED",
    );
    expect(
      new PacketMineController({ ...DEFAULT_MINE_POLICY, maximumReachDistance: 10 })
        .plan(snapshot(far)).refusal,
    ).toBeNull();
  });

  it("can be told to chew an untooled block anyway", () => {
    const untooled = [candidate({ hasMatchingTool: false })];
    expect(
      new PacketMineController({ ...DEFAULT_MINE_POLICY, requireToolMatch: false })
        .plan(snapshot(untooled)).refusal,
    ).toBeNull();
  });

  it("refuses an empty candidate list instead of inventing a target", () => {
    expect(new PacketMineController().plan(snapshot([])).refusal).toBe(
      "NO_CANDIDATE",
    );
  });

  it("breaks distance ties deterministically by coordinate", () => {
    const tied = [
      candidate({ position: { x: 0, y: 64, z: 1 } }),
      candidate({ position: { x: -1, y: 64, z: 0 } }),
    ];
    const plan = new PacketMineController().plan(snapshot(tied));
    const reversed = new PacketMineController().plan(
      snapshot([...tied].reverse()),
    );
    expect(plan.assignments).toEqual(reversed.assignments);
    expect(plan.assignments[0]?.position).toEqual({ x: -1, y: 64, z: 0 });
  });

  it("rejects malformed candidates", () => {
    expect(() =>
      new PacketMineController().plan(
        snapshot([candidate({ estimatedBreakMs: Number.NaN })]),
      ),
    ).toThrowError(TypeError);
    expect(() =>
      new PacketMineController().plan(
        snapshot([candidate({ distanceToTarget: -1 })]),
      ),
    ).toThrowError(TypeError);
  });
});

describe("PacketMineController estimates and throttle", () => {
  it("reports the concurrent wall clock as the max and the sequential as the sum", () => {
    const plan = new PacketMineController().plan(
      snapshot([
        candidate({ position: { x: 1, y: 64, z: 0 }, estimatedBreakMs: 300 }),
        candidate({
          position: { x: 2, y: 64, z: 0 },
          distanceToTarget: 2,
          estimatedBreakMs: 700,
        }),
      ]),
    );
    expect(plan.concurrentEstimateMs).toBe(700);
    expect(plan.sequentialEstimateMs).toBe(1_000);
  });

  it("throttles a second plan inside the same tick", () => {
    const controller = new PacketMineController();
    expect(controller.plan(snapshot([candidate()])).refusal).toBeNull();
    controller.recordPlanExecuted(1_000);
    expect(controller.plan(snapshot([candidate()])).refusal).toBe("THROTTLED");
    expect(
      controller.plan(snapshot([candidate()], { evaluatedAtMs: 1_060 })).refusal,
    ).toBeNull();
  });

  it("forgets the throttle after a reconnect", () => {
    const controller = new PacketMineController();
    controller.recordPlanExecuted(1_000);
    controller.reset();
    expect(controller.plan(snapshot([candidate()])).refusal).toBeNull();
  });

  it("refuses to book a plan that travels back in time", () => {
    const controller = new PacketMineController();
    controller.recordPlanExecuted(1_000);
    expect(() => controller.recordPlanExecuted(900)).toThrowError(RangeError);
  });
});

describe("PacketMineController live-combat gate", () => {
  it("throws when the reflex probe has not cleared", () => {
    expect(() =>
      new PacketMineController().planForLiveCombat(snapshot([candidate()]), {
        cleared: false,
        denial: "P99_ABOVE_BUDGET",
        budgetMs: 50,
      }),
    ).toThrowError(CombatReflexNotClearedError);
  });

  it("plans normally once cleared", () => {
    const plan = new PacketMineController().planForLiveCombat(
      snapshot([candidate()]),
      { cleared: true, denial: null, budgetMs: 50 },
    );
    expect(plan.refusal).toBeNull();
  });
});
