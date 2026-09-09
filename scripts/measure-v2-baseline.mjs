import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createGeometryWorker, geometryFixture, geometryRequest } from "./lib/v2-geometry-worker.mjs";
import { WorldSyncAdapter, buildRegistryTable } from "../apps/bot-runtime/dist/world-sync-adapter.js";
import { semanticSelectorMask } from "../apps/bot-runtime/dist/world-semantic-registry.js";

// Real built N-API calls through its existing public Worker transport. Never connects to Minecraft.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/bot-runtime/package.json", import.meta.url));
const native = require("@minecraft-studio/pathfinder-rs");
const md = require("minecraft-data");
const minecraftVersion = process.env.V2_MINECRAFT_VERSION ?? "1.21.11";
const data = md(minecraftVersion);
assert.ok(data, "configured Minecraft version must be present in installed minecraft-data");
const mineflayerRequire = createRequire(require.resolve("mineflayer"));
const Column = mineflayerRequire("prismarine-chunk")(data, data.version.version);
const Vec3 = require("vec3");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rounds = integerEnv("V2_MEASURE_ROUNDS", 100, 10, 1000);
const side = integerEnv("V2_MEASURE_SIDE", 48, 16, 96);
const output = resolve(process.argv[2] ?? "work/v2-native-baseline.json");
const adapters = new Set();
let geometry;

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max || (name === "V2_MEASURE_SIDE" && value % 2 !== 0)) throw new Error(`INVALID_${name}`);
  return value;
}
function command(file, args) { try { return execFileSync(file, args, { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true }).trim(); } catch { return "UNAVAILABLE"; } }
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}
function eventLoopStats(histogram) {
  return { samples: Number(histogram.count), p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6, p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 };
}
function push(samples, name, value) { (samples[name] ??= []).push(value); }
function measuredLoop() {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const jitter = [];
  let last = performance.now(), peakRssBytes = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = performance.now(); jitter.push(Math.max(0, now - last - 5)); last = now;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 5);
  return { stop() { clearInterval(timer); histogram.disable(); return { eventLoopDelayMs: eventLoopStats(histogram), syntheticFiveMsTimerDriftMs: stats(jitter), sampledPeakRssBytes: peakRssBytes }; } };
}
async function settle(adapter, chunks) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    const health = await adapter.health(), metrics = adapter.getMetrics();
    assert.ok(health && !health.desynced && !health.stopped, "mirror must remain healthy");
    if (health.loadedChunks === chunks && health.pendingImports === 0 && metrics.queuedExtractions === 0 && metrics.queueDepth === 0 && metrics.inFlightMessages === 0) return;
    await sleep(2);
  }
  throw new Error("MIRROR_SETTLE_DEADLINE");
}
const chunks = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, z: Math.floor(i / 3) }));
const chest = semanticSelectorMask("chest"), wheat = semanticSelectorMask("wheat");
function buildColumn() {
  const column = new Column();
  // Populate every vertical section so missing sections cannot silently become known air.
  for (let section = -4; section < 20; section++) {
    column.setBlockStateId(new Vec3(4, section * 16 + 6, 6), data.blocksByName.chest.defaultState);
    column.setBlockStateId(new Vec3(6, section * 16 + 6, 6), data.blocksByName.wheat.maxStateId);
  }
  return column;
}
const queryBase = { x: 24, y: 6, z: 24, radius: 20, count: 8, selectors: chest | wheat, matching: "union", maxVisits: 131072, maxMs: 10 };
function spatialOracle(query, changedChest = false) {
  const points = [];
  for (const chunk of chunks) for (let sy = -4; sy < 20; sy++) {
    for (const [localX, selector] of [[4, chest], [6, wheat]]) {
      const x = chunk.x * 16 + localX, y = sy * 16 + 6, z = chunk.z * 16 + 6;
      const selectors = changedChest && x === 20 && y === 6 && z === 22 ? wheat : selector;
      const distanceSquared = (x - query.x) ** 2 + (y - query.y) ** 2 + (z - query.z) ** 2;
      if ((selectors & query.selectors) && distanceSquared <= query.radius ** 2) points.push({ x, y, z, selectors, distanceSquared });
    }
  }
  return points.sort((a, b) => a.distanceSquared - b.distanceSquared || a.x - b.x || a.y - b.y || a.z - b.z || a.selectors - b.selectors).slice(0, query.count);
}
function pathFixture() {
  const sx = side, sy = 8, sz = side;
  const classes = Buffer.alloc(sx * sy * sz, native.CLASS.PASSABLE);
  classes.fill(native.CLASS.SOLID, 0, sx * sz);
  // Straight, flat, fully observed route gives an independently known optimum.
  return { world: { sx, sy, sz, classes }, start: { x: 2, y: 1, z: side / 2 }, goal: { x: side - 3, y: 1, z: side / 2 }, options: { maxNodes: 10000, timeoutMs: 25, allowDig: false } };
}

async function startAdapter(index, samples) {
  let handle;
  const transport = { ...native, mirrorCreate: async options => { handle = await native.mirrorCreate(options); return handle; } };
  const table = buildRegistryTable(data.blocksArray, { revision: 1, minecraftVersion, serverProfileId: "v2-synthetic", semanticScope: { botSessionId: `synthetic-${index}`, dimension: "minecraft:overworld" } });
  const adapter = new WorldSyncAdapter({ transport, registryTable: table, sessionEpoch: index + 1, dimensionEpoch: 1,
    clock: () => performance.now(), span: (name, ms, fields) => {
      push(samples, name, ms);
      if (fields?.maxSliceMs !== undefined) push(samples, "world_sync.extract_max_slice", fields.maxSliceMs);
    } });
  adapters.add(adapter); await adapter.start();
  return { adapter, get handle() { return handle; }, scope: table.semantic.scope };
}
async function runLoad(botCount) {
  const importSpans = {}, spans = {}, samples = {}, sessions = [];
  const rssBefore = process.memoryUsage().rss, cpuBefore = process.cpuUsage(), began = performance.now();
  const startupMonitor = measuredLoop();
  let startup;
  try {
    for (let i = 0; i < botCount; i++) sessions.push(await startAdapter(i, importSpans));
    const column = buildColumn();
    const started = performance.now();
    for (const { adapter } of sessions) for (const chunk of chunks) adapter.onChunkColumnLoad(column, chunk.x, chunk.z);
    await Promise.all(sessions.map(({ adapter }) => settle(adapter, chunks.length)));
    startup = { totalMs: performance.now() - began, importMs: performance.now() - started, ...startupMonitor.stop() };
  } catch (error) { startupMonitor.stop(); throw error; }
  const initialNativeMemory = await Promise.all(sessions.map(s => native.mirrorSpatialMemory(s.handle)));
  const path = pathFixture(), fixture = geometryFixture({ side, height: 16 });
  // Explicit warmup, excluded from steady-state percentile samples.
  for (let i = 0; i < 4; i++) {
    await native.findPathAsync(path);
    await sessions[0].adapter.querySpatial({ ...queryBase, queryId: `warm-${i}` });
    const warmed = await geometry.run(geometryRequest({ ...fixture, cells: fixture.cells.slice() }, { maxMs: 100 }));
    assert.equal(warmed.status, "complete"); assert.equal(warmed.regions.length, 8);
  }
  for (const key of Object.keys(importSpans)) { spans[key] = importSpans[key].length; }
  const monitor = measuredLoop();
  const steadyBegan = performance.now();
  let steady;
  try {
    for (let round = 0; round < rounds; round++) {
      await Promise.all(sessions.map(async ({ adapter }, bot) => {
        const changed = round % 2 === 0;
        const syncBegan = performance.now();
        adapter.onBlockUpdate(20, 6, 22, changed ? data.blocksByName.wheat.maxStateId : data.blocksByName.chest.defaultState);
        const flushed = adapter.flushUpdates();
        const pathBegan = performance.now();
        const pathPending = native.findPathAsync(path).then(result => {
          const endToEnd = performance.now() - pathBegan;
          assert.equal(result.success, true); assert.deepEqual(result.path.at(-1), path.goal);
          assert.equal(result.path.length, side - 4); // inclusive endpoints of the straight optimum
          push(samples, "pathEndToEndMs", endToEnd); push(samples, "pathNativeComputeMs", result.elapsedMs);
          push(samples, "pathTransportQueueAndDeliveryResidualMs", Math.max(0, endToEnd - result.elapsedMs));
        });
        const copyBegan = performance.now();
        const copied = fixture.cells.slice();
        push(samples, "geometryInputCopyMs", performance.now() - copyBegan);
        const geometryPending = geometry.run(geometryRequest({ ...fixture, cells: copied }, { requestId: `geometry-${bot}-${round}` })).then(result => {
          push(samples, "geometryEndToEndMs", result.timing.endToEndMs); push(samples, "geometryComputeMs", result.computeMs);
          push(samples, "geometryDeliveryAndQueueMs", result.timing.deliveryAndQueueMs); push(samples, "geometryResultDeliveryMs", result.timing.resultDeliveryMs);
          push(samples, "geometryPostMessageMs", result.timing.postMessageMs);
          push(samples, "geometryResultMergeMs", timed(() => {
            assert.equal(result.status, "complete"); assert.equal(result.regions.length, 8);
            assert.ok(result.regions.every(r => r.kind === "enclosed-candidate"));
          }));
        });
        await flushed;
        // FIFO transport ensures this query follows the update; compare actual native output with TS oracle.
        const queryBegan = performance.now();
        const result = await adapter.querySpatial({ ...queryBase, queryId: `q-${bot}-${round}` });
        const queryMs = performance.now() - queryBegan;
        const oracle = spatialOracle(queryBase, changed);
        push(samples, "queryResultMergeMs", timed(() => { assert.equal(result.status, "complete"); assert.deepEqual(result.points, oracle); }));
        push(samples, "queryEndToEndMs", queryMs); push(samples, "queryNativeComputeMs", result.elapsedMs);
        push(samples, "querySnapshotBuildMs", result.snapshotBuildMs);
        push(samples, "queryTransportQueueAndDeliveryResidualMs", Math.max(0, queryMs - result.elapsedMs - result.snapshotBuildMs));
        push(samples, "updateToQueryVisibilityMs", performance.now() - syncBegan);
        await Promise.all([pathPending, geometryPending]);
      }));
      await sleep(10); // Fixed synthetic offered load: one burst/round, not an unlimited saturation run.
    }
    await sleep(10);
    steady = { durationMs: performance.now() - steadyBegan, ...monitor.stop() };
  } catch (error) { monitor.stop(); throw error; }
  const health = await Promise.all(sessions.map(s => s.adapter.health()));
  const metrics = sessions.map(s => s.adapter.getMetrics());
  health.forEach(h => { assert.equal(h.desynced, false); assert.equal(h.skippedUpdatesTotal, 0); });
  metrics.forEach(m => { assert.equal(m.droppedUpdates, 0); assert.equal(m.queueDepth, 0); assert.equal(m.inFlightMessages, 0); });
  const afterUpdatesNativeMemory = await Promise.all(sessions.map(s => native.mirrorSpatialMemory(s.handle)));
  const syncSteadySpansMs = Object.fromEntries(Object.entries(importSpans).map(([k, v]) => [k, stats(v.slice(spans[k] ?? 0))]));
  for (const session of sessions) for (const chunk of chunks) session.adapter.onChunkColumnUnload(chunk.x, chunk.z);
  await Promise.all(sessions.map(s => settle(s.adapter, 0)));
  const unloadedMemory = await Promise.all(sessions.map(s => native.mirrorSpatialMemory(s.handle)));
  unloadedMemory.forEach(m => { assert.equal(m.chunksLoaded, 0); assert.equal(m.indexEntries, 0); });
  for (const { adapter } of sessions) { await adapter.stop(); adapters.delete(adapter); }
  assert.equal(native.mirrorAliveSessions(), 0);
  const cpu = process.cpuUsage(cpuBefore);
  const summaries = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)]));
  const row = {
    botCount, classification: "SYNTHETIC_LOGICAL_SESSIONS_ONE_PROCESS", rounds, chunksPerSession: 9,
    startup, steady, cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000, totalWallMs: performance.now() - began },
    memory: { processRssBeforeBytes: rssBefore, processRssAfterBytes: process.memoryUsage().rss,
      nativeMirrorPayloadEstimateBefore: initialNativeMemory, nativeMirrorPayloadEstimateAfterUpdates: afterUpdatesNativeMemory, nativeAfterUnload: unloadedMemory,
      nativeApproxBytesIsEstimate: true, retainedGeometryInputs: geometry.metrics(), externallyRetainedNativeSnapshots: "NOT_EXPOSED_BY_PUBLIC_API" },
    timingMs: summaries,
    syncImportAndHandshakeSpansMs: Object.fromEntries(Object.entries(importSpans).map(([k, v]) => [k, stats(v.slice(0, spans[k]))])),
    syncSteadySpansMs,
    metrics, health,
    budgetChecks: {
      steadyEventLoopP99Under25Ms: steady.eventLoopDelayMs.p99 <= 25,
      steadyEventLoopMaxUnder50Ms: steady.eventLoopDelayMs.max <= 50,
      geometryEndToEndP99Under50Ms: summaries.geometryEndToEndMs.p99 <= 50,
      syncAckP99Under50Ms: syncSteadySpansMs["world_sync.ack_rtt"].p99 <= 50,
    },
  };
  return row;
}
function timed(fn) { const start = performance.now(); fn(); return performance.now() - start; }

async function nativeBoundaryChecks() {
  const session = await startAdapter(20, {});
  const { adapter, scope, handle } = session;
  const query = { ...queryBase, queryId: "boundary", sessionEpoch: 21, dimensionEpoch: 1, scope };
  const unknown = await native.mirrorSpatialQuery(handle, query);
  assert.equal(unknown.status, "incomplete");
  const column = buildColumn(); for (const chunk of chunks) adapter.onChunkColumnLoad(column, chunk.x, chunk.z);
  await settle(adapter, 9);
  await assert.rejects(native.mirrorSpatialQuery(handle, { ...query, radius: 97 }), /invalid spatial query numeric field/);
  const bounded = await native.mirrorSpatialQuery(handle, { ...query, maxVisits: 1 });
  assert.equal(bounded.status, "budgetExceeded");
  const pending = Array.from({ length: 80 }, (_, i) => native.mirrorSpatialQuery(handle, { ...query, queryId: `queue-${i}` }));
  const probeBegan = performance.now();
  const controlProbe = native.mirrorSubmitControl(handle, { kind: "healthProbe" }).then(() => performance.now() - probeBegan);
  const saturated = await Promise.allSettled(pending);
  const controlProbeBehindSaturatedQueueMs = await controlProbe;
  const rejected = saturated.filter(r => r.status === "rejected");
  assert.equal(rejected.length, 16);
  assert.ok(rejected.every(r => /queue capacity/.test(r.reason.message)));
  const reset = await native.mirrorSubmitControl(handle, { kind: "worldReset", newSessionEpoch: 22, newDimensionEpoch: 2, reason: "dimensionChange" });
  assert.equal(reset.status, "resetApplied");
  const old = await native.mirrorSpatialQuery(handle, query);
  assert.equal(old.status, "scopeMismatch");
  const stopBegan = performance.now();
  const stopped = await native.mirrorSubmitControl(handle, { kind: "stop" });
  const controlStopIdleAckMs = performance.now() - stopBegan;
  assert.equal(stopped.status, "stopping");
  await adapter.stop(); adapters.delete(adapter);
  const terminationBegan = performance.now(); await native.terminateWorker();
  const terminateMs = performance.now() - terminationBegan;
  const resumed = await native.mirrorCreate({ sessionEpoch: 100, dimensionEpoch: 1 });
  assert.equal((await native.mirrorHealth(resumed)).loadedChunks, 0);
  await native.mirrorDispose(resumed); await native.terminateWorker();
  assert.equal(native.mirrorAliveSessions(), 0);
  return { status: "PASS", unknown: unknown.status, invalid: "REJECTED_AT_FFI", visitBudget: bounded.status,
    queueRequests: 80, queueAccepted: 64, queueRejected: rejected.length, reset: reset.status, staleEpoch: old.status,
    controlProbeBehindSaturatedQueueMs, controlStopIdleAckMs, workerTerminateMs: terminateMs, workerRecreatedWithEmptyMirror: true,
    runningNativeCancellation: "NOT_SUPPORTED_BY_PUBLIC_API; internal maxNodes/maxVisits/maxMs bound compute. Termination is whole-Worker teardown, not a per-query cancellation measurement." };
}

async function geometryBoundaryChecks() {
  const cancel = new Int32Array(new SharedArrayBuffer(8));
  const pending = geometry.run(geometryRequest({ sx: 128, sy: 64, sz: 128, cells: new Uint8Array(1048576) }, { cancel, maxMs: 100 }));
  const startDeadline = performance.now() + 5000;
  while (!Atomics.load(cancel, 1)) {
    assert.ok(performance.now() < startDeadline, "geometry start checkpoint timeout");
    await sleep(1);
  }
  const cancelBegan = performance.now(); Atomics.store(cancel, 0, 1);
  const cancelled = await pending;
  const cancellationToReplyMs = performance.now() - cancelBegan;
  assert.equal(cancelled.status, "cancelled");
  const bounded = await geometry.run(geometryRequest(geometryFixture(), { maxVisits: 128, maxMs: 100 }));
  assert.equal(bounded.status, "budgetExceeded"); assert.equal(bounded.reason, "visit-budget");
  const saturated = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => geometry.run(geometryRequest(geometryFixture({ side: 16, height: 8 }), { requestId: `geometry-queue-${i}`, maxMs: 100 }))));
  const rejected = saturated.filter(r => r.status === "rejected");
  assert.equal(rejected.length, 4); assert.ok(rejected.every(r => /GEOMETRY_QUEUE_FULL/.test(r.reason.message)));
  assert.equal(geometry.metrics().pending, 0); assert.equal(geometry.metrics().retainedInputBytes, 0);
  return { status: "PASS", cancelled: { status: cancelled.status, visits: cancelled.visits, computeMs: cancelled.computeMs, cancellationToReplyMs,
      method: "SharedArrayBuffer cancellation observed inside running computation at <=128 visits/checkpoint" },
    visitBudget: { status: bounded.status, visits: bounded.visits }, queueRequests: 20, queueAccepted: 16, queueRejected: 4, metricsAfter: geometry.metrics() };
}

const report = {
  schemaVersion: 2, measuredAt: new Date().toISOString(),
  git: { commit: command("git", ["rev-parse", "HEAD"]), branch: command("git", ["branch", "--show-current"]), dirty: command("git", ["status", "--porcelain"]).length > 0 },
  environment: { node: process.version, rust: command("rustc", ["--version"]), platform: process.platform, release: os.release(), arch: process.arch,
    cpuModel: os.cpus()[0]?.model ?? "UNAVAILABLE", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
    minecraftDataVersion: minecraftVersion, minecraftProtocol: data.version.version, minecraftServer: "NOT_STARTED",
    mineflayer: require("mineflayer/package.json").version, minecraftData: require("minecraft-data/package.json").version },
  classification: "SYNTHETIC; real built Rust N-API + existing Worker + WorldSyncAdapter + Prismarine chunks; no Minecraft or model connections",
  preset: { bots: [1, 5, 10], rounds, roundPauseMs: 10, chunksPerSession: 9, sectionsPerChunk: 24,
    query: queryBase, pathVolume: [side, 8, side], geometryVolume: [side, 16, side], geometryMaxVoxels: 1048576,
    geometryMaxRegions: 256, geometryMaxVisits: 2097152, geometryComputeMaxMs: 20, geometryQueueDepth: 16,
    geometryMaxQueuedInputBytes: 16 * 1048576, nativeQueryQueueCapacity: 64, snapshotRetention: "No external native snapshot handle; geometry input released on reply",
    declaredSteadyBudgetsMs: { eventLoopP99: 25, eventLoopMax: 50, geometryEndToEndP99: 50, syncAckP99: 50 } },
  limitations: [
    "1/5/10 are logical synthetic sessions sharing the existing native Worker, not real bots or separate Runtime processes.",
    "No Minecraft network, task scheduler, inventory logistics, external API, physicsTick or actual L0 timing is measured.",
    "TS connected components are bounding-box/coverage candidates; doors, stairs, ownership and facility semantics are not inferred.",
    "Native worker queue delay, FFI conversion and result delivery are not separately exposed; residual values include all of them and are not pure queue measurements.",
    "Native approxBytes is estimated payload/index storage, not allocator/native peak allocation. RSS is process-wide and sampled every 5ms.",
    "Public native API retains snapshots only inside synchronous queries; long-lived COW retention and native allocator peaks are NOT_VERIFIED.",
    "Spatial native results are checked against a TS oracle on identical fixture points. No Rust room algorithm exists, so TS/Rust room parity and any Rust-room speedup are NOT_VERIFIED.",
  ], measurements: [],
};
try {
  const binary = await readFile(new URL("../packages/pathfinder-rs/pathfinder_rs.node", import.meta.url));
  report.environment.nativeAddonSha256 = createHash("sha256").update(binary).digest("hex");
  geometry = await createGeometryWorker({ queueDepth: 16 });
  for (const count of report.preset.bots) {
    const row = await runLoad(count); report.measurements.push(row);
    console.log(JSON.stringify({ botCount: count, geometryP99Ms: row.timingMs.geometryEndToEndMs.p99, eventLoopP99Ms: row.steady.eventLoopDelayMs.p99, budgetChecks: row.budgetChecks }));
  }
  report.nativeBoundaryChecks = await nativeBoundaryChecks();
  report.geometryBoundaryChecks = await geometryBoundaryChecks();
  report.status = "MEASURED_CORRECTNESS_PASS";
  const operatingRows = report.measurements.filter(r => r.botCount <= 5);
  report.decision = operatingRows.every(r => Object.values(r.budgetChecks).every(Boolean))
    ? "Bounded TS Worker met declared synthetic 1/5-session steady budgets. Do not add or enable Rust room analysis based on this workload; profile real survey/L0 integration first."
    : "One or more declared synthetic 1/5-session budgets failed. No new geometry implementation is enabled; isolate queue, copy and compute contributions before deciding on Rust.";
} catch (error) {
  report.status = "FAIL"; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([...adapters].map(adapter => adapter.stop()));
  await native.terminateWorker();
  await geometry?.close();
  report.cleanup = { adapterStopFailures: cleanup.filter(r => r.status === "rejected").length, nativeAliveSessions: native.mirrorAliveSessions(), geometry: geometry?.metrics() ?? null, workersTerminated: true };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`V2 native baseline: ${report.status}; ${output}`);
}
