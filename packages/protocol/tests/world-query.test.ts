import { describe, it, expect } from "vitest";
import { botWorldQueryV1Schema } from "../src/bot-messages.js";

const fresh = { status: "FRESH", source: "rust-spatial-index", generation: 1, sourceRevision: 2,
  capturedAtMs: 100, staleAgeMs: 0, dirtySinceMs: null, complete: true, reason: null };
describe("D4 observation telemetry", () => {
  it("retains an identified complete observation", () => { expect(botWorldQueryV1Schema.parse(fresh)).toEqual(fresh); });
  it.each([{ status: "INCOMPLETE" }, { sourceRevision: null }, { capturedAtMs: null }, { staleAgeMs: null },
    { staleAgeMs: -1 }, { dirtySinceMs: 120 }, { reason: "pendingUpdates" }, { complete: false }])("rejects contradictory freshness %j", (patch) => {
    expect(botWorldQueryV1Schema.safeParse({ ...fresh, ...patch }).success).toBe(false);
  });
  it("allows explicit unavailable observations without invented empty-world identity", () => {
    expect(botWorldQueryV1Schema.safeParse({ ...fresh, status: "UNAVAILABLE", complete: false,
      generation: null, sourceRevision: null, capturedAtMs: null, staleAgeMs: null, reason: "notReady" }).success).toBe(true);
  });
});
