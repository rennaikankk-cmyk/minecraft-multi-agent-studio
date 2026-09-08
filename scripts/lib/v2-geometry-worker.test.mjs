import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createGeometryWorker, geometryFixture, geometryRequest } from "./v2-geometry-worker.mjs";

test("bounded TS Worker preserves enclosed, open, stacked and unknown geometry distinctions", async t => {
  const worker = await createGeometryWorker(); t.after(() => worker.close());
  const fixture = () => geometryFixture({ side: 16, height: 8 });
  const at = (x, y, z) => (y * 16 + z) * 16 + x;
  const enclosed = geometryRequest(fixture(), { maxMs: 100 });
  const result = await worker.run(enclosed);
  assert.equal(enclosed.cells.byteLength, 0, "transfer detaches the sender snapshot");
  assert.equal(result.status, "complete"); assert.equal(result.complete, true);
  assert.equal(result.regions.length, 8);
  assert.equal(result.regions.reduce((sum, r) => sum + r.voxels, 0), 8 * 6 * 6 * 2);
  assert.ok(result.regions.every(r => r.kind === "enclosed-candidate"));
  assert.deepEqual(result.scope, enclosed.scope);
  const open = fixture(); open.cells[at(0, 1, 1)] = 0;
  assert.equal((await worker.run(geometryRequest(open, { maxMs: 100 }))).regions.filter(r => r.kind === "open").length, 1);
  const unknown = fixture(); unknown.cells[at(0, 1, 1)] = 2;
  const missing = await worker.run(geometryRequest(unknown, { maxMs: 100 }));
  assert.equal(missing.status, "incomplete"); assert.equal(missing.complete, false);
  assert.equal(missing.regions.filter(r => r.kind === "incomplete").length, 1);
  const stacked = fixture(); stacked.cells[at(1, 3, 1)] = 0; stacked.cells[at(1, 4, 1)] = 0;
  assert.equal((await worker.run(geometryRequest(stacked, { maxMs: 100 }))).regions.length, 7);
  assert.equal(worker.metrics().retainedInputBytes, 0);
});

test("invalid dimensions, class, scope, visits, region and deadlines fail closed", async t => {
  const worker = await createGeometryWorker(); t.after(() => worker.close());
  const fixture = () => geometryFixture({ side: 16, height: 8 });
  for (const overrides of [{ sx: Number.MAX_SAFE_INTEGER }, { scope: {} }, { maxMs: 101 }, { maxVisits: 0 }]) {
    assert.equal((await worker.run(geometryRequest(fixture(), overrides))).status, "invalid");
  }
  const invalid = fixture(); invalid.cells[0] = 3;
  assert.equal((await worker.run(geometryRequest(invalid))).reason, "UNKNOWN_CLASS");
  const visits = await worker.run(geometryRequest(fixture(), { maxVisits: 128, maxMs: 100 }));
  assert.equal(visits.status, "budgetExceeded"); assert.equal(visits.reason, "visit-budget");
  assert.ok(visits.visits <= 128);
  assert.equal((await worker.run(geometryRequest(fixture(), { maxRegions: 1, maxMs: 100 }))).reason, "region-budget");
  assert.equal((await worker.run(geometryRequest(fixture(), { deadlineMs: Date.now() - 1 }))).reason, "deadline");
  assert.equal(worker.metrics().retainedInputBytes, 0);
});

test("shared cancellation actually stops a running calculation and preserves the Worker", async t => {
  const worker = await createGeometryWorker(); t.after(() => worker.close());
  const cancel = new Int32Array(new SharedArrayBuffer(8));
  const request = geometryRequest({ sx: 128, sy: 64, sz: 128, cells: new Uint8Array(1_048_576) }, { cancel, maxMs: 100 });
  const pending = worker.run(request);
  const deadline = performance.now() + 5000;
  while (!Atomics.load(cancel, 1)) {
    assert.ok(performance.now() < deadline, "Worker must acknowledge compute start");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  Atomics.store(cancel, 0, 1);
  const result = await pending;
  assert.equal(result.status, "cancelled"); assert.equal(result.complete, false);
  assert.ok(result.visits < 2_097_152);
  assert.equal((await worker.run(geometryRequest(geometryFixture({ side: 16, height: 8 }), { maxMs: 100 }))).status, "complete");
  assert.equal(worker.metrics().retainedInputBytes, 0);
});

test("queue saturation is bounded and explicit close rejects outstanding work", async t => {
  const worker = await createGeometryWorker({ queueDepth: 2 }); t.after(() => worker.close());
  const make = () => geometryRequest(geometryFixture({ side: 16, height: 8 }), { maxMs: 100 });
  const first = worker.run(make()), second = worker.run(make());
  await assert.rejects(worker.run(make()), /GEOMETRY_QUEUE_FULL/);
  assert.equal(worker.metrics().peakPending, 2);
  await Promise.all([first, second]);
  const cancelled = assert.rejects(worker.run(make()), /GEOMETRY_WORKER_CLOSED/);
  await worker.close(); await cancelled;
  assert.equal(worker.metrics().pending, 0); assert.equal(worker.metrics().retainedInputBytes, 0);
  await assert.rejects(worker.run(make()), /GEOMETRY_WORKER_CLOSED/);
});
