import { describe, expect, it } from "vitest";

import {
  CombatReflexNotClearedError,
  decideReflexClearance,
} from "../src/reflex-clearance.js";
import {
  DEFAULT_TOTEM_POLICY,
  TotemManager,
  type CombatTotemSnapshot,
} from "../src/totem-manager.js";

function snapshot(
  overrides: Partial<CombatTotemSnapshot> = {},
): CombatTotemSnapshot {
  return {
    nowMs: 1_000,
    offhandIsTotem: true,
    inventoryTotemCount: 4,
    selfHealth: 20,
    engaged: true,
    ...overrides,
  };
}

const CLEARED = decideReflexClearance(
  {
    p99LoopDelayMs: 18,
    samples: 5_000,
    underRepresentativeLoad: true,
    serverProfileId: "srv-a",
  },
  "srv-a",
);

describe("TotemManager.decide", () => {
  it("re-equips immediately and preempts everything else when the offhand empties", () => {
    const decision = new TotemManager().decide(
      snapshot({ offhandIsTotem: false }),
    );
    expect(decision).toMatchObject({
      action: "REEQUIP_OFFHAND",
      reason: "OFFHAND_EMPTY",
      preempts: true,
      totemsRemainingAfter: 3,
    });
  });

  it("prioritizes a self POP over a stale offhand snapshot and deduplicates after ACK", () => {
    const manager = new TotemManager();
    const popped = snapshot({
      nowMs: 1_000,
      offhandIsTotem: true,
      inventoryTotemCount: 2,
      totemPopObservedAtMs: 1_000,
    });

    expect(manager.decide(popped)).toMatchObject({
      action: "REEQUIP_OFFHAND",
      reason: "TOTEM_POP_OBSERVED",
      preempts: true,
      totemsRemainingAfter: 1,
    });
    manager.recordReequip(1_005);
    manager.recordTotemPopHandled(1_000);

    expect(
      manager.decide({
        ...popped,
        nowMs: 1_010,
        offhandIsTotem: false,
      }),
    ).toMatchObject({
      action: "NONE",
      reason: "TOTEM_POP_HANDLED",
      preempts: false,
    });

    // The adapter stops forwarding the POP after its short action window. A
    // later, genuinely empty slot is therefore eligible for a new replacement.
    expect(
      manager.decide({
        ...popped,
        nowMs: 6_000,
        offhandIsTotem: false,
        totemPopObservedAtMs: null,
      }),
    ).toMatchObject({ action: "REEQUIP_OFFHAND", reason: "OFFHAND_EMPTY" });
  });

  it("retreats on a self POP when preserve-life has no spare totem", () => {
    expect(
      new TotemManager().decide(
        snapshot({
          offhandIsTotem: true,
          inventoryTotemCount: 0,
          totemPopObservedAtMs: 1_000,
        }),
      ),
    ).toMatchObject({
      action: "RETREAT",
      reason: "NO_TOTEM_AVAILABLE",
      preempts: true,
    });
  });

  it("retreats rather than fighting on with no totem anywhere", () => {
    const decision = new TotemManager().decide(
      snapshot({ offhandIsTotem: false, inventoryTotemCount: 0 }),
    );
    expect(decision).toMatchObject({
      action: "RETREAT",
      reason: "NO_TOTEM_AVAILABLE",
      preempts: true,
      totemsRemainingAfter: 0,
    });
  });

  it("does nothing when the totem is already held at full health", () => {
    expect(new TotemManager().decide(snapshot())).toMatchObject({
      action: "NONE",
      reason: "ALREADY_HELD",
      preempts: false,
    });
  });

  it("flags a preemptive check at half health without spending a spare", () => {
    const decision = new TotemManager().decide(snapshot({ selfHealth: 9 }));
    expect(decision).toMatchObject({
      action: "NONE",
      reason: "PREEMPTIVE_CHECK",
      preempts: false,
      totemsRemainingAfter: 4,
    });
  });

  it("does not run the preemptive check outside combat", () => {
    expect(
      new TotemManager().decide(snapshot({ selfHealth: 4, engaged: false }))
        .reason,
    ).toBe("ALREADY_HELD");
  });

  it("throttles duplicate events for the same consumption", () => {
    const manager = new TotemManager();
    const empty = snapshot({ offhandIsTotem: false });
    expect(manager.decide(empty).action).toBe("REEQUIP_OFFHAND");
    manager.recordReequip(1_000);
    // 同一帧内的第二个事件不该再补一次。
    expect(manager.decide({ ...empty, nowMs: 1_020 })).toMatchObject({
      action: "NONE",
      reason: "THROTTLED",
    });
    // 过了一个 tick 之后是真的又被打空了，必须补。
    expect(manager.decide({ ...empty, nowMs: 1_050 }).action).toBe(
      "REEQUIP_OFFHAND",
    );
  });

  it("never throttles the retreat path", () => {
    const manager = new TotemManager();
    manager.recordReequip(1_000);
    // 节流窗口内背包空了：仍然必须立刻撤，不能被节流压成 NONE。
    expect(
      manager.decide(
        snapshot({
          nowMs: 1_010,
          offhandIsTotem: false,
          inventoryTotemCount: 0,
        }),
      ),
    ).toMatchObject({ action: "RETREAT", preempts: true });
  });

  it("clears throttle memory on reset", () => {
    const manager = new TotemManager();
    manager.recordReequip(9_000);
    const empty = snapshot({ nowMs: 9_010, offhandIsTotem: false });
    expect(manager.decide(empty).reason).toBe("THROTTLED");
    manager.reset();
    expect(manager.decide(empty).action).toBe("REEQUIP_OFFHAND");
  });

  it("refuses a re-equip record that travels backwards in time", () => {
    const manager = new TotemManager();
    manager.recordReequip(5_000);
    expect(() => manager.recordReequip(4_999)).toThrowError(RangeError);
  });

  it("rejects a POP timestamp that is after the current snapshot", () => {
    expect(() =>
      new TotemManager().decide(
        snapshot({ totemPopObservedAtMs: 1_001 }),
      ),
    ).toThrowError(TypeError);
  });

  it("rejects malformed snapshot data", () => {
    const manager = new TotemManager();
    expect(() =>
      manager.decide(snapshot({ selfHealth: Number.NaN })),
    ).toThrowError(TypeError);
    expect(() =>
      manager.decide(snapshot({ inventoryTotemCount: 1.5 })),
    ).toThrowError(TypeError);
    expect(() => manager.decide(snapshot({ nowMs: Number.NaN }))).toThrowError(
      TypeError,
    );
  });

  it("rejects an out-of-bounds policy", () => {
    expect(
      () =>
        new TotemManager({
          ...DEFAULT_TOTEM_POLICY,
          preemptiveHealthThreshold: -1,
        }),
    ).toThrowError(TypeError);
    expect(
      () =>
        new TotemManager({
          ...DEFAULT_TOTEM_POLICY,
          minimumReequipIntervalMs: Number.NaN,
        }),
    ).toThrowError(TypeError);
  });
});

describe("TotemManager.decideForLiveCombat", () => {
  it("refuses live combat until the timing probe has cleared", () => {
    const manager = new TotemManager();
    expect(() =>
      manager.decideForLiveCombat(
        snapshot({ offhandIsTotem: false }),
        decideReflexClearance(null, "srv-a"),
      ),
    ).toThrowError(CombatReflexNotClearedError);
  });

  it("reports which gate refused rather than a bare failure", () => {
    try {
      new TotemManager().decideForLiveCombat(
        snapshot(),
        decideReflexClearance(
          {
            p99LoopDelayMs: 120,
            samples: 5_000,
            underRepresentativeLoad: true,
            serverProfileId: "srv-a",
          },
          "srv-a",
        ),
      );
      expect.unreachable("未放行必须抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(CombatReflexNotClearedError);
      expect((error as CombatReflexNotClearedError).denial).toBe(
        "P99_ABOVE_BUDGET",
      );
    }
  });

  it("behaves identically to decide once cleared", () => {
    const manager = new TotemManager();
    const empty = snapshot({ offhandIsTotem: false });
    expect(manager.decideForLiveCombat(empty, CLEARED)).toEqual(
      new TotemManager().decide(empty),
    );
  });
});
