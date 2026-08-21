import { describe, expect, it } from "vitest";

import {
  baselineLimits,
  baselineServerPolicy,
  ServerPolicyGate,
  VANILLA_ENTITY_ATTACK_REACH,
} from "../src/index.js";

function gate(profile: "STRICT" | "VANILLA_COMPATIBLE" | "NORMAL") {
  return new ServerPolicyGate(baselineServerPolicy("local-isolated-test", profile));
}

describe("ServerPolicyGate reach", () => {
  it("clamps block interaction to the policy reach, not the vanilla maximum", () => {
    const strict = gate("STRICT");
    expect(strict.checkBlockReach(3.7)).toEqual({ allowed: true });
    expect(strict.checkBlockReach(4.4)).toMatchObject({
      allowed: false,
      errorCode: "POLICY_REACH_EXCEEDED",
    });
    expect(gate("VANILLA_COMPATIBLE").checkBlockReach(4.4)).toEqual({
      allowed: true,
    });
  });

  it("holds attack reach at or below the vanilla entity range", () => {
    const vanilla = gate("VANILLA_COMPATIBLE");
    expect(vanilla.checkAttackReach(VANILLA_ENTITY_ATTACK_REACH)).toEqual({
      allowed: true,
    });
    expect(vanilla.checkAttackReach(3.5)).toMatchObject({
      allowed: false,
      errorCode: "POLICY_ATTACK_REACH_EXCEEDED",
    });
  });

  it("rejects non-finite and negative distances instead of passing them through", () => {
    const strict = gate("STRICT");
    expect(strict.checkBlockReach(Number.NaN).allowed).toBe(false);
    expect(strict.checkBlockReach(Number.POSITIVE_INFINITY).allowed).toBe(false);
    expect(strict.checkAttackReach(-1).allowed).toBe(false);
  });
});

describe("ServerPolicyGate action rate", () => {
  it("enforces the per-second window rather than only the last gap", () => {
    const g = gate("NORMAL");
    const limit = baselineLimits("NORMAL").maxAttacksPerSecond;
    let now = 10_000;
    for (let index = 0; index < limit; index += 1) {
      expect(g.checkActionRate("attack", now)).toEqual({ allowed: true });
      g.recordAction("attack", now);
      now += baselineLimits("NORMAL").minActionIntervalMs;
    }
    expect(g.checkActionRate("attack", now)).toMatchObject({
      allowed: false,
      errorCode: "POLICY_RATE_EXCEEDED",
    });
    expect(g.checkActionRate("attack", 11_100)).toEqual({ allowed: true });
  });

  it("keeps a global minimum interval across different action kinds", () => {
    const g = gate("STRICT");
    expect(g.checkActionRate("attack", 5_000)).toEqual({ allowed: true });
    g.recordAction("attack", 5_000);
    expect(g.checkActionRate("place", 5_010)).toMatchObject({
      allowed: false,
      errorCode: "POLICY_ACTION_INTERVAL_TOO_SHORT",
    });
    expect(
      g.checkActionRate("place", 5_000 + baselineLimits("STRICT").minActionIntervalMs),
    ).toEqual({ allowed: true });
  });

  it("does not spend quota on denied attempts", () => {
    const g = gate("STRICT");
    const limit = baselineLimits("STRICT").maxPlacementsPerSecond;
    for (let index = 0; index < limit * 3; index += 1) {
      g.checkActionRate("place", 1_000);
    }
    expect(g.checkActionRate("place", 1_000)).toEqual({ allowed: true });
  });

  it("tracks each action kind in its own window", () => {
    const g = gate("NORMAL");
    let now = 0;
    for (let index = 0; index < baselineLimits("NORMAL").maxAttacksPerSecond; index += 1) {
      g.recordAction("attack", now);
      now += baselineLimits("NORMAL").minActionIntervalMs;
    }
    expect(g.checkActionRate("attack", now).allowed).toBe(false);
    expect(g.checkActionRate("hotbar-switch", now).allowed).toBe(true);
  });
});

describe("ServerPolicyGate rotation smoothing", () => {
  it("limits a 180-degree snap to the per-tick budget", () => {
    const g = gate("STRICT");
    const result = g.clampRotation({ yaw: 0, pitch: 0 }, { yaw: 180, pitch: 0 }, 50);
    expect(result.clamped).toBe(true);
    expect(result.yaw).toBeCloseTo(baselineLimits("STRICT").maxYawDeltaPerTick);
  });

  it("passes small rotations through untouched", () => {
    const g = gate("NORMAL");
    const result = g.clampRotation({ yaw: 10, pitch: 5 }, { yaw: 20, pitch: 10 }, 50);
    expect(result).toMatchObject({ yaw: 20, pitch: 10, clamped: false });
  });

  it("takes the short way around the yaw wrap instead of the long way", () => {
    const g = gate("NORMAL");
    const result = g.clampRotation({ yaw: 179, pitch: 0 }, { yaw: -179, pitch: 0 }, 50);
    expect(result.clamped).toBe(false);
    expect(result.yaw).toBeCloseTo(-179);
  });

  it("grants a larger budget for longer elapsed time but never for sub-tick calls", () => {
    const g = gate("STRICT");
    const perTick = baselineLimits("STRICT").maxYawDeltaPerTick;
    const fourTicks = g.clampRotation({ yaw: 0, pitch: 0 }, { yaw: 180, pitch: 0 }, 200);
    expect(fourTicks.yaw).toBeCloseTo(perTick * 4);

    const subTick = g.clampRotation({ yaw: 0, pitch: 0 }, { yaw: 180, pitch: 0 }, 5);
    expect(subTick.yaw).toBeCloseTo(perTick);
    const zeroElapsed = g.clampRotation({ yaw: 0, pitch: 0 }, { yaw: 180, pitch: 0 }, 0);
    expect(zeroElapsed.yaw).toBeCloseTo(perTick);
  });

  it("keeps pitch inside the legal vertical range", () => {
    const g = gate("NORMAL");
    const result = g.clampRotation({ yaw: 0, pitch: 89 }, { yaw: 0, pitch: 200 }, 1_000);
    expect(result.pitch).toBe(90);
  });
});

describe("ServerPolicyGate movement", () => {
  it("blocks sprint under STRICT and allows it under VANILLA_COMPATIBLE", () => {
    const request = { sprint: true, jump: false, airStrafe: false, fallBlocks: 0 };
    expect(gate("STRICT").checkMovement(request)).toMatchObject({
      allowed: false,
      errorCode: "POLICY_SPRINT_FORBIDDEN",
    });
    expect(gate("VANILLA_COMPATIBLE").checkMovement(request)).toEqual({
      allowed: true,
    });
  });

  it("separates the sprint-jump combo from plain sprint and plain jump", () => {
    const g = gate("VANILLA_COMPATIBLE");
    expect(
      g.checkMovement({ sprint: true, jump: true, airStrafe: false, fallBlocks: 0 }),
    ).toMatchObject({ allowed: false, errorCode: "POLICY_SPRINT_JUMP_FORBIDDEN" });
    expect(
      gate("NORMAL").checkMovement({
        sprint: true,
        jump: true,
        airStrafe: false,
        fallBlocks: 0,
      }),
    ).toEqual({ allowed: true });
  });

  it("denies air strafe and over-limit falls", () => {
    const g = gate("NORMAL");
    expect(
      g.checkMovement({ sprint: false, jump: false, airStrafe: true, fallBlocks: 0 }),
    ).toMatchObject({ allowed: false, errorCode: "POLICY_AIR_STRAFE_FORBIDDEN" });
    expect(
      g.checkMovement({ sprint: false, jump: false, airStrafe: false, fallBlocks: 9 }),
    ).toMatchObject({ allowed: false, errorCode: "POLICY_FALL_TOO_FAR" });
    expect(
      g.checkMovement({
        sprint: false,
        jump: false,
        airStrafe: false,
        fallBlocks: Number.NaN,
      }),
    ).toMatchObject({ allowed: false, errorCode: "POLICY_FALL_TOO_FAR" });
  });
});
