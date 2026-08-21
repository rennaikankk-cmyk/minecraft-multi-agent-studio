import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROTATION_POLICY,
  RotationController,
  eyePosition,
  orientationToward,
} from "../src/rotation-controller.js";

describe("orientationToward", () => {
  it("uses Minecraft yaw conventions from the eye position", () => {
    const eye = eyePosition({ x: 0, y: 64, z: 0 });
    expect(eye.y).toBeCloseTo(65.62, 6);
    // 原版约定：+Z(南) 是 yaw 0，-X(西) 是 90，-Z(北) 是 180，+X(东) 是 -90。
    expect(orientationToward(eye, { x: 0, y: eye.y, z: 10 }).yaw).toBeCloseTo(0, 6);
    expect(orientationToward(eye, { x: -10, y: eye.y, z: 0 }).yaw).toBeCloseTo(90, 6);
    expect(orientationToward(eye, { x: 0, y: eye.y, z: -10 }).yaw).toBeCloseTo(180, 6);
    expect(orientationToward(eye, { x: 10, y: eye.y, z: 0 }).yaw).toBeCloseTo(-90, 6);
  });

  it("pitches down for a target below the eye and up for one above", () => {
    const eye = eyePosition({ x: 0, y: 64, z: 0 });
    expect(
      orientationToward(eye, { x: 0, y: eye.y - 10, z: -10 }).pitch,
    ).toBeCloseTo(45, 6);
    expect(
      orientationToward(eye, { x: 0, y: eye.y + 10, z: -10 }).pitch,
    ).toBeCloseTo(-45, 6);
    // 正下方是 +90，钳制在合法范围内。
    expect(orientationToward(eye, { x: 0, y: eye.y - 5, z: 0 }).pitch).toBeCloseTo(
      90,
      6,
    );
  });
});

describe("RotationController", () => {
  it("never turns more than the per-tick cap, so no instant 180", () => {
    const controller = new RotationController();
    const step = controller.step({ yaw: 0, pitch: 0 }, { yaw: 180, pitch: 0 });
    expect(step.clamped).toBe(true);
    const turned = Math.abs(step.orientation.yaw);
    expect(turned).toBeLessThanOrEqual(
      DEFAULT_ROTATION_POLICY.maxDegreesPerTick +
        DEFAULT_ROTATION_POLICY.jitterDegrees,
    );
    expect(turned).toBeGreaterThan(DEFAULT_ROTATION_POLICY.maxDegreesPerTick - 5);
  });

  it("converges to the target over several capped ticks", () => {
    const controller = new RotationController();
    let orientation = { yaw: 0, pitch: 0 };
    const desired = { yaw: 150, pitch: 20 };
    let ticks = 0;
    let aimed = false;
    while (ticks < 20 && !aimed) {
      const step = controller.step(orientation, desired);
      orientation = step.orientation;
      aimed = step.aimed;
      ticks += 1;
    }
    expect(aimed).toBe(true);
    // 至少要几帧才转得过去 —— 一帧到位就是被反检测视为破绽的行为。
    expect(ticks).toBeGreaterThan(3);
  });

  it("stops adjusting once inside the aim tolerance", () => {
    const controller = new RotationController();
    const current = { yaw: 10, pitch: 5 };
    const step = controller.step(current, { yaw: 11, pitch: 5.5 });
    expect(step).toMatchObject({ aimed: true, clamped: false });
    // 够用即可：朝向逐字不动，不做持续微调。
    expect(step.orientation).toEqual(current);
  });

  it("takes the short way around the yaw wrap", () => {
    const controller = new RotationController(
      { ...DEFAULT_ROTATION_POLICY, jitterDegrees: 0 },
    );
    // 从 170 到 -170 只差 20 度，不该绕 340 度。
    const step = controller.step({ yaw: 170, pitch: 0 }, { yaw: -170, pitch: 0 });
    expect(step.clamped).toBe(false);
    expect(step.orientation.yaw).toBeCloseTo(-170, 6);
    expect(step.remainingDegrees).toBeCloseTo(0, 6);
  });

  it("is reproducible for a given seed and differs between seeds", () => {
    const run = (seed: number): readonly number[] => {
      const controller = new RotationController(DEFAULT_ROTATION_POLICY, seed);
      let orientation = { yaw: 0, pitch: 0 };
      const yaws: number[] = [];
      for (let tick = 0; tick < 5; tick += 1) {
        orientation = controller.step(orientation, { yaw: 160, pitch: 10 })
          .orientation;
        yaws.push(orientation.yaw);
      }
      return yaws;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it("applies non-zero jitter so ticks are not perfectly uniform", () => {
    const controller = new RotationController();
    const first = controller.step({ yaw: 0, pitch: 0 }, { yaw: 170, pitch: 0 });
    const second = controller.step(
      { yaw: 0, pitch: 0 },
      { yaw: 170, pitch: 0 },
    );
    // 同一输入连续两帧不完全相同 —— 固定周期是明显的 bot 信号。
    expect(first.orientation.yaw).not.toBe(second.orientation.yaw);
  });

  it("can disable jitter entirely for exact assertions", () => {
    const controller = new RotationController({
      maxDegreesPerTick: 20,
      aimToleranceDegrees: 1,
      jitterDegrees: 0,
    });
    const step = controller.step({ yaw: 0, pitch: 0 }, { yaw: 90, pitch: 0 });
    expect(step.orientation).toEqual({ yaw: 20, pitch: 0 });
    expect(step.remainingDegrees).toBeCloseTo(70, 6);
  });

  it("rejects a policy that would defeat its own purpose", () => {
    for (const override of [
      { maxDegreesPerTick: 0 },
      { maxDegreesPerTick: 360 },
      { aimToleranceDegrees: -1 },
      { jitterDegrees: -0.1 },
      // 噪声大于容差会让朝向在容差边界来回摆动。
      { jitterDegrees: 10, aimToleranceDegrees: 3 },
    ]) {
      expect(
        () => new RotationController({ ...DEFAULT_ROTATION_POLICY, ...override }),
      ).toThrowError(TypeError);
    }
  });
});
