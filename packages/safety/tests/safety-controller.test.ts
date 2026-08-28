import { describe, expect, it } from "vitest";

import {
  L0SafetyController,
  type L0SafetySnapshot,
} from "../src/index.js";

function snapshot(
  overrides: Partial<L0SafetySnapshot> = {},
): L0SafetySnapshot {
  return {
    observedAtMs: 1_000,
    health: 20,
    foodLevel: 20,
    oxygenLevel: 20,
    inWater: false,
    inLava: false,
    onGround: true,
    velocityY: 0,
    position: { x: 0, y: 64, z: 0 },
    inventory: { usedSlots: 4, totalSlots: 36 },
    hasSafeFood: true,
    movementRequested: false,
    ...overrides,
  };
}

describe("L0SafetyController", () => {
  it("keeps a healthy stationary Bot in monitoring mode", () => {
    const decision = new L0SafetyController().evaluate(snapshot());
    expect(decision).toMatchObject({
      severity: "none",
      activeRisks: [],
      normalTasksPaused: false,
      actions: [],
    });
  });

  it("selects only safe food and respects the eat cooldown", () => {
    const controller = new L0SafetyController();
    const first = controller.evaluate(snapshot({ foodLevel: 10 }));
    expect(first.activeRisks).toContain("HUNGER");
    expect(first.normalTasksPaused).toBe(true);
    expect(first.actions).toContainEqual({
      kind: "CONSUME_SAFE_FOOD",
      risk: "HUNGER",
    });
    expect(
      controller.evaluate(snapshot({ observedAtMs: 2_000, foodLevel: 10 })).actions,
    ).not.toContainEqual(expect.objectContaining({ kind: "CONSUME_SAFE_FOOD" }));
    expect(
      new L0SafetyController().evaluate(
        snapshot({ foodLevel: 10, hasSafeFood: false }),
      ).actions,
    ).toContainEqual({ kind: "FORAGE_SAFE_FOOD", risk: "HUNGER" });
  });

  it("preempts normal work for low and critical health", () => {
    const low = new L0SafetyController().evaluate(snapshot({ health: 8 }));
    expect(low.normalTasksPaused).toBe(true);
    expect(low.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "RETREAT_STEP",
    ]);

    const critical = new L0SafetyController().evaluate(snapshot({ health: 4 }));
    expect(critical.severity).toBe("critical");
    expect(critical.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "EMERGENCY_STOP",
    ]);
  });

  it("bounds low-health retreat steps and eats when recovery food is usable", () => {
    const controller = new L0SafetyController();
    const first = controller.evaluate(snapshot({
      health: 8,
      foodLevel: 17,
    }));
    expect(first.actions).toEqual([
      { kind: "PAUSE_NORMAL_TASKS", risk: "LOW_HEALTH" },
      { kind: "CONSUME_SAFE_FOOD", risk: "LOW_HEALTH" },
      { kind: "RETREAT_STEP", risk: "LOW_HEALTH", durationMs: 700 },
    ]);

    const second = controller.evaluate(snapshot({
      observedAtMs: 3_100,
      health: 8,
      foodLevel: 17,
    }));
    expect(second.actions).toContainEqual({
      kind: "RETREAT_STEP",
      risk: "LOW_HEALTH",
      durationMs: 700,
    });

    const bounded = controller.evaluate(snapshot({
      observedAtMs: 6_200,
      health: 8,
      foodLevel: 17,
    }));
    expect(bounded.actions).not.toContainEqual(
      expect.objectContaining({ kind: "RETREAT_STEP" }),
    );

    controller.evaluate(snapshot({ observedAtMs: 7_000, health: 9 }));
    const newEpisode = controller.evaluate(snapshot({
      observedAtMs: 9_000,
      health: 8,
      foodLevel: 20,
    }));
    expect(newEpisode.actions).toContainEqual({
      kind: "RETREAT_STEP",
      risk: "LOW_HEALTH",
      durationMs: 700,
    });
  });

  it("forages instead of deadlocking when low health has no safe food", () => {
    const decision = new L0SafetyController().evaluate(snapshot({
      health: 8,
      foodLevel: 17,
      hasSafeFood: false,
    }));
    expect(decision.normalTasksPaused).toBe(true);
    expect(decision.actions).toEqual([
      { kind: "PAUSE_NORMAL_TASKS", risk: "LOW_HEALTH" },
      { kind: "FORAGE_SAFE_FOOD", risk: "LOW_HEALTH" },
      { kind: "RETREAT_STEP", risk: "LOW_HEALTH", durationMs: 700 },
    ]);
  });

  it("handles drowning and lava with deterministic bounded actions", () => {
    const drowning = new L0SafetyController().evaluate(
      snapshot({ inWater: true, oxygenLevel: 5, onGround: false }),
    );
    expect(drowning.activeRisks).toContain("DROWNING");
    expect(drowning.actions).toContainEqual({
      kind: "ASCEND",
      risk: "DROWNING",
      durationMs: 750,
    });

    const lava = new L0SafetyController().evaluate(
      snapshot({ inLava: true, onGround: false }),
    );
    expect(lava.activeRisks).toContain("LAVA");
    expect(lava.actions).toContainEqual({
      kind: "ESCAPE_LAVA",
      risk: "LAVA",
      durationMs: 1_000,
    });
  });

  it("selects one highest-priority movement response for combined risks", () => {
    const lava = new L0SafetyController().evaluate(
      snapshot({ health: 8, inLava: true, onGround: false }),
    );
    expect(lava.activeRisks).toEqual(["LAVA", "LOW_HEALTH"]);
    expect(lava.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "ESCAPE_LAVA",
    ]);

    const falling = new L0SafetyController().evaluate(
      snapshot({ health: 8, onGround: false, velocityY: -0.8 }),
    );
    expect(falling.activeRisks).toEqual(["FALLING", "LOW_HEALTH"]);
    expect(falling.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "HALT_HORIZONTAL_MOVEMENT",
    ]);
  });

  it("detects falling, full inventory, and a real lack of movement", () => {
    const controller = new L0SafetyController();
    const falling = controller.evaluate(snapshot({
      onGround: false,
      velocityY: -0.8,
      inventory: { usedSlots: 36, totalSlots: 36 },
    }));
    expect(falling.activeRisks).toEqual(["FALLING", "INVENTORY_FULL"]);
    expect(falling.actions.map(({ kind }) => kind)).toContain(
      "HALT_HORIZONTAL_MOVEMENT",
    );

    controller.evaluate(snapshot({
      observedAtMs: 10_000,
      movementRequested: true,
    }));
    const stuck = controller.evaluate(snapshot({
      observedAtMs: 15_000,
      movementRequested: true,
    }));
    expect(stuck.activeRisks).toContain("STUCK");
    expect(stuck.actions).toContainEqual({
      kind: "UNSTICK",
      risk: "STUCK",
      durationMs: 600,
    });

    const moved = controller.evaluate(snapshot({
      observedAtMs: 16_000,
      movementRequested: true,
      position: { x: 1, y: 64, z: 0 },
    }));
    expect(moved.activeRisks).not.toContain("STUCK");
  });

  it("rejects invalid or fabricated physical values", () => {
    expect(() =>
      new L0SafetyController().evaluate(snapshot({ velocityY: Number.NaN })),
    ).toThrowError(/velocityY/u);
    expect(() =>
      new L0SafetyController().evaluate(snapshot({
        inventory: { usedSlots: 40, totalSlots: 36 },
      })),
    ).toThrowError(/Inventory/u);
  });

  it("resets cooldown and movement history for a new Bot connection", () => {
    const controller = new L0SafetyController();
    controller.evaluate(snapshot({ foodLevel: 10 }));
    expect(
      controller.evaluate(snapshot({ observedAtMs: 2_000, foodLevel: 10 })).actions,
    ).toEqual([]);

    controller.reset();
    expect(
      controller.evaluate(snapshot({ observedAtMs: 2_000, foodLevel: 10 })).actions,
    ).toContainEqual({ kind: "CONSUME_SAFE_FOOD", risk: "HUNGER" });
  });
});
