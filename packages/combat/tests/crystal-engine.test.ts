import { describe, expect, it } from "vitest";

import {
  CombatReflexNotClearedError,
  decideReflexClearance,
} from "../src/reflex-clearance.js";
import {
  CrystalEngine,
  DEFAULT_CRYSTAL_POLICY,
  type CombatCrystalCandidate,
  type CombatCrystalSelfState,
} from "../src/crystal-engine.js";

function candidate(
  overrides: Partial<CombatCrystalCandidate> = {},
): CombatCrystalCandidate {
  return {
    position: { x: 0, y: 64, z: 0 },
    hasValidBase: true,
    spaceObstructed: false,
    targetOcclusion: 0,
    selfOcclusion: 0,
    ...overrides,
  };
}

function self(
  overrides: Partial<CombatCrystalSelfState> = {},
): CombatCrystalSelfState {
  return {
    position: { x: 10, y: 64, z: 0 },
    health: 20,
    totemMarginHealth: 20,
    ...overrides,
  };
}

const TARGET = { x: 1, y: 64, z: 0 };

const CLEARED = decideReflexClearance(
  {
    p99LoopDelayMs: 18,
    samples: 5_000,
    underRepresentativeLoad: true,
    serverProfileId: "srv-a",
  },
  "srv-a",
);

describe("CrystalEngine.plan self-preservation red line", () => {
  it("refuses any placement whose self-damage breaks through health plus totem margin", () => {
    const engine = new CrystalEngine();
    // 水晶就贴在自己脚下，自伤满额；生命+图腾余量只有 2。
    const plan = engine.plan(
      [candidate({ position: { x: 10, y: 64, z: 0 } })],
      TARGET,
      self({ health: 1, totemMarginHealth: 1 }),
    );
    expect(plan.chosen).toBeNull();
    expect(plan.refusal).toBe("SELF_DAMAGE_RED_LINE");
    expect(plan.redLineRejections).toBe(1);
    expect(plan.survivalMarginUsed).toBe(2);
  });

  it("would rather skip the hit than trade its own life for a kill", () => {
    const engine = new CrystalEngine({
      ...DEFAULT_CRYSTAL_POLICY,
      // 即便把自伤权重压到最低、收益门槛压到最低，红线也不能被换掉。
      selfDamageWeight: 1,
      minimumNetGain: 0.01,
      selfDamageCeiling: 100,
    });
    const plan = engine.plan(
      [candidate({ position: { x: 0.5, y: 64, z: 0 } })],
      TARGET,
      self({ position: { x: 0.5, y: 64, z: 0 }, health: 4, totemMarginHealth: 0 }),
    );
    expect(plan.chosen).toBeNull();
    expect(plan.refusal).toBe("SELF_DAMAGE_RED_LINE");
  });

  it("counts the totem margin as part of the survivable budget", () => {
    const engine = new CrystalEngine({
      ...DEFAULT_CRYSTAL_POLICY,
      selfDamageCeiling: 100,
      minimumNetGain: 0.01,
    });
    // 候选贴目标、离自己 5 格：自伤 2，正好用来卡红线两侧。
    const spot = [candidate({ position: { x: 2, y: 64, z: 0 } })];
    const at = { x: 7, y: 64, z: 0 };
    const low = engine.plan(
      spot,
      TARGET,
      self({ position: at, health: 1, totemMarginHealth: 0 }),
    );
    const withTotem = engine.plan(
      spot,
      TARGET,
      self({ position: at, health: 1, totemMarginHealth: 20 }),
    );
    expect(low.refusal).toBe("SELF_DAMAGE_RED_LINE");
    expect(withTotem.chosen).not.toBeNull();
  });

  it("still enforces the absolute ceiling below the red line", () => {
    const engine = new CrystalEngine({
      ...DEFAULT_CRYSTAL_POLICY,
      selfDamageCeiling: 1,
    });
    const plan = engine.plan(
      [candidate({ position: { x: 8, y: 64, z: 0 } })],
      TARGET,
      self({ health: 20, totemMarginHealth: 20 }),
    );
    expect(plan.chosen).toBeNull();
    expect(plan.refusal).toBe("SELF_DAMAGE_ABOVE_CEILING");
    expect(plan.redLineRejections).toBe(0);
  });
});

describe("CrystalEngine.plan scoring", () => {
  it("picks the highest net gain rather than the highest raw damage", () => {
    const engine = new CrystalEngine();
    const plan = engine.plan(
      [
        // 正踩目标：对敌伤害最高（12），但自己也吃 4，净收益 6。
        candidate({ position: { x: 1, y: 64, z: 0 } }),
        // 目标另一侧：对敌伤害只有 8，自伤 0，净收益 8 —— 更划算。
        candidate({ position: { x: -1, y: 64, z: 0 } }),
      ],
      TARGET,
      self({ position: { x: 5, y: 64, z: 0 } }),
    );
    expect(plan.chosen?.candidate.position.x).toBe(-1);
    // 选中的那个原始伤害更低，证明排序看的是净收益而不是伤害。
    expect(plan.chosen?.targetDamage).toBe(8);
    expect(plan.chosen?.netGain).toBe(8);
    expect(plan.viableCount).toBe(2);
  });

  it("skips candidates without a valid base or with blocked space", () => {
    const engine = new CrystalEngine();
    const plan = engine.plan(
      [
        candidate({ position: { x: 1, y: 64, z: 0 }, hasValidBase: false }),
        candidate({ position: { x: 1, y: 64, z: 1 }, spaceObstructed: true }),
      ],
      TARGET,
      self(),
    );
    expect(plan.chosen).toBeNull();
    expect(plan.refusal).toBe("ALL_UNPLACEABLE");
  });

  it("reports no candidates distinctly from unplaceable ones", () => {
    expect(new CrystalEngine().plan([], TARGET, self())).toMatchObject({
      chosen: null,
      refusal: "NO_CANDIDATES",
      viableCount: 0,
    });
  });

  it("attenuates damage by occlusion", () => {
    const engine = new CrystalEngine();
    const clear = engine.plan(
      [candidate({ position: { x: 1.5, y: 64, z: 0 } })],
      TARGET,
      self(),
    );
    const blocked = engine.plan(
      [candidate({ position: { x: 1.5, y: 64, z: 0 }, targetOcclusion: 0.75 })],
      TARGET,
      self(),
    );
    expect(clear.chosen?.targetDamage).toBeGreaterThan(
      blocked.chosen?.targetDamage ?? Number.POSITIVE_INFINITY,
    );
  });

  it("treats anything outside the blast radius as zero damage", () => {
    const engine = new CrystalEngine();
    const plan = engine.plan(
      [candidate({ position: { x: 200, y: 64, z: 200 } })],
      TARGET,
      self(),
    );
    expect(plan.chosen).toBeNull();
    expect(plan.refusal).toBe("NET_GAIN_TOO_LOW");
  });

  it("declines a placement whose net gain is not worth the risk", () => {
    const engine = new CrystalEngine({
      ...DEFAULT_CRYSTAL_POLICY,
      minimumNetGain: 100,
    });
    expect(
      engine.plan([candidate({ position: { x: 1.5, y: 64, z: 0 } })], TARGET, self())
        .refusal,
    ).toBe("NET_GAIN_TOO_LOW");
  });

  it("is order-independent and breaks ties deterministically", () => {
    const engine = new CrystalEngine();
    const spots = [
      candidate({ position: { x: 1, y: 64, z: 2 } }),
      candidate({ position: { x: 1, y: 64, z: -2 } }),
      candidate({ position: { x: 1, y: 64, z: 0 } }),
    ];
    const forward = engine.plan(spots, TARGET, self());
    const reversed = engine.plan([...spots].reverse(), TARGET, self());
    expect(forward.chosen?.candidate.position).toEqual(
      reversed.chosen?.candidate.position,
    );
  });

  it("rejects malformed candidate and self data", () => {
    const engine = new CrystalEngine();
    expect(() =>
      engine.plan([candidate({ targetOcclusion: 1.5 })], TARGET, self()),
    ).toThrowError(TypeError);
    expect(() =>
      engine.plan([candidate()], TARGET, self({ health: Number.NaN })),
    ).toThrowError(TypeError);
    expect(() =>
      engine.plan(
        [candidate({ position: { x: Number.NaN, y: 64, z: 0 } })],
        TARGET,
        self(),
      ),
    ).toThrowError(TypeError);
  });

  it("rejects an out-of-bounds policy", () => {
    expect(
      () => new CrystalEngine({ ...DEFAULT_CRYSTAL_POLICY, selfDamageWeight: 0.5 }),
    ).toThrowError(TypeError);
    expect(
      () => new CrystalEngine({ ...DEFAULT_CRYSTAL_POLICY, blastRadius: 0 }),
    ).toThrowError(TypeError);
    expect(
      () => new CrystalEngine({ ...DEFAULT_CRYSTAL_POLICY, minimumNetGain: 0 }),
    ).toThrowError(TypeError);
  });
});

describe("CrystalEngine.evaluateDetonate", () => {
  it("reports nothing to detonate before a placement", () => {
    expect(new CrystalEngine().evaluateDetonate(1_000)).toMatchObject({
      shouldDetonate: false,
      reason: "NOT_PLACED",
    });
  });

  it("detonates inside the one-tick window", () => {
    const engine = new CrystalEngine();
    engine.recordPlacement(1_000);
    expect(engine.evaluateDetonate(1_000)).toMatchObject({
      shouldDetonate: true,
      reason: "DETONATE",
      delayMs: 0,
    });
    expect(engine.evaluateDetonate(1_050).shouldDetonate).toBe(true);
  });

  it("re-evaluates instead of detonating a stale crystal", () => {
    const engine = new CrystalEngine();
    engine.recordPlacement(1_000);
    expect(engine.evaluateDetonate(1_051)).toMatchObject({
      shouldDetonate: false,
      reason: "WINDOW_EXPIRED",
      delayMs: 51,
    });
  });

  it("clears placement memory on reset", () => {
    const engine = new CrystalEngine();
    engine.recordPlacement(1_000);
    engine.reset();
    expect(engine.evaluateDetonate(1_000).reason).toBe("NOT_PLACED");
  });

  it("refuses a placement record that travels backwards in time", () => {
    const engine = new CrystalEngine();
    engine.recordPlacement(5_000);
    expect(() => engine.recordPlacement(4_999)).toThrowError(RangeError);
  });
});

describe("CrystalEngine.planForLiveCombat", () => {
  it("refuses live combat until the timing probe has cleared", () => {
    expect(() =>
      new CrystalEngine().planForLiveCombat(
        [candidate()],
        TARGET,
        self(),
        decideReflexClearance(null, "srv-a"),
      ),
    ).toThrowError(CombatReflexNotClearedError);
  });

  it("behaves identically to plan once cleared", () => {
    const spots = [candidate({ position: { x: 1.5, y: 64, z: 0 } })];
    expect(
      new CrystalEngine().planForLiveCombat(spots, TARGET, self(), CLEARED),
    ).toEqual(new CrystalEngine().plan(spots, TARGET, self()));
  });
});
