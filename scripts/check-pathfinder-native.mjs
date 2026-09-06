import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("../packages/pathfinder-rs/pathfinder_rs.node");
const worker = require("../packages/pathfinder-rs/index.js");
for (const name of ["findPath", "mirrorCreate", "mirrorSubmitEnvelope", "mirrorSubmitControl", "mirrorHealth", "mirrorDispose", "mirrorSpatialQuery", "mirrorSpatialMemory"]) {
  assert.equal(typeof addon[name], "function", `missing native export: ${name}`);
}

const world = { sx: 5, sy: 3, sz: 5, classes: Buffer.alloc(75) };
world.classes.fill(worker.CLASS.SOLID, 0, 25);
const start = { x: 1, y: 1, z: 1 };
const goal = { x: 3, y: 1, z: 3 };
let handle;
try {
  const direct = addon.findPath(world, start.x, start.y, start.z, goal.x, goal.y, goal.z);
  assert.equal(direct.success, true);
  assert.deepEqual(direct.path.at(-1), goal);
  const asyncPath = await worker.findPathAsync({ world, start, goal });
  assert.equal(asyncPath.success, true);
  assert.deepEqual(asyncPath.path, direct.path);
  const malformed = { ...world, classes: Buffer.alloc(1) };
  assert.throws(() => addon.findPath(malformed, 1, 1, 1, 3, 1, 3), /classes length/);
  await assert.rejects(worker.findPathAsync({ world: malformed, start, goal }), /classes length/);

  handle = await worker.mirrorCreate({ sessionEpoch: 0, dimensionEpoch: 0 });
  const reset = await worker.mirrorSubmitControl(handle, {
    kind: "worldReset", newSessionEpoch: 5, newDimensionEpoch: 1, reason: "sessionRestart",
  });
  assert.equal(reset.status, "resetApplied");
  let sequence = 0;
  const submit = (message) => worker.mirrorSubmitEnvelope(handle, {
    protocolVersion: 1, sessionEpoch: 5, dimensionEpoch: 1,
    transportSequence: ++sequence, message,
  });
  const masks = Buffer.alloc(12);
  masks.writeUInt32LE(4, 4);
  masks.writeUInt32LE(1, 8);
  assert.equal((await submit({ kind: "registryTable", revision: 1, masks,
    minecraftVersion: "1.21.11", serverProfileId: "native-smoke-isolated" })).status, "registryReady");
  const scope = { selectorRevision: 1, botSessionId: "native-smoke-session", serverProfileId: "native-smoke-isolated", minecraftVersion: "1.21.11", dimension: "minecraft:overworld" };
  const selectors = Buffer.alloc(12); selectors.writeUInt32LE(1, 4);
  assert.equal((await submit({ kind: "semanticRegistryV1", ...scope, selectors })).status, "registryReady");
  assert.equal((await submit({ kind: "chunkBegin", chunkX: -1, chunkZ: 0 })).status, "applied");
  assert.equal((await submit({ kind: "sectionData", chunkX: -1, chunkZ: 0,
    payloadKind: "empty", sectionY: -4, fillStateId: 0 })).status, "applied");
  assert.equal((await submit({ kind: "chunkCommit", chunkX: -1, chunkZ: 0 })).status, "applied");
  const query = { queryId: "smoke-q", sessionEpoch: 5, dimensionEpoch: 1, scope, x: -15, y: -63, z: 1,
    radius: 0, count: 8, selectors: 1, matching: "union", maxVisits: 131072, maxMs: 10 };
  assert.equal((await worker.mirrorSpatialQuery(handle, query)).status, "incomplete");
  assert.equal((await submit({ kind: "blockUpdateBatch", sourceFirstSequence: 1, sourceLastSequence: 1, sourceEventCount: 1, updatesFlat: [-15, -63, 1, 1] })).status, "applied");
  const found = await worker.mirrorSpatialQuery(handle, query);
  assert.equal(found.status, "complete");
  assert.deepEqual(found.points, [{ x: -15, y: -63, z: 1, selectors: 1, distanceSquared: 0 }]);
  assert.deepEqual((await worker.mirrorSpatialQuery(handle, { ...query, matching: "each" })).points, found.points);
  const raw = new Uint32Array(4096).fill(2); raw[(1 << 8) | (1 << 4) | 1] = 1;
  await submit({ kind: "chunkBegin", chunkX: -1, chunkZ: 0 });
  assert.equal((await submit({ kind: "sectionData", chunkX: -1, chunkZ: 0, payloadKind: "stateDataV1", sectionY: -4, stateIds: Buffer.from(raw.buffer) })).status, "applied");
  await submit({ kind: "chunkCommit", chunkX: -1, chunkZ: 0 });
  assert.deepEqual((await worker.mirrorSpatialQuery(handle, query)).points, found.points);
  assert.equal((await worker.mirrorSpatialMemory(handle)).indexEntries, 1);
  assert.equal((await worker.mirrorSpatialQuery(handle, { ...query, dimensionEpoch: 9 })).status, "scopeMismatch");
  await assert.rejects(worker.mirrorSpatialQuery(handle, { ...query, count: 1.5 }), /numeric/);
  const health = await worker.mirrorHealth(handle);
  assert.equal(health.loadedChunks, 1);
  assert.equal(health.registryReady, true);
  assert.equal(health.lastTransportSequence, sequence);
  assert.equal((await submit({ kind: "sectionData" })).status, "malformedEnvelope");
  assert.equal(await worker.mirrorDispose(handle), true);
  await assert.rejects(worker.mirrorHealth(handle), /unknown mirror handle/);
  handle = undefined;
  console.log("Native exports PASS: direct + worker findPath, WorldMirror lifecycle, semantic query/update/scope, errors");
} finally {
  if (handle !== undefined) await worker.mirrorDispose(handle);
  await worker.terminateWorker();
}
