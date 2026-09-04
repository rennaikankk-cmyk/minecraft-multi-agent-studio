// 语义回归（Phase 3 前置检查）：拒绝名映射的抢占/取消/追载语义。
import { describe, expect, it } from "vitest";
import {
  classifyMovementRejection,
  goalColumnLoaded,
  INTENTIONAL_STOP_ATTRIBUTION_MS,
} from "../src/movement-rejection.js";

describe("classifyMovementRejection", () => {
  it("GoalChanged never auto-retries the superseded goal", () => {
    const decision = classifyMovementRejection("GoalChanged", {
      msSinceIntentionalStop: null,
      goalColumnLoaded: true,
    });
    expect(decision).toEqual({ code: "MOVEMENT_GOAL_REPLACED", retryable: false });
  });

  it("PathStopped inside the intentional-stop window is preemption (non-retryable)", () => {
    const decision = classifyMovementRejection("PathStopped", {
      msSinceIntentionalStop: 100,
      goalColumnLoaded: true,
    });
    expect(decision).toEqual({ code: "MOVEMENT_PATH_PREEMPTED", retryable: false });
  });

  it("PathStopped outside the window allows bounded recovery", () => {
    const decision = classifyMovementRejection("PathStopped", {
      msSinceIntentionalStop: INTENTIONAL_STOP_ATTRIBUTION_MS + 1,
      goalColumnLoaded: true,
    });
    expect(decision.retryable).toBe(true);
  });

  it("NoPath with the goal column loaded is a final unreachable verdict", () => {
    const decision = classifyMovementRejection("NoPath", {
      msSinceIntentionalStop: null,
      goalColumnLoaded: true,
    });
    expect(decision).toEqual({ code: "MOVEMENT_NO_PATH_CONFIRMED", retryable: false });
  });

  it("NoPath while the goal chunk is still streaming allows bounded retry (chunk catch-up)", () => {
    const decision = classifyMovementRejection("NoPath", {
      msSinceIntentionalStop: null,
      goalColumnLoaded: false,
    });
    expect(decision.retryable).toBe(true);
  });

  it("NoPath with unknown chunk state degrades conservatively to non-retryable", () => {
    const decision = classifyMovementRejection("NoPath", {
      msSinceIntentionalStop: null,
      goalColumnLoaded: null,
    });
    expect(decision.retryable).toBe(false);
  });

  it("Timeout stays bounded-retryable (budget exhaustion proves no unreachability)", () => {
    const decision = classifyMovementRejection("Timeout", {
      msSinceIntentionalStop: null,
      goalColumnLoaded: true,
    });
    expect(decision.retryable).toBe(true);
  });
});

describe("goalColumnLoaded", () => {
  it("returns true when the column resolves and false while streaming", () => {
    const world = {
      getColumn: (x: number, z: number) => {
        if (x === 0 && z === 0) return { blocks: [] };
        throw new Error("column not loaded");
      },
    };
    expect(goalColumnLoaded(world, 5, 5)).toBe(true);
    expect(goalColumnLoaded(world, 20, 5)).toBe(false);
  });
});
