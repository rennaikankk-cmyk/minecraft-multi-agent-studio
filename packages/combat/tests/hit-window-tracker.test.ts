import { describe, expect, it } from "vitest";

import {
  HIT_WINDOW_STALE_AFTER_MS,
  TARGET_INVULNERABILITY_WINDOW_MS,
  HitWindowTracker,
} from "../src/hit-window-tracker.js";

const SERVER = "local-isolated-test";

describe("HitWindowTracker", () => {
  it("allows a swing when no hurt data exists", () => {
    expect(new HitWindowTracker(SERVER).stateFor(42, 1_000)).toEqual({
      invulnerableRemainingMs: 0,
      cooldownRatio01: 1,
      lastHurtAgeMs: null,
      confidence: "unknown",
    });
  });

  it("tracks the 500ms hurt window and then marks old context stale", () => {
    const tracker = new HitWindowTracker(SERVER);
    tracker.recordHurt(42, 1_000, SERVER);
    expect(tracker.stateFor(42, 1_125)).toMatchObject({
      invulnerableRemainingMs: TARGET_INVULNERABILITY_WINDOW_MS - 125,
      lastHurtAgeMs: 125,
      confidence: "observed",
    });
    expect(tracker.stateFor(42, 1_500).invulnerableRemainingMs).toBe(0);
    expect(
      tracker.stateFor(42, 1_000 + HIT_WINDOW_STALE_AFTER_MS + 1).confidence,
    ).toBe("stale");
  });

  it("tracks an observed opponent swing cooldown independently", () => {
    const tracker = new HitWindowTracker(SERVER);
    tracker.recordSwingObserved(42, 2_000, 1_000);
    expect(tracker.stateFor(42, 2_250)).toMatchObject({
      cooldownRatio01: 0.25,
      invulnerableRemainingMs: 0,
      confidence: "observed",
    });
    expect(tracker.stateFor(42, 3_000).cooldownRatio01).toBe(1);
  });

  it("drops hurt events from another server before they affect state or time", () => {
    const tracker = new HitWindowTracker(SERVER);
    tracker.recordHurt(42, 2_000, "another-server");
    tracker.recordHurt(42, 1_000, SERVER);
    expect(tracker.stateFor(42, 1_000)).toMatchObject({
      invulnerableRemainingMs: TARGET_INVULNERABILITY_WINDOW_MS,
      confidence: "observed",
    });
  });

  it("rejects time reversal and reset clears records plus clock", () => {
    const tracker = new HitWindowTracker(SERVER);
    tracker.recordHurt(42, 5_000, SERVER);
    expect(() => tracker.stateFor(42, 4_999)).toThrowError(RangeError);
    tracker.reset();
    expect(tracker.stateFor(42, 0).confidence).toBe("unknown");
  });

  it("rejects malformed event data", () => {
    const tracker = new HitWindowTracker(SERVER);
    expect(() => tracker.recordHurt(-1, 0, SERVER)).toThrowError(TypeError);
    expect(() => tracker.recordHurt(1, -1, SERVER)).toThrowError(TypeError);
    expect(() => tracker.recordHurt(1, 0, " ")).toThrowError(TypeError);
    expect(() => tracker.recordSwingObserved(1, 0, 0)).toThrowError(TypeError);
  });
});
