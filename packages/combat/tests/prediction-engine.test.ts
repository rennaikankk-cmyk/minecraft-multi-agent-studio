import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREDICTION_POLICY,
  PredictionEngine,
  type CombatMotionSample,
} from "../src/prediction-engine.js";

const PROFILE = "profile-a";
const DIMENSION = "minecraft:overworld";

function sample(
  observedAtMs: number,
  x: number,
  overrides: Partial<CombatMotionSample> = {},
): CombatMotionSample {
  return {
    observedAtMs,
    serverProfileId: PROFILE,
    dimension: DIMENSION,
    position: { x, y: 64, z: 0 },
    ...overrides,
  };
}

function predict(
  engine: PredictionEngine,
  samples: readonly CombatMotionSample[],
  horizonMs: number,
) {
  return engine.predict(samples, horizonMs, PROFILE, DIMENSION);
}

describe("PredictionEngine.predict", () => {
  it("extrapolates along a constant-velocity track", () => {
    const engine = new PredictionEngine();
    // 300ms 走 1.5 格 => 0.005 格/ms，再走 200ms 应到 x=2.5。
    const result = predict(
      engine,
      [sample(0, 0), sample(150, 0.75), sample(300, 1.5)],
      200,
    );
    expect(result.confidence).toBe("high");
    expect(result.velocityPerMs?.x).toBeCloseTo(0.005, 6);
    expect(result.position?.x).toBeCloseTo(2.5, 6);
    expect(result.horizonMsUsed).toBe(200);
    expect(result.samplesUsed).toBe(3);
  });

  it("says it does not know instead of guessing from one frame", () => {
    const result = predict(new PredictionEngine(), [sample(0, 5)], 200);
    expect(result.confidence).toBe("none");
    expect(result.velocityPerMs).toBeNull();
    // 仍然报当前位置，调用方按现地打。
    expect(result.position).toEqual({ x: 5, y: 64, z: 0 });
    expect(result.horizonMsUsed).toBe(0);
  });

  it("returns a null position when there is nothing to go on", () => {
    const result = predict(new PredictionEngine(), [], 200);
    expect(result).toMatchObject({
      position: null,
      velocityPerMs: null,
      confidence: "none",
      samplesUsed: 0,
    });
  });

  it("clamps the horizon and downgrades confidence rather than over-promising", () => {
    const engine = new PredictionEngine();
    const track = [sample(0, 0), sample(200, 1), sample(400, 2)];
    const result = predict(engine, track, 5_000);
    expect(result.horizonMsUsed).toBe(DEFAULT_PREDICTION_POLICY.maxHorizonMs);
    // 样本足够本可以 high，但被钳制就必须降级。
    expect(result.confidence).toBe("low");
    expect(result.position?.x).toBeCloseTo(4.5, 6);
  });

  it("drops samples from another server profile", () => {
    const engine = new PredictionEngine();
    const result = predict(engine, [
      sample(0, 0, { serverProfileId: "profile-b" }),
      sample(200, 1),
    ], 200);
    // 只剩一帧，估不出速度。
    expect(result.confidence).toBe("none");
    expect(result.samplesUsed).toBe(1);
    expect(result.position).toEqual({ x: 1, y: 64, z: 0 });
  });

  it("drops samples from another dimension", () => {
    const engine = new PredictionEngine();
    const result = predict(engine, [
      sample(0, 0, { dimension: "minecraft:the_nether" }),
      sample(200, 1),
    ], 200);
    expect(result.samplesUsed).toBe(1);
    expect(result.velocityPerMs).toBeNull();
  });

  it("ignores stale samples when estimating velocity", () => {
    const engine = new PredictionEngine();
    // 第一帧比最新帧早 5s，超出 1s 过期窗口，只有后两帧参与估速。
    const result = predict(
      engine,
      [sample(0, -100), sample(5_000, 0), sample(5_200, 1)],
      200,
    );
    expect(result.samplesUsed).toBe(2);
    expect(result.velocityPerMs?.x).toBeCloseTo(0.005, 6);
    expect(result.position?.x).toBeCloseTo(2, 6);
  });

  it("refuses to extrapolate a teleport", () => {
    const engine = new PredictionEngine();
    // 50ms 跨 500 格：10 格/ms，远超上限。
    const result = predict(engine, [sample(0, 0), sample(50, 500)], 200);
    expect(result.confidence).toBe("none");
    expect(result.velocityPerMs).toBeNull();
    expect(result.position).toEqual({ x: 500, y: 64, z: 0 });
  });

  it("sorts unordered samples instead of trusting arrival order", () => {
    const engine = new PredictionEngine();
    const ordered = [sample(0, 0), sample(150, 0.75), sample(300, 1.5)];
    const shuffled = [ordered[1]!, ordered[2]!, ordered[0]!];
    expect(predict(engine, shuffled, 200)).toEqual(
      predict(engine, ordered, 200),
    );
  });

  it("gives only low confidence while samples are still thin", () => {
    const engine = new PredictionEngine();
    const result = predict(engine, [sample(0, 0), sample(200, 1)], 100);
    expect(result.samplesUsed).toBe(2);
    expect(result.confidence).toBe("low");
  });

  it("treats a zero horizon as the current position with a known velocity", () => {
    const engine = new PredictionEngine();
    const result = predict(engine, [sample(0, 0), sample(200, 1), sample(400, 2)], 0);
    expect(result.position?.x).toBeCloseTo(2, 6);
    expect(result.velocityPerMs?.x).toBeCloseTo(0.005, 6);
    expect(result.horizonMsUsed).toBe(0);
  });

  it("refuses to divide by a zero time span", () => {
    const engine = new PredictionEngine();
    const result = predict(engine, [sample(500, 0), sample(500, 3)], 200);
    expect(result.confidence).toBe("none");
    expect(result.velocityPerMs).toBeNull();
  });

  it("extrapolates vertical motion too, for crystal and elytra cases", () => {
    const engine = new PredictionEngine();
    const result = predict(
      engine,
      [
        sample(0, 0, { position: { x: 0, y: 64, z: 0 } }),
        sample(200, 0, { position: { x: 0, y: 65, z: 2 } }),
      ],
      200,
    );
    expect(result.position?.y).toBeCloseTo(66, 6);
    expect(result.position?.z).toBeCloseTo(4, 6);
  });

  it("rejects a nonsensical horizon", () => {
    const engine = new PredictionEngine();
    expect(() => predict(engine, [sample(0, 0)], -1)).toThrowError(TypeError);
    expect(() => predict(engine, [sample(0, 0)], Number.NaN)).toThrowError(
      TypeError,
    );
  });

  it("rejects an incoherent policy", () => {
    expect(
      () =>
        new PredictionEngine({
          ...DEFAULT_PREDICTION_POLICY,
          maxHorizonMs: 0,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new PredictionEngine({
          ...DEFAULT_PREDICTION_POLICY,
          maxSpeedPerMs: -1,
        }),
    ).toThrowError(TypeError);
    // 一帧永远估不出速度，把门槛设成 1 是自欺欺人。
    expect(
      () =>
        new PredictionEngine({
          ...DEFAULT_PREDICTION_POLICY,
          highConfidenceSamples: 1,
        }),
    ).toThrowError(TypeError);
  });
});
