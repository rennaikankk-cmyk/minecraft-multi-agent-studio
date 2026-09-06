import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cpus, platform, arch } from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { WorldSyncAdapter, buildRegistryTable } from "../apps/bot-runtime/dist/world-sync-adapter.js";
import { semanticSelectorMask } from "../apps/bot-runtime/dist/world-semantic-registry.js";
import { mirrorTransport, terminatePathfinderWorker } from "../apps/bot-runtime/dist/rust-pathfinder.js";

const require = createRequire(new URL("../apps/bot-runtime/package.json", import.meta.url));
const data = require("minecraft-data")("1.21.11");
const mineflayerRequire = createRequire(require.resolve("mineflayer"));
const Column = mineflayerRequire("prismarine-chunk")(data, 774);
const Vec3 = require("vec3");
const column = new Column();
for (let sy = -4; sy < 20; sy++) {
  column.setBlockStateId(new Vec3(4, sy * 16 + 6, 6), data.blocksByName.chest.defaultState);
  column.setBlockStateId(new Vec3(6, sy * 16 + 6, 6), data.blocksByName.wheat.maxStateId);
}
const out = resolve(process.argv[2] ?? `runtime-data/p5-d3/${new Date().toISOString().replaceAll(":", "-")}/benchmark.json`);
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), arch: arch(), node: process.version },
  evidence: "MEASURED", workload: "isolated synthetic placement in real prismarine ChunkColumn 1.21.11; no Minecraft connection or model calls",
  preset: { chunks: [1, 81, 289], dataSectionsPerChunk: 24, queriesPerSize: 300, normalBatchUpdatesPerSize: 12, maxVisibilityMs: 750, eventLoopP99TargetMs: 25 },
  unavailable: ["physicsTick.stateChanged", "production snapshot provider", "Minecraft live oracle", "multi-Bot closed loop"], rows: [],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stats(values) { const s = [...values].sort((a, b) => a - b); const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? null; return { samples: s.length, p50: at(.5), p95: at(.95), p99: at(.99), max: s.at(-1) ?? null }; }
async function settle(adapter, expected) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const m = adapter.getMetrics(); const h = await adapter.health();
    if (h?.desynced || ["degraded", "desynced"].includes(adapter.currentState)) throw new Error("mirror desynced during benchmark");
    if (h?.loadedChunks === expected && h.pendingImports === 0 && m.queuedExtractions === 0 && m.queueDepth === 0 && m.inFlightMessages === 0) return;
    await sleep(5);
  }
  throw new Error("import deadline exceeded");
}

try {
  for (const count of report.preset.chunks) {
    const spans = new Map();
    const transport = mirrorTransport();
    let handle;
    const create = transport.mirrorCreate;
    transport.mirrorCreate = async (...args) => { handle = await create(...args); return handle; };
    const table = buildRegistryTable(data.blocksArray, { revision: 1, minecraftVersion: "1.21.11", serverProfileId: "d3-benchmark-fixture", semanticScope: { botSessionId: `fixture-${count}`, dimension: "minecraft:overworld" } });
    const adapter = new WorldSyncAdapter({ transport, registryTable: table, sessionEpoch: Date.now(), dimensionEpoch: 1, clock: () => performance.now(),
      span: (name, ms, fields) => { const values = spans.get(name) ?? []; values.push(ms); spans.set(name, values);
        if (fields?.maxSliceMs !== undefined) { const slices = spans.get("extract.maxSliceMs") ?? []; slices.push(fields.maxSliceMs); spans.set("extract.maxSliceMs", slices); } } });
    let histogram;
    try {
      await adapter.start(); spans.clear();
      histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable(); await sleep(25);
      const rssBefore = process.memoryUsage().rss;
      const importBegan = performance.now();
      const side = Math.sqrt(count);
      for (let i = 0; i < count; i++) adapter.onChunkColumnLoad(column, i % side, Math.floor(i / side));
      await settle(adapter, count);
      const importMs = performance.now() - importBegan;
      const importLoop = { samples: histogram.count, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
      histogram.reset();
      const rssAfter = process.memoryUsage().rss;
      const query = { queryId: "fixture-query", x: 8, y: 6, z: 8, radius: 7, count: 8,
        selectors: semanticSelectorMask("chest") | semanticSelectorMask("wheat"), matching: "union", maxVisits: 131072, maxMs: 10 };
      const roundTrip = [], snapshot = [], native = [];
      for (let i = 0; i < report.preset.queriesPerSize; i++) {
        const began = performance.now(); const r = await adapter.querySpatial({ ...query, queryId: `fixture-${i}` });
        roundTrip.push(performance.now() - began); snapshot.push(r.snapshotBuildMs); native.push(r.elapsedMs);
        assert.equal(r.status, "complete"); assert.equal(r.points.length, 2); assert.equal(r.snapshotChunkEntries, count);
      }
      const visibility = [];
      for (let i = 0; i < report.preset.normalBatchUpdatesPerSize; i++) {
        const stateId = i % 2 === 0 ? data.blocksByName.wheat.maxStateId : data.blocksByName.chest.defaultState;
        const expected = semanticSelectorMask(i % 2 === 0 ? "wheat" : "chest");
        const began = performance.now(); adapter.onBlockUpdate(4, 6, 6, stateId);
        while (true) {
          const r = await adapter.querySpatial({ ...query, queryId: `visibility-${i}` });
          if (r.points.some((p) => p.x === 4 && p.y === 6 && p.z === 6 && p.selectors === expected)) break;
          assert.ok(performance.now() - began < report.preset.maxVisibilityMs, "normal-batch update visibility deadline");
          await sleep(10);
        }
        visibility.push(performance.now() - began);
      }
      // Same loader as transport, to inspect this worker's current mirror.
      const nativeAdapter = require("@minecraft-studio/pathfinder-rs");
      const memory = await nativeAdapter.mirrorSpatialMemory(handle);
      for (let i = 0; i < count; i++) adapter.onChunkColumnUnload(i % side, Math.floor(i / side));
      await settle(adapter, 0);
      const afterUnload = await nativeAdapter.mirrorSpatialMemory(handle);
      assert.equal(afterUnload.indexEntries, 0); assert.equal(afterUnload.chunksLoaded, 0);
      histogram.disable();
      const loop = { p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
      const row = { chunks: count, importMs, importEventLoopDelayMs: importLoop, queryRoundTripMs: stats(roundTrip), nativeQueryMs: stats(native), workerSnapshotBuildMs: stats(snapshot), normalBatchVisibilityMs: stats(visibility), eventLoopDelayMs: loop,
        mirrorMemory: { ...memory, approxBytesEvidence: "ESTIMATED" }, processRssDeltaBytes: rssAfter - rssBefore, afterUnload,
        spansMs: Object.fromEntries([...spans].map(([name, values]) => [name, stats(values)])), metrics: adapter.getMetrics(), health: await adapter.health() };
      report.rows.push(row); console.log(JSON.stringify(row));
      assert.equal(row.metrics.droppedUpdates, 0); assert.equal(row.health.skippedUpdatesTotal, 0);
      assert.ok(loop.p99 <= report.preset.eventLoopP99TargetMs, "event-loop P99 target");
    } finally { histogram?.disable(); await adapter.stop(); }
  }
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error); process.exitCode = 1; }
finally { await terminatePathfinderWorker(); await mkdir(dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(report, null, 2) + "\n"); console.log(`D3 report: ${out}`); }
