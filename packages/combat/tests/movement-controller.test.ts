import { describe, expect, it } from "vitest";

import {
  DEFAULT_MOVEMENT_POLICY,
  MovementController,
  type CombatMovementSnapshot,
} from "../src/movement-controller.js";

function snapshot(
  overrides: Partial<CombatMovementSnapshot> = {},
): CombatMovementSnapshot {
  return {
    nowMs: 0,
    selfPosition: { x: 0, y: 64, z: 0 },
    targetPosition: { x: 4, y: 64, z: 0 },
    hazards: [],
    retreatDirection: null,
    ...overrides,
  };
}

describe("MovementController.plan", () => {
  it("strafes while inside the distance band", () => {
    const plan = new MovementController().plan(snapshot());
    expect(plan.intent).toBe("STRAFE");
    expect(plan.sprint).toBe(false);
    expect(plan.distance).toBeCloseTo(4, 6);
    // 目标在 +X，环绕方向必须垂直于它。
    expect(plan.direction?.x).toBeCloseTo(0, 6);
    expect(Math.abs(plan.direction?.z ?? 0)).toBeCloseTo(1, 6);
    expect(plan.strafeSign === 1 || plan.strafeSign === -1).toBe(true);
  });

  it("closes in when the target is beyond the outer ring", () => {
    const plan = new MovementController().plan(
      snapshot({ targetPosition: { x: 20, y: 64, z: 0 } }),
    );
    expect(plan.intent).toBe("CLOSE_IN");
    expect(plan.direction).toEqual({ x: 1, y: 0, z: 0 });
    // 20 格远：疾跑追。
    expect(plan.sprint).toBe(true);
  });

  it("does not sprint on a short approach that would overshoot", () => {
    const plan = new MovementController().plan(
      snapshot({ targetPosition: { x: 5.5, y: 64, z: 0 } }),
    );
    expect(plan.intent).toBe("CLOSE_IN");
    expect(plan.sprint).toBe(false);
  });

  it("backs off rather than staying in face-hugging range", () => {
    const plan = new MovementController().plan(
      snapshot({ targetPosition: { x: 1, y: 64, z: 0 } }),
    );
    expect(plan.intent).toBe("BACK_OFF");
    expect(plan.direction?.x).toBeCloseTo(-1, 6);
    expect(plan.direction?.z).toBeCloseTo(0, 6);
    expect(plan.direction?.y).toBe(0);
    expect(plan.distance).toBeCloseTo(1, 6);
  });

  it("uses the 2.4-3.8 spacing band while the target is invulnerable", () => {
    const controller = new MovementController();
    expect(
      controller.plan(
        snapshot({
          targetPosition: { x: 2, y: 64, z: 0 },
          targetInvulnerableRemainingMs: 300,
        }),
      ).intent,
    ).toBe("BACK_OFF");
    expect(
      controller.plan(
        snapshot({
          targetPosition: { x: 3, y: 64, z: 0 },
          targetInvulnerableRemainingMs: 300,
        }),
      ).intent,
    ).toBe("STRAFE");
    expect(
      controller.plan(
        snapshot({
          targetPosition: { x: 4, y: 64, z: 0 },
          targetInvulnerableRemainingMs: 300,
        }),
      ).intent,
    ).toBe("CLOSE_IN");
  });

  it("lets retreat override every other positioning choice", () => {
    const plan = new MovementController().plan(
      snapshot({
        // 目标贴脸本该 BACK_OFF，撤退方向在则一律让位。
        targetPosition: { x: 1, y: 64, z: 0 },
        retreatDirection: { x: 0, y: 0, z: -3 },
      }),
    );
    expect(plan.intent).toBe("DISENGAGE");
    expect(plan.direction).toEqual({ x: 0, y: 0, z: -1 });
    expect(plan.sprint).toBe(true);
    expect(plan.strafeSign).toBe(0);
  });

  it("holds when the retreat direction has no horizontal component", () => {
    const plan = new MovementController().plan(
      snapshot({ retreatDirection: { x: 0, y: -1, z: 0 } }),
    );
    expect(plan.intent).toBe("HOLD");
    expect(plan.direction).toBeNull();
  });

  it("holds instead of retreating into a known hazard", () => {
    const plan = new MovementController().plan(
      snapshot({
        retreatDirection: { x: 1, y: 0, z: 0 },
        hazards: [{ x: 1, y: 64, z: 0 }],
      }),
    );
    expect(plan).toMatchObject({
      intent: "HOLD",
      direction: null,
      blockedByHazard: true,
    });
  });

  it("holds instead of wandering when the target is unknown", () => {
    const plan = new MovementController().plan(
      snapshot({ targetPosition: null }),
    );
    expect(plan).toMatchObject({
      intent: "HOLD",
      direction: null,
      distance: null,
      sprint: false,
    });
  });

  it("holds when horizontally coincident with the target", () => {
    const plan = new MovementController().plan(
      snapshot({ targetPosition: { x: 0, y: 70, z: 0 } }),
    );
    expect(plan.intent).toBe("HOLD");
    expect(plan.direction).toBeNull();
    expect(plan.distance).toBeCloseTo(0, 6);
  });

  it("never emits a vertical movement component", () => {
    const controller = new MovementController();
    for (const target of [
      { x: 1, y: 90, z: 0 },
      { x: 4, y: 20, z: 0 },
      { x: 40, y: 64, z: 12 },
    ]) {
      const plan = controller.plan(snapshot({ targetPosition: target }));
      expect(plan.direction?.y ?? 0).toBe(0);
    }
  });

  it("strafes the other way instead of stepping into a hazard", () => {
    const controller = new MovementController();
    // 目标在 +X，环绕候选是 ±Z；在 +Z 一步处放岩浆。
    const plan = controller.plan(
      snapshot({ hazards: [{ x: 0, y: 64, z: 1 }] }),
    );
    expect(plan.intent).toBe("STRAFE");
    expect(plan.blockedByHazard).toBe(false);
    expect(plan.direction?.z).toBeLessThan(0);
  });

  it("holds when both strafe directions are unsafe", () => {
    const plan = new MovementController().plan(
      snapshot({
        hazards: [
          { x: 0, y: 64, z: 1 },
          { x: 0, y: 64, z: -1 },
        ],
      }),
    );
    expect(plan).toMatchObject({
      intent: "HOLD",
      direction: null,
      blockedByHazard: true,
    });
    // 走不了也要如实报距离，调用方还得据此决定打不打。
    expect(plan.distance).toBeCloseTo(4, 6);
  });

  it("refuses a hazardous approach rather than walking into lava", () => {
    const plan = new MovementController().plan(
      snapshot({
        targetPosition: { x: 20, y: 64, z: 0 },
        hazards: [{ x: 1, y: 64, z: 0 }],
      }),
    );
    expect(plan).toMatchObject({
      intent: "HOLD",
      direction: null,
      blockedByHazard: true,
    });
  });

  it("ignores hazards that are clear of the probed step", () => {
    const plan = new MovementController().plan(
      snapshot({
        targetPosition: { x: 20, y: 64, z: 0 },
        hazards: [{ x: 12, y: 64, z: 0 }],
      }),
    );
    expect(plan.intent).toBe("CLOSE_IN");
    expect(plan.blockedByHazard).toBe(false);
  });

  it("flips the strafe direction on a jittered, non-fixed period", () => {
    const controller = new MovementController();
    const signs: number[] = [];
    for (let nowMs = 0; nowMs <= 12_000; nowMs += 100) {
      signs.push(controller.plan(snapshot({ nowMs })).strafeSign);
    }
    const flips: number[] = [];
    for (let index = 1; index < signs.length; index += 1) {
      if (signs[index] !== signs[index - 1]) flips.push(index * 100);
    }
    // 12 秒内必须换过好几次向，否则等于没有环绕。
    expect(flips.length).toBeGreaterThan(3);
    const gaps = flips.slice(1).map((at, index) => at - flips[index]!);
    // 间隔不能是固定周期——那是最好认的机器特征。
    expect(new Set(gaps).size).toBeGreaterThan(1);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(DEFAULT_MOVEMENT_POLICY.strafeFlipMinMs);
      expect(gap).toBeLessThanOrEqual(
        DEFAULT_MOVEMENT_POLICY.strafeFlipMaxMs + 100,
      );
    }
  });

  it("reproduces the same strafe phase for the same seed", () => {
    const run = (seed: number) => {
      const controller = new MovementController(DEFAULT_MOVEMENT_POLICY, seed);
      const signs: number[] = [];
      for (let nowMs = 0; nowMs <= 6_000; nowMs += 250) {
        signs.push(controller.plan(snapshot({ nowMs })).strafeSign);
      }
      return signs;
    };
    expect(run(4_242)).toEqual(run(4_242));
    expect(run(4_242)).not.toEqual(run(99_991));
  });

  it("clears the strafe phase on reset", () => {
    const controller = new MovementController();
    for (let nowMs = 0; nowMs <= 6_000; nowMs += 250) {
      controller.plan(snapshot({ nowMs }));
    }
    controller.reset();
    // 重连后从初始相位重新起算，不带上一场的计时。
    expect(controller.plan(snapshot({ nowMs: 0 })).strafeSign).toBe(1);
  });

  it("rejects an incoherent policy", () => {
    expect(
      () =>
        new MovementController({
          ...DEFAULT_MOVEMENT_POLICY,
          // 内圈不能大于等于外圈，否则不存在可站的带。
          minimumDistance: 6,
          maximumDistance: 5,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new MovementController({
          ...DEFAULT_MOVEMENT_POLICY,
          stepProbeDistance: 0,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new MovementController({
          ...DEFAULT_MOVEMENT_POLICY,
          strafeFlipMinMs: 2_000,
          strafeFlipMaxMs: 1_000,
        }),
    ).toThrowError(TypeError);
  });

  it("rejects malformed snapshot data", () => {
    const controller = new MovementController();
    expect(() => controller.plan(snapshot({ nowMs: Number.NaN }))).toThrowError(
      TypeError,
    );
    expect(() =>
      controller.plan(snapshot({ selfPosition: { x: 0, y: Number.NaN, z: 0 } })),
    ).toThrowError(TypeError);
    expect(() =>
      controller.plan(snapshot({ hazards: [{ x: Number.NaN, y: 0, z: 0 }] })),
    ).toThrowError(TypeError);
    expect(() =>
      controller.plan(snapshot({ targetInvulnerableRemainingMs: -1 })),
    ).toThrowError(TypeError);
  });
});
