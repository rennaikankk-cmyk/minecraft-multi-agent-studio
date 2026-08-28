import { describe, expect, it } from "vitest";

import {
  TOTEM_POP_ABSORPTION_WINDOW_MS,
  TOTEM_POP_REGEN_WINDOW_MS,
  TotemPopTracker,
} from "../src/totem-pop-tracker.js";

const SERVER = "local-isolated-test";
const DIMENSION = "minecraft:overworld";

function record(overrides: Partial<Parameters<TotemPopTracker["record"]>[0]> = {}) {
  return {
    entityId: 42,
    observedAtMs: 1_000,
    serverProfileId: SERVER,
    dimension: DIMENSION,
    ...overrides,
  };
}

function query(
  overrides: Partial<Parameters<TotemPopTracker["windowFor"]>[0]> = {},
) {
  return {
    entityId: 42,
    observedAtMs: 1_000,
    serverProfileId: SERVER,
    dimension: DIMENSION,
    ...overrides,
  };
}

describe("TotemPopTracker", () => {
  it("tracks the punish window and then exposes the regen-only phase", () => {
    const tracker = new TotemPopTracker();
    tracker.record(record());

    expect(tracker.windowFor(query())).toMatchObject({
      popped: true,
      popObservedAtMs: 1_000,
      elapsedMs: 0,
      absorptionRemainingMs: TOTEM_POP_ABSORPTION_WINDOW_MS,
      phase: "PUNISH",
      reason: null,
    });
    expect(
      tracker.windowFor(query({ observedAtMs: 1_000 + TOTEM_POP_ABSORPTION_WINDOW_MS })),
    ).toMatchObject({
      popped: true,
      popObservedAtMs: 1_000,
      elapsedMs: TOTEM_POP_ABSORPTION_WINDOW_MS,
      absorptionRemainingMs: 0,
      phase: "REGEN",
      reason: null,
    });
  });

  it("expires the record at the end of the regeneration context", () => {
    const tracker = new TotemPopTracker();
    tracker.record(record());

    expect(
      tracker.windowFor(query({ observedAtMs: 1_000 + TOTEM_POP_REGEN_WINDOW_MS })),
    ).toMatchObject({
      popped: false,
      popObservedAtMs: 1_000,
      elapsedMs: TOTEM_POP_REGEN_WINDOW_MS,
      absorptionRemainingMs: 0,
      phase: "EXPIRED",
      reason: "WINDOW_EXPIRED",
    });
  });

  it("distinguishes no record from a record in another server or dimension", () => {
    const tracker = new TotemPopTracker();

    expect(tracker.windowFor(query({ observedAtMs: 900 }))).toMatchObject({
      popped: false,
      popObservedAtMs: null,
      elapsedMs: null,
      phase: "EXPIRED",
      reason: "NO_RECORD",
    });

    tracker.record(record());
    expect(
      tracker.windowFor(query({ serverProfileId: "another-server", observedAtMs: 1_001 })),
    ).toMatchObject({
      popped: false,
      popObservedAtMs: null,
      elapsedMs: null,
      reason: "PROFILE_MISMATCH",
    });
    expect(
      tracker.windowFor(query({ dimension: "minecraft:the_nether", observedAtMs: 1_002 })),
    ).toMatchObject({
      popped: false,
      elapsedMs: null,
      reason: "PROFILE_MISMATCH",
    });
  });

  it("rejects time reversal and clears both records and the clock on reset", () => {
    const tracker = new TotemPopTracker();
    tracker.record(record({ observedAtMs: 2_000 }));

    expect(() => tracker.record(record({ observedAtMs: 1_999 }))).toThrowError(
      RangeError,
    );
    expect(() => tracker.windowFor(query({ observedAtMs: 1_998 }))).toThrowError(
      RangeError,
    );

    tracker.reset();
    expect(tracker.windowFor(query({ observedAtMs: 0 }))).toMatchObject({
      popped: false,
      popObservedAtMs: null,
      reason: "NO_RECORD",
    });
  });

  it("rejects invalid event scope instead of creating an active record", () => {
    const tracker = new TotemPopTracker();
    expect(() => tracker.record(record({ entityId: -1 }))).toThrowError(TypeError);
    expect(() => tracker.record(record({ observedAtMs: Number.NaN }))).toThrowError(
      TypeError,
    );
    expect(() => tracker.record(record({ serverProfileId: " " }))).toThrowError(
      TypeError,
    );
    expect(() => tracker.record(record({ dimension: " " }))).toThrowError(TypeError);
  });
});
