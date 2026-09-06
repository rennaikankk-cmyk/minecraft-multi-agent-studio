import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpatialQuery, SpatialResult } from "@minecraft-studio/pathfinder-rs";
import { WorldQueryProvider, type WorldQueryRequest } from "../src/world-query-provider.js";
import type { WorldSyncQueryContext } from "../src/world-sync-adapter.js";

const request: WorldQueryRequest = { origin: { x: -0.5, y: -40.2, z: 8.5, serverProfileId: "isolated", dimension: "minecraft:overworld" },
  radius: 32, count: 8, selectors: (1 << 24) - 1, matching: "each" };
function fixture(options: ConstructorParameters<typeof WorldQueryProvider>[1] = {}) {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const context: WorldSyncQueryContext = { scope: { serverProfileId: "isolated", dimension: "minecraft:overworld", botSessionId: "session-1",
    minecraftVersion: "1.21.11", selectorRevision: 1 }, sessionEpoch: 1, dimensionEpoch: 1, state: "ready", settled: true,
    sourceRevision: 1, changedAtMs: 900 };
  let current = context;
  const pending: { input: Omit<SpatialQuery, "scope" | "sessionEpoch" | "dimensionEpoch">; signal: AbortSignal;
    resolve: (value: SpatialResult) => void; reject: (error: Error) => void }[] = [];
  const query = vi.fn((input: Omit<SpatialQuery, "scope" | "sessionEpoch" | "dimensionEpoch">, signal: AbortSignal) =>
    new Promise<SpatialResult>((resolve, reject) => pending.push({ input, signal, resolve, reject })));
  const onFailure = vi.fn();
  const provider = new WorldQueryProvider({ context: () => current, now: Date.now, query, onFailure }, options);
  const complete = (index = pending.length - 1, status: SpatialResult["status"] = "complete") => pending[index]!.resolve({
    queryId: pending[index]!.input.queryId, sessionEpoch: current.sessionEpoch, dimensionEpoch: current.dimensionEpoch,
    scope: current.scope, generation: 7, status, points: [{ x: -1, y: -41, z: 8, selectors: 1, distanceSquared: 0 }],
    consultedChunks: [{ x: -1, z: 0, revision: 4, importing: false }], visitedEntries: 1, elapsedMs: 0.1,
    snapshotBuildMs: 0.01, snapshotChunkEntries: 1 });
  return { provider, query, pending, complete, onFailure, setContext: (patch: Partial<WorldSyncQueryContext>) => { current = { ...current, ...patch }; } };
}
afterEach(() => vi.useRealTimers());

describe("D4 shared asynchronous world queries", () => {
  it("shares the actual Promise and publishes a bounded latest-completed snapshot", async () => {
    const f = fixture();
    const a = f.provider.query(request), b = f.provider.query(request);
    expect(a).toBe(b);
    expect(f.provider.read(request).status).toBe("UNAVAILABLE");
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.pending[0]!.input).toMatchObject({ x: -1, y: -41, z: 8, matching: "each", count: 8 });
    f.complete();
    const view = await a;
    expect(view).toMatchObject({ status: "FRESH", generation: 7, capturedAtMs: 1_000, complete: true });
    expect(f.provider.read(request).result).toBe(view.result);
    expect(Object.isFrozen(view.result!.points)).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not launch a query against queued source updates or falsely refresh old timestamps", async () => {
    const f = fixture();
    const first = f.provider.query(request); f.complete(); await first;
    vi.setSystemTime(1_200);
    f.setContext({ settled: false, sourceRevision: 2, changedAtMs: 1_100 });
    expect(f.provider.read(request)).toMatchObject({ status: "STALE_ALLOWED", complete: false, capturedAtMs: 1_000, staleAgeMs: 200 });
    expect(await f.provider.query(request)).toMatchObject({ reason: "pendingUpdates", result: null });
    expect(f.query).toHaveBeenCalledTimes(1);
    f.setContext({ settled: true });
    const fresh = f.provider.query(request); f.complete();
    expect(await fresh).toMatchObject({ status: "FRESH", sourceRevision: 2 });
  });
  it("coalesces incomplete coverage without treating unloaded space as air", async () => {
    const f = fixture();
    const first = f.provider.query(request); f.complete(0, "incomplete");
    expect(await first).toMatchObject({ status: "INCOMPLETE", complete: false });
    for (let i = 0; i < 50; i++) expect(f.provider.read(request).complete).toBe(false);
    expect(f.query).toHaveBeenCalledTimes(1);
    vi.setSystemTime(4_100);
    expect(f.provider.read(request).result).toBe(null);
    f.provider.reset(true);
  });
  it("detaches one cancelled caller while allowing the other subscriber to finish", async () => {
    const f = fixture(); const controller = new AbortController();
    const cancelled = f.provider.query(request, controller.signal), survivor = f.provider.query(request);
    controller.abort();
    expect(await cancelled).toMatchObject({ reason: "cancelled", complete: false });
    expect(f.pending[0]!.signal.aborted).toBe(false);
    f.complete(); expect((await survivor).complete).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("rejects old-session and changed-world results, including a reset while in flight", async () => {
    const f = fixture(); const first = f.provider.query(request);
    f.setContext({ sourceRevision: 2 }); f.complete();
    expect(await first).toMatchObject({ reason: "scopeChanged", result: null });
    const second = f.provider.query(request);
    f.provider.reset();
    expect(await second).toMatchObject({ reason: "scopeChanged" });
    f.setContext({ sessionEpoch: 2 }); f.complete();
    await Promise.resolve(); await Promise.resolve();
    expect(f.provider.getMetrics().cacheEntries).toBe(0);
  });
  it("bounds admission, serializes distinct requests and applies timeout backoff", async () => {
    const f = fixture({ maxQueue: 1, timeoutMs: 100 });
    const a = f.provider.query(request);
    const b = f.provider.query({ ...request, radius: 16 });
    expect(await f.provider.query({ ...request, radius: 8 })).toMatchObject({ reason: "queueFull" });
    expect(f.query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await a).toMatchObject({ reason: "timeout" });
    f.complete(); await b;
    expect(f.provider.getMetrics().queueMax).toBe(1);
    f.provider.reset(true);
  });
  it("never caches budget/worker failures or serves a desynced cache", async () => {
    const f = fixture();
    const first = f.provider.query(request); f.complete(0, "budgetExceeded");
    expect(await first).toMatchObject({ reason: "budgetExceeded", result: null });
    expect((await f.provider.query(request)).complete).toBe(false);
    expect(f.query).toHaveBeenCalledTimes(1);
    vi.setSystemTime(2_001);
    const next = f.provider.query(request); f.complete(); await next;
    f.setContext({ state: "desynced" });
    expect(f.provider.read(request)).toMatchObject({ status: "DESYNCED", result: null });
    f.provider.reset(true);
  });
});
