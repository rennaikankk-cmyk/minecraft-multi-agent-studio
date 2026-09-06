import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const addon = require("../packages/pathfinder-rs/pathfinder_rs.node");
const worker = require("../packages/pathfinder-rs/index.js");
for (const name of ["findPath", "mirrorCreate", "mirrorSubmitEnvelope", "mirrorSubmitControl", "mirrorHealth", "mirrorDispose"]) {
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
  const masks = Buffer.alloc(8);
  masks.writeUInt32LE(1, 4);
  assert.equal((await submit({ kind: "registryTable", revision: 1, masks,
    minecraftVersion: "1.21.11", serverProfileId: "native-smoke-isolated" })).status, "registryReady");
  assert.equal((await submit({ kind: "chunkBegin", chunkX: -1, chunkZ: 0 })).status, "applied");
  assert.equal((await submit({ kind: "sectionData", chunkX: -1, chunkZ: 0,
    payloadKind: "empty", sectionY: -4, fillStateId: 0 })).status, "applied");
  assert.equal((await submit({ kind: "chunkCommit", chunkX: -1, chunkZ: 0 })).status, "applied");
  const health = await worker.mirrorHealth(handle);
  assert.equal(health.loadedChunks, 1);
  assert.equal(health.registryReady, true);
  assert.equal(health.lastTransportSequence, sequence);
  assert.equal((await submit({ kind: "sectionData" })).status, "malformedEnvelope");
  assert.equal(await worker.mirrorDispose(handle), true);
  await assert.rejects(worker.mirrorHealth(handle), /unknown mirror handle/);
  handle = undefined;
  console.log("Native exports PASS: direct + worker findPath, WorldMirror lifecycle, errors");
} finally {
  if (handle !== undefined) await worker.mirrorDispose(handle);
  await worker.terminateWorker();
}
