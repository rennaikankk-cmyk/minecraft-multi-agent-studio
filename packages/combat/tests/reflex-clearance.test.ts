import { describe, expect, it } from "vitest";

import {
  REFLEX_BUDGET_MS,
  decideReflexClearance,
  type CombatReflexProbeReport,
} from "../src/reflex-clearance.js";

function report(
  overrides: Partial<CombatReflexProbeReport> = {},
): CombatReflexProbeReport {
  return {
    p99LoopDelayMs: 20,
    samples: 5_000,
    underRepresentativeLoad: true,
    serverProfileId: "srv-a",
    ...overrides,
  };
}

describe("decideReflexClearance", () => {
  it("refuses when the probe has never run", () => {
    expect(decideReflexClearance(null, "srv-a")).toEqual({
      cleared: false,
      denial: "NO_PROBE_DATA",
      budgetMs: REFLEX_BUDGET_MS,
    });
  });

  it("clears only on measured data that meets the tick budget under load", () => {
    expect(decideReflexClearance(report(), "srv-a")).toEqual({
      cleared: true,
      denial: null,
      budgetMs: 50,
    });
  });

  it("refuses when p99 exceeds one tick", () => {
    expect(
      decideReflexClearance(report({ p99LoopDelayMs: 51 }), "srv-a").denial,
    ).toBe("P99_ABOVE_BUDGET");
    // 恰好等于预算算达标：50ms 就是一个 tick。
    expect(
      decideReflexClearance(report({ p99LoopDelayMs: 50 }), "srv-a").cleared,
    ).toBe(true);
  });

  it("refuses a fast result backed by too few samples", () => {
    expect(
      decideReflexClearance(
        report({ p99LoopDelayMs: 1, samples: 10 }),
        "srv-a",
      ),
    ).toMatchObject({ cleared: false, denial: "INSUFFICIENT_SAMPLES" });
  });

  it("refuses a result sampled without representative load", () => {
    expect(
      decideReflexClearance(
        report({ underRepresentativeLoad: false }),
        "srv-a",
      ).denial,
    ).toBe("LOAD_NOT_REPRESENTATIVE");
  });

  it("refuses to carry timing data across servers", () => {
    expect(decideReflexClearance(report(), "srv-b").denial).toBe(
      "SERVER_PROFILE_MISMATCH",
    );
  });

  it("refuses malformed probe data instead of guessing", () => {
    for (const bad of [
      report({ p99LoopDelayMs: Number.NaN }),
      report({ p99LoopDelayMs: -1 }),
      report({ samples: 1.5 }),
      report({ serverProfileId: "  " }),
    ]) {
      expect(decideReflexClearance(bad, "srv-a").cleared).toBe(false);
    }
    expect(decideReflexClearance(report(), "   ").denial).toBe(
      "MALFORMED_PROBE_DATA",
    );
  });

  it("is fail-closed for every rejection path", () => {
    const cases: (CombatReflexProbeReport | null)[] = [
      null,
      report({ p99LoopDelayMs: 80 }),
      report({ samples: 0 }),
      report({ underRepresentativeLoad: false }),
      report({ p99LoopDelayMs: Number.POSITIVE_INFINITY }),
    ];
    for (const probe of cases) {
      const decision = decideReflexClearance(probe, "srv-a");
      expect(decision.cleared).toBe(false);
      // 拒绝必须带原因码，否则调用方无法记录为什么没上。
      expect(decision.denial).not.toBeNull();
    }
  });
});
