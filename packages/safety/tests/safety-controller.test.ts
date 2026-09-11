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

    // 断线保号要求"血正在掉"：稳定低血不再直接断线（否则低血重连变成
    // 断线死循环），改为吃食物回血；随后一次仍在下降的观测才触发断线。
    const controller = new L0SafetyController();
    // 满腹时无法进食：稳定危急血量只暂停，等自然回血。
    const stableCriticalFullBelly = controller.evaluate(snapshot({ health: 4 }));
    expect(stableCriticalFullBelly.severity).toBe("critical");
    expect(stableCriticalFullBelly.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
    ]);

    const stableCriticalHungry = new L0SafetyController().evaluate(
      snapshot({ health: 4, foodLevel: 17 }),
    );
    expect(stableCriticalHungry.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "CONSUME_SAFE_FOOD",
    ]);

    const fallingCritical = controller.evaluate(snapshot({
      observedAtMs: 10_000,
      health: 2,
    }));
    expect(fallingCritical.actions.map(({ kind }) => kind)).toEqual([
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

  it("self-heals a full inventory with a deterministic junk drop before pausing", () => {
    // 只暂停是必然死锁：没有任何上层会在暂停期间清背包。现在先丢垃圾，
    // 丢得动下一轮评估就解除风险；全是必需品时才维持暂停。
    const controller = new L0SafetyController();
    const decision = controller.evaluate(snapshot({
      inventory: { usedSlots: 36, totalSlots: 36 },
    }));
    expect(decision.activeRisks).toEqual(["INVENTORY_FULL"]);
    expect(decision.actions.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "TIDY_DROP_JUNK",
    ]);
    expect(decision.actions[1]).toMatchObject({ risk: "INVENTORY_FULL" });
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

  it("re-issues an unconfirmed emergency stop instead of waiting out the dedupe window", () => {
    // §6 紧急停止优先于一切：60s 是"确认成功后的去重"，不能同时充当"没送出去
    // 时的沉默期"。未确认时按 UNCONFIRMED_EMERGENCY_STOP_RETRY_MS（5s）重发。
    const controller = new L0SafetyController();
    // 断线保号本来的判据就是"血还在掉"：先建立基线，再观测到下降。
    controller.evaluate(snapshot({ health: 4, observedAtMs: 1_000 }));
    expect(
      controller.evaluate(snapshot({ health: 2, observedAtMs: 2_000 })).actions,
    ).toContainEqual({ kind: "EMERGENCY_STOP", risk: "CRITICAL_HEALTH" });
    controller.reportEmergencyStop(false);

    // 5s 重发间隔内不刷屏。
    expect(
      controller.evaluate(snapshot({ health: 1, observedAtMs: 4_000 })).actions,
    ).not.toContainEqual(expect.objectContaining({ kind: "EMERGENCY_STOP" }));

    // 超过 5s 立刻重发，不必等满 60s（血仍在掉）。
    controller.evaluate(snapshot({ health: 2, observedAtMs: 7_000 - 1 }));
    expect(
      controller.evaluate(snapshot({ health: 1, observedAtMs: 7_000 })).actions,
    ).toContainEqual({ kind: "EMERGENCY_STOP", risk: "CRITICAL_HEALTH" });

    // 仍处于 60s 去重窗口内（12s - 2s = 10s < 60s），却已经发出了第二次。
    expect(12_000 - 2_000).toBeLessThan(60_000);
    controller.reportEmergencyStop(false);
    controller.evaluate(snapshot({ health: 2, observedAtMs: 11_999 }));
    expect(
      controller.evaluate(snapshot({ health: 1, observedAtMs: 12_000 })).actions,
    ).toContainEqual({ kind: "EMERGENCY_STOP", risk: "CRITICAL_HEALTH" });
  });

  it("still dedupes a confirmed emergency stop for the normal window", () => {
    const controller = new L0SafetyController();
    controller.evaluate(snapshot({ health: 4, observedAtMs: 1_000 }));
    expect(
      controller.evaluate(snapshot({ health: 2, observedAtMs: 2_000 })).actions,
    ).toContainEqual({ kind: "EMERGENCY_STOP", risk: "CRITICAL_HEALTH" });
    controller.reportEmergencyStop(true);

    // 确认成功后即使过了 5s 甚至 59s 也不重发。
    for (const observedAtMs of [7_000, 30_000, 61_000]) {
      controller.evaluate(snapshot({ health: 2, observedAtMs: observedAtMs - 1_000 }));
      expect(
        controller.evaluate(snapshot({ health: 1, observedAtMs })).actions,
      ).not.toContainEqual(expect.objectContaining({ kind: "EMERGENCY_STOP" }));
    }
    // 60s 去重窗口过去后才会再次请求。
    controller.evaluate(snapshot({ health: 2, observedAtMs: 62_000 }));
    expect(
      controller.evaluate(snapshot({ health: 1, observedAtMs: 62_001 })).actions,
    ).toContainEqual({ kind: "EMERGENCY_STOP", risk: "CRITICAL_HEALTH" });
  });

  it("ignores an emergency stop result for a stop it never issued", () => {
    // 没有已记录的紧急停止时间戳 = 不存在可缩短的沉默期；此时上报不能凭空
    // 造出一次动作，也不能污染后续去重。
    const controller = new L0SafetyController();
    controller.reportEmergencyStop(false);
    const decision = controller.evaluate(
      snapshot({ health: 2, observedAtMs: 2_000 }),
    );
    expect(decision.actions).toEqual([{ kind: "PAUSE_NORMAL_TASKS", risk: "CRITICAL_HEALTH" }]);
    expect(decision.actions).not.toContainEqual(
      expect.objectContaining({ kind: "EMERGENCY_STOP" }),
    );
  });
});
