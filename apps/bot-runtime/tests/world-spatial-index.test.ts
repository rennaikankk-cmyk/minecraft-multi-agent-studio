import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldSyncAdapter, buildRegistryTable, buildSectionPayload } from "../src/world-sync-adapter.js";
import { semanticSelectorMask, buildSemanticSelectors, SEMANTIC_UNKNOWN, MOVEMENT_METADATA } from "../src/world-semantic-registry.js";
import { mirrorTransport, terminatePathfinderWorker } from "../src/rust-pathfinder.js";
import { ChunkExtractionSession, extractColumnBudgeted, replayUpdates } from "../src/world-section-extractor.js";
import type { SpatialQuery } from "@minecraft-studio/pathfinder-rs";

const require = createRequire(import.meta.url);
const md = require("minecraft-data");
const pc = require("prismarine-chunk");
const Vec3 = require("vec3");
const scope = { botSessionId: "spatial-test-session", dimension: "minecraft:overworld" };
const options = { revision: 1, minecraftVersion: "1.21.11", serverProfileId: "spatial-test", semanticScope: scope };
const input = { queryId: "q1", x: -13, y: -60, z: 5, radius: 0, count: 8, selectors: semanticSelectorMask("chest"), matching: "union" as const, maxVisits: 131072, maxMs: 10 };
const adapters: WorldSyncAdapter[] = [];

async function settled(adapter: WorldSyncAdapter, chunks: number): Promise<void> {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const h = await adapter.health();
    const m = adapter.getMetrics();
    if (h?.loadedChunks === chunks && h.pendingImports === 0 && m.queuedExtractions === 0 && m.queueDepth === 0 && m.inFlightMessages === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("spatial import did not settle");
}

afterEach(async () => { for (const a of adapters.splice(0)) await a.stop(); await terminatePathfinderWorker(); vi.restoreAllMocks(); });

describe("D3 real registry and Worker spatial contract", () => {
  it.each(["1.20.4", "1.21.11"])("classifies all real states and explicit families for %s", (version) => {
    const data = md(version);
    const table = buildRegistryTable(data.blocksArray, { ...options, minecraftVersion: version });
    const selectors = table.semantic!.selectors;
    for (const name of ["wheat", "chest", "water", "oak_log", "diamond_ore"]) {
      const b = data.blocksByName[name];
      for (let id = b.minStateId; id <= b.maxStateId; id++) expect(selectors[id]).toBe(semanticSelectorMask(name));
    }
    expect(selectors[data.blocksByName.red_bed.defaultState]).toBe(semanticSelectorMask("bed"));
    expect(selectors[data.blocksByName.blue_shulker_box.defaultState]).toBe(semanticSelectorMask("shulker_box"));
    expect(selectors[data.blocksByName.deepslate_diamond_ore.defaultState]).toBe(0);
    expect(table.masks[data.blocksByName.water.defaultState]! & MOVEMENT_METADATA.WATER).not.toBe(0);
    expect(table.masks[data.blocksByName.chest.defaultState]! & MOVEMENT_METADATA.CONTAINER).not.toBe(0);
  });

  it("marks registry holes unknown and rejects unsupported ranges", () => {
    const selectors = buildSemanticSelectors([{ name: "wheat", minStateId: 70_000, maxStateId: 70_007 }]);
    expect(selectors[0]).toBe(SEMANTIC_UNKNOWN);
    expect(selectors[70_007]).toBe(semanticSelectorMask("wheat"));
    expect(() => buildSemanticSelectors([{ name: "air", minStateId: -1, maxStateId: 1 }])).toThrow("range");
    expect(() => buildSemanticSelectors([{ name: "air", minStateId: 0, maxStateId: 2 ** 32 - 1 }])).toThrow("range");
    expect(() => semanticSelectorMask("unregistered")).toThrow();
  });

  it("imports real ChunkColumn data, updates membership, fences epochs and unloads", async () => {
    const data = md("1.21.11");
    const table = buildRegistryTable(data.blocksArray, options);
    const adapter = new WorldSyncAdapter({ transport: mirrorTransport(), registryTable: table, sessionEpoch: 101, dimensionEpoch: 1 });
    adapters.push(adapter); await adapter.start();
    const Column = pc(data, 774); const column = new Column();
    column.setBlockStateId(new Vec3(3, -60, 5), data.blocksByName.chest.defaultState);
    adapter.onChunkColumnLoad(column, -1, 0); await settled(adapter, 1);
    const found = await adapter.querySpatial(input);
    expect(found.status).toBe("complete");
    expect(found.points).toEqual([{ x: -13, y: -60, z: 5, distanceSquared: 0, selectors: input.selectors }]);
    adapter.onBlockUpdate(-13, -60, 5, data.blocksByName.wheat.maxStateId);
    await adapter.flushUpdates(); await settled(adapter, 1);
    expect((await adapter.querySpatial(input)).points).toEqual([]);
    const wheat = await adapter.querySpatial({ ...input, selectors: semanticSelectorMask("wheat") });
    expect(wheat.points).toHaveLength(1);
    expect(wheat.generation).toBeGreaterThan(found.generation);
    expect(wheat.consultedChunks[0]!.revision).toBeGreaterThan(found.consultedChunks[0]!.revision!);
    adapter.onChunkColumnUnload(-1, 0); await settled(adapter, 0);
    adapter.onBlockUpdate(-13, -60, 5, data.blocksByName.chest.defaultState);
    await adapter.flushUpdates(); await settled(adapter, 0);
    const unloaded = await adapter.querySpatial(input);
    expect(unloaded.status).toBe("incomplete"); expect(unloaded.points).toEqual([]);
    expect(adapter.getMetrics().droppedUpdates).toBe(0);
    expect((await adapter.health())!.skippedUpdatesTotal).toBe(1);
  });

  it("keeps UTF-8 scope fingerprints equal and transfers raw state ownership", async () => {
    const transport = mirrorTransport();
    const table = buildRegistryTable(md("1.21.11").blocksArray, { ...options, serverProfileId: "test-\u6d4b\u8bd5" });
    const adapter = new WorldSyncAdapter({ transport, registryTable: table, sessionEpoch: 101, dimensionEpoch: 1 });
    adapters.push(adapter); await adapter.start();
    const handle = await transport.mirrorCreate({ sessionEpoch: 1, dimensionEpoch: 1 });
    try {
      await transport.mirrorSubmitEnvelope(handle, { protocolVersion: 1, sessionEpoch: 1, dimensionEpoch: 1, transportSequence: 1,
        message: { kind: "registryTable", revision: 1, masks: new Uint8Array(table.masks.buffer), minecraftVersion: table.minecraftVersion!, serverProfileId: table.serverProfileId! } });
      await transport.mirrorSubmitEnvelope(handle, { protocolVersion: 1, sessionEpoch: 1, dimensionEpoch: 1, transportSequence: 2,
        message: { kind: "semanticRegistryV1", ...table.semantic!.scope, selectors: new Uint8Array(table.semantic!.selectors.buffer) } });
      await transport.mirrorSubmitEnvelope(handle, { protocolVersion: 1, sessionEpoch: 1, dimensionEpoch: 1, transportSequence: 3, message: { kind: "chunkBegin", chunkX: 0, chunkZ: 0 } });
      const stateIds = new Uint32Array(4096).fill(md("1.21.11").blocksByName.chest.defaultState);
      const payload = buildSectionPayload({ sectionY: 0, status: "data", stateIds }, table, 0, 0);
      expect(payload.payloadKind).toBe("stateDataV1");
      expect((await transport.mirrorSubmitEnvelope(handle, { protocolVersion: 1, sessionEpoch: 1, dimensionEpoch: 1, transportSequence: 4, message: payload }, [stateIds.buffer])).status).toBe("applied");
      expect(stateIds.byteLength).toBe(0);
      const q: SpatialQuery = { ...input, sessionEpoch: 1, dimensionEpoch: 1, scope: table.semantic!.scope };
      const wrong = await transport.mirrorSpatialQuery(handle, { ...q, scope: { ...q.scope, botSessionId: "another" } });
      expect(wrong.status).toBe("scopeMismatch"); expect(wrong.points).toEqual([]);
      await expect(transport.mirrorSpatialQuery(handle, { ...q, x: 1.5 })).rejects.toThrow("numeric");
      await transport.mirrorSubmitControl(handle, { kind: "worldReset", newSessionEpoch: 2, newDimensionEpoch: 2, reason: "dimensionChange" });
      expect((await transport.mirrorSpatialQuery(handle, q)).status).toBe("scopeMismatch");
    } finally { await transport.mirrorDispose(handle); }
  });

  it("rejects a result whose adapter stopped while the worker query was in flight", async () => {
    const transport = mirrorTransport();
    const nativeQuery = transport.mirrorSpatialQuery;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    transport.mirrorSpatialQuery = async (handle, q) => { const result = await nativeQuery(handle, q); await held; return result; };
    const adapter = new WorldSyncAdapter({ transport, registryTable: buildRegistryTable(md("1.21.11").blocksArray, options), sessionEpoch: 1, dimensionEpoch: 1 });
    adapters.push(adapter); await adapter.start();
    const pending = adapter.querySpatial(input);
    const rejected = expect(pending).rejects.toThrow("stale");
    await expect(adapter.querySpatial(input)).rejects.toThrow("in flight");
    await adapter.stop(); release(); await rejected;
  });

  it.each(["abort", "timeout"])("bounds caller waiting on %s without admitting more native work", async (mode) => {
    const transport = mirrorTransport(); const native = transport.mirrorSpatialQuery;
    let release!: () => void; let finished!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const done = new Promise<void>((resolve) => { finished = resolve; });
    transport.mirrorSpatialQuery = async (handle, q) => { try { const r = await native(handle, q); await held; return r; } finally { finished(); } };
    const adapter = new WorldSyncAdapter({ transport, registryTable: buildRegistryTable(md("1.21.11").blocksArray, options), sessionEpoch: 1, dimensionEpoch: 1 });
    adapters.push(adapter); await adapter.start();
    const controller = new AbortController();
    const pending = adapter.querySpatial(input, { signal: controller.signal, timeoutMs: mode === "timeout" ? 5 : 1000 });
    const rejected = expect(pending).rejects.toThrow(mode === "abort" ? "cancelled" : "timeout");
    if (mode === "abort") controller.abort();
    await rejected;
    await expect(adapter.querySpatial(input)).rejects.toThrow("in flight");
    release(); await done;
  });
});

describe("D3 extraction prerequisites", () => {
  it("accumulates sub-budget batches until the actual yield", async () => {
    let tick = 0;
    vi.spyOn(performance, "now").mockImplementation(() => tick);
    let yields = 0;
    const session = new ChunkExtractionSession();
    const column = { minY: 0, numSections: 1, sections: [{ data: { get: () => { tick += 0.002; return 1; } } }] };
    const result = await extractColumnBudgeted(column, 0, 0, session, 3, async () => { yields++; });
    expect(yields).toBe(2);
    expect(result.maxSliceMs).toBeLessThan(3.6);
  });

  it("replays an update into explicit empty storage without inventing missing sections", () => {
    const extracted = { chunkX: 0, chunkZ: 0, sections: [{ sectionY: 0, status: "empty" as const, stateIds: null }],
      pendingUpdates: [{ x: 1, y: 1, z: 1, stateId: 3, sequence: 1 }, { x: 1, y: 17, z: 1, stateId: 3, sequence: 2 }], extractMs: 0, sliceOverruns: 0, maxSliceMs: 0 };
    expect(replayUpdates(extracted, 0)).toEqual({ applied: 1, skippedNoSection: 1 });
    expect(extracted.sections[0]!.status).toBe("data");
  });
});
