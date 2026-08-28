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
