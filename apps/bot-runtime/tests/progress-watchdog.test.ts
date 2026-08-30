import { describe, expect, it } from "vitest";

import { ProgressWatchdog } from "../src/progress-watchdog.js";

const sample = (time: number, goalKey = "mine:oak_log") => ({
  observedAtMs: time,
  position: { x: 0, y: 64, z: 0 },
  inventoryFingerprint: "empty",
  targetDistance: 10,
  goalKey,
});

describe("ProgressWatchdog", () => {
  it("emits local unstuck and local replan signals without an AI call", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 8_000, noProgressAfterMs: 20_000 });
    expect(watchdog.observe(sample(0))).toEqual([
      expect.objectContaining({ kind: "progress" }),
    ]);
    expect(watchdog.observe(sample(8_000)).map((event) => event.recoverySuggested)).toContain("local-unstuck");
    expect(watchdog.observe(sample(20_000)).map((event) => event.recoverySuggested)).toContain("local-replan");
    expect(watchdog.snapshot()).toMatchObject({ stuckCount: 1, noProgressCount: 1 });
  });

  it("detects alternating goals as a high-level loop", () => {
    const watchdog = new ProgressWatchdog({ movementEpsilon: 0, distanceEpsilon: 0 });
    watchdog.observe(sample(0, "a"));
    watchdog.observe(sample(1, "b"));
    watchdog.observe(sample(2, "a"));
    const events = watchdog.observe(sample(3, "b"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "loop", recoverySuggested: "high-level-replan" }),
    ]));
  });

  it("does not report an idle bot or call a long non-movement action stuck", () => {
    const watchdog = new ProgressWatchdog({
      stuckAfterMs: 8_000,
      noProgressAfterMs: 20_000,
    });
    expect(watchdog.observe({
      ...sample(0),
      active: false,
      movementExpected: false,
    })).toEqual([]);
    expect(watchdog.observe({
      ...sample(30_000),
      active: false,
      movementExpected: false,
    })).toEqual([]);

    watchdog.observe({ ...sample(40_000), active: true, movementExpected: false });
    expect(
      watchdog.observe({
        ...sample(48_000),
        active: true,
        movementExpected: false,
      }),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "stuck" })]));
  });

  it("counts repeated path resets as a loop instead of useful progress", () => {
    const watchdog = new ProgressWatchdog({
      repeatedGoalLimit: 4,
      pathResetLimit: 5,
    });
    watchdog.observe({ ...sample(0), pathResetCount: 0 });
    watchdog.observe({ ...sample(1_000), pathResetCount: 1 });
    watchdog.observe({ ...sample(2_000), pathResetCount: 2 });
    const events = watchdog.observe({ ...sample(3_000), pathResetCount: 3 });

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "loop",
        recoverySuggested: "high-level-replan",
      }),
    ]));
    expect(watchdog.snapshot().lastProgressAtMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round 3: expected-progress contract（十一节）
// ---------------------------------------------------------------------------
describe("expected-progress contract", () => {
  const base = (over: Record<string, unknown>) => ({
    observedAtMs: 0,
    position: { x: 0, y: 64, z: 0 },
    ...over,
  });

  it("timer_wait phase: position stagnation is normal (no stuck/no-progress)", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    const events = [];
    for (let t = 0; t <= 5_000; t += 500) {
      events.push(...watchdog.observe(base({
        observedAtMs: t,
        phaseKey: "smelt:await",
        phaseExpectation: "timer_wait",
        phaseDeadlineMs: 60_000,
      })));
    }
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "no-progress")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "deadline-exceeded")).toHaveLength(0);
  });

  it("timer_wait phase: passing deadline with no expected signal fires deadline-exceeded once", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    const events = [];
    for (let t = 0; t <= 8_000; t += 500) {
      events.push(...watchdog.observe(base({
        observedAtMs: t,
        phaseKey: "smelt:await",
        phaseExpectation: "timer_wait",
        phaseDeadlineMs: 4_000,
      })));
    }
    expect(events.filter((e) => e.kind === "deadline-exceeded")).toHaveLength(1);
    expect(events.find((e) => e.kind === "deadline-exceeded")!.recoverySuggested).toBe("high-level-replan");
  });

  it("inventory_change expectation: position stagnation alone never fires stuck", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    for (let t = 0; t <= 5_000; t += 500) {
      watchdog.observe(base({ observedAtMs: t, phaseExpectation: "inventory_change" }));
    }
    const snap = watchdog.snapshot();
    expect(snap.stuckCount).toBe(0);
  });

  it("movement expectation: same-position samples past threshold fire stuck + no-progress", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 3_000 });
    const events = [];
    for (let t = 0; t <= 5_000; t += 500) {
      events.push(...watchdog.observe(base({ observedAtMs: t, phaseExpectation: "movement" })));
    }
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "no-progress")).toHaveLength(1);
  });

  it("oscillation: movement within small radius over window fires oscillation once", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 60_000, noProgressAfterMs: 120_000, oscillationRadius: 2 });
    const events = [];
    const wiggle = [
      { x: 0, y: 64, z: 0 }, { x: 1.4, y: 64, z: 0 },
      { x: 0, y: 64, z: 1.4 }, { x: 1.4, y: 64, z: 1.4 },
    ];
    for (let i = 0; i < 12; i += 1) {
      events.push(...watchdog.observe(base({ observedAtMs: i * 500, position: wiggle[i % 4]! })));
    }
    expect(events.filter((e) => e.kind === "oscillation")).toHaveLength(1);
  });

  it("normal single retry does not create stuck (progress resets alarm)", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000 });
    watchdog.observe(base({ observedAtMs: 0, phaseExpectation: "movement" }));
    // 2s 静止 → stuck
    const stuck = watchdog.observe(base({ observedAtMs: 2_000, phaseExpectation: "movement" }));
    expect(stuck.some((e) => e.kind === "stuck")).toBe(true);
    // 一次性真实移动 → progress，报警解除
    const after = watchdog.observe(base({ observedAtMs: 3_000, position: { x: 5, y: 64, z: 5 }, phaseExpectation: "movement" }));
    expect(after.some((e) => e.kind === "progress")).toBe(true);
    // 再静止 2s 才会再次 stuck（不是每个 tick 都报）
    const again = watchdog.observe(base({ observedAtMs: 5_000, phaseExpectation: "movement" }));
    expect(again.some((e) => e.kind === "stuck")).toBe(false);
    const later = watchdog.observe(base({ observedAtMs: 6_000, phaseExpectation: "movement" }));
    expect(later.some((e) => e.kind === "stuck")).toBe(true);
  });

  it("deadline-exceeded dedups per phaseKey until phase changes", () => {
    const watchdog = new ProgressWatchdog();
    let fired = 0;
    for (let t = 0; t <= 10_000; t += 1_000) {
      fired += watchdog.observe(base({
        observedAtMs: t, phaseKey: "craft:await", phaseExpectation: "timer_wait", phaseDeadlineMs: 2_000,
      })).filter((e) => e.kind === "deadline-exceeded").length;
    }
    expect(fired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round 4: 按动作/阶段的进度契约 + FailureSignal（2/3 节）
// ---------------------------------------------------------------------------
import { PROGRESS_CONTRACTS } from "../src/progress-watchdog.js";

describe("action/phase progress contracts", () => {
  const base = (over) => ({ observedAtMs: 0, position: { x: 0, y: 64, z: 0 }, ...over });

  it("registry exposes the five named contracts with expectations", () => {
    expect(Object.keys(PROGRESS_CONTRACTS).sort()).toEqual([
      "MOVE_TO_TARGET", "PLACE_AND_VERIFY", "RECOVERING", "SMELTING_WAIT", "WAITING_EXTERNAL",
    ]);
    expect(PROGRESS_CONTRACTS.MOVE_TO_TARGET.expectation).toBe("movement");
    expect(PROGRESS_CONTRACTS.PLACE_AND_VERIFY.expectation).toBe("world_state_change");
    expect(PROGRESS_CONTRACTS.SMELTING_WAIT.expectation).toBe("server_event");
    expect(PROGRESS_CONTRACTS.WAITING_EXTERNAL.expectation).toBe("timer_wait");
    expect(PROGRESS_CONTRACTS.RECOVERING.expectation).toBe("timer_wait");
    expect(PROGRESS_CONTRACTS.RECOVERING.deadlineMs).toBeGreaterThan(0);
  });

  it("SMELTING_WAIT: stationary is normal; contract default deadline fires deadline-exceeded", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    const events = [];
    for (let t = 0; t <= 70_000; t += 2_000) {
      events.push(...watchdog.observe(base({
        observedAtMs: t,
        contract: "SMELTING_WAIT",
        phaseKey: "smelt:ore-iron",
      })));
    }
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "no-progress")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "deadline-exceeded")).toHaveLength(1);
  });

  it("PLACE_AND_VERIFY: stationary normal; world signal (inventory proxy) counts as progress", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    const events = [];
    for (let t = 0; t <= 30_000; t += 2_000) {
      events.push(...watchdog.observe(base({
        observedAtMs: t,
        contract: "PLACE_AND_VERIFY",
        phaseKey: "place:furnace-1",
      })));
      if (t === 10_000) {
        events.push(...watchdog.observe(base({ observedAtMs: t + 1_000, contract: "PLACE_AND_VERIFY", phaseKey: "place:furnace-1", inventoryFingerprint: "changed" })));
      }
    }
    expect(events.filter((e) => e.kind === "stuck")).toHaveLength(0);
  });

  it("RECOVERING: recovery gets its own window, then deadline-exceeded (no infinite exemption)", () => {
    const watchdog = new ProgressWatchdog({ stuckAfterMs: 1_000, noProgressAfterMs: 2_000 });
    const events = [];
    for (let t = 0; t <= 40_000; t += 2_000) {
      events.push(...watchdog.observe(base({
        observedAtMs: t,
        contract: "RECOVERING",
        phaseKey: "recover:unstuck-1",
      })));
    }
    expect(events.filter((e) => e.kind === "deadline-exceeded")).toHaveLength(1);
  });

  it("MOVE_TO_TARGET: stagnant movement fires stuck (contract default)", () => {
    const watchdog = new ProgressWatchdog();
    let stuck = 0;
    for (let t = 0; t <= 12_000; t += 1_000) {
      stuck += watchdog.observe(base({ observedAtMs: t, contract: "MOVE_TO_TARGET" }))
        .filter((e) => e.kind === "stuck").length;
    }
    expect(stuck).toBe(1);
  });

  it("unknown contract name is rejected (no silent fallback)", () => {
    const watchdog = new ProgressWatchdog();
    expect(() => watchdog.observe(base({ observedAtMs: 0, contract: "VIBING" }))).toThrow(/contract/);
  });
});
