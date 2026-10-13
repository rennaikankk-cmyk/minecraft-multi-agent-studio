import { describe, expect, it } from "vitest";

import { deathRecoveryConfirmed } from "../src/autonomous-director.js";

const output = {
  reached: true,
  finalPosition: {
    x: 12,
    y: 64,
    z: -6,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
  distanceToTarget: 0.2,
  recovered: [{ itemId: "diamond", count: 2 }],
  stillNearby: 0,
  expectedMissing: [],
};

function result(skillId: string, stillNearby = 0) {
  return {
    action: "skill_result" as const,
    reasonCode: "DETERMINISTIC_RECOVER_DROPS",
    invocation: { payload: { skillId } },
    result: {
      payload: {
        outcome: "completed" as const,
        output: { ...output, stillNearby },
      },
    },
    ai: null,
  };
}

describe("death recovery confirmation", () => {
  it("accepts only a recover.drops result that left no items nearby", () => {
    expect(deathRecoveryConfirmed(result("recover.drops") as never)).toBe(true);
    expect(deathRecoveryConfirmed(result("recover.drops", 1) as never)).toBe(false);
    expect(deathRecoveryConfirmed(result("movement.goto") as never)).toBe(false);
    expect(deathRecoveryConfirmed({ action: "noop", reasonCode: "ADVANCE_TASK", ai: null } as never)).toBe(false);
  });
});
