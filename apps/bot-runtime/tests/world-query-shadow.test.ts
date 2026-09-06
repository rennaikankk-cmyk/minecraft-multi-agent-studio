import { describe, it, expect, vi } from "vitest";
import { WorldQueryShadow } from "../src/world-query-shadow.js";
import type { WorldQueryView } from "../src/world-query-provider.js";
import type { WorldSyncQueryContext } from "../src/world-sync-adapter.js";

function fixture(mode = "LOCAL_TEST") {
  const context: WorldSyncQueryContext = { scope: { serverProfileId: "test", botSessionId: "session", dimension: "minecraft:overworld",
    minecraftVersion: "1.21.11", selectorRevision: 1 }, sessionEpoch: 1, dimensionEpoch: 1, state: "ready", settled: true,
    sourceRevision: 3, changedAtMs: 100 };
  const points = [{ x: -2, y: -40, z: 0, distanceSquared: 1, selectors: 1 },
    { x: 0, y: -40, z: 0, distanceSquared: 1, selectors: 1 }];
  const view: WorldQueryView = { bounds: { origin: { x: -1, y: -40, z: 0, serverProfileId: "test", dimension: "minecraft:overworld" },
    radius: 16, count: 1, selectors: 1, matching: "each" }, status: "FRESH", source: "rust-spatial-index", reason: null,
    complete: true, capturedAtMs: 100, staleAgeMs: 0, dirtySinceMs: null, sourceRevision: 3, generation: 1,
    result: { scope: context.scope, sessionEpoch: 1, dimensionEpoch: 1, queryId: "test", status: "complete", generation: 1,
      points: [points[0]!], consultedChunks: [], elapsedMs: 1, visitedEntries: 2, snapshotBuildMs: 0, snapshotChunkEntries: 1 } };
  const oracle = vi.fn(async () => [...points].reverse());
  const observer = new WorldQueryShadow({ mode, enabled: true, context: () => context, now: () => 100, oracle });
  return { observer, oracle, view, context, points };
}

describe("D4 stable-window shadow evidence", () => {
  it.each(["NORMAL", "", "local_test"])("never calls the legacy oracle in %s", async (mode) => {
    const f = fixture(mode); await f.observer.observe(f.view); expect(f.oracle).not.toHaveBeenCalled();
  });
  it("normalizes nearest ties before count, including negative heights", async () => {
    const f = fixture(); await f.observer.observe(f.view);
    expect(f.observer.diagnostics().counts.match).toBe(1);
    expect(f.observer.replayEvidence()[0]).toMatchObject({ query: f.view.bounds, indexed: [f.points[0]], oracle: [f.points[0]] });
  });
  it("records a stable discrepancy as mismatch without changing the consumer view", async () => {
    const f = fixture(); f.oracle.mockResolvedValue([f.points[1]!]); await f.observer.observe(f.view);
    expect(f.observer.diagnostics().counts.mismatch).toBe(1);
    expect(f.view.result!.points).toEqual([f.points[0]]);
  });
  it("attributes mutation and scope reset during a query separately", async () => {
    const f = fixture(); f.oracle.mockImplementation(async () => { f.context.sessionEpoch++; return []; });
    await f.observer.observe(f.view); expect(f.observer.diagnostics().counts.worldChanged).toBe(1);
  });
  it("does not claim parity or absence for unloaded/incomplete coverage", async () => {
    const f = fixture(); await f.observer.observe({ ...f.view, complete: false, status: "INCOMPLETE" });
    expect(f.observer.diagnostics().counts.incomplete).toBe(1);
  });
  it("labels a truncated oracle instead of blaming the index", async () => {
    const f = fixture(); f.oracle.mockResolvedValue(Array.from({ length: 257 }, () => f.points[1]!));
    await f.observer.observe(f.view); expect(f.observer.diagnostics().counts.oracleLimited).toBe(1);
  });
});
