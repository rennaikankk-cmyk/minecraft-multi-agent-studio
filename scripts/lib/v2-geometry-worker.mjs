import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { transform } from "esbuild";

/** One reusable, bounded benchmark Worker. This is not a production execution pool. */
export async function createGeometryWorker({ queueDepth = 16 } = {}) {
  if (!Number.isSafeInteger(queueDepth) || queueDepth < 1 || queueDepth > 64) throw new Error("INVALID_QUEUE_DEPTH");
  const source = await readFile(new URL("v2-geometry-reference.ts", import.meta.url), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "cjs", target: "node22" });
  const worker = new Worker(code, { eval: true });
  const pending = new Map();
  let nextId = 0, closed = false, peakPending = 0, retainedBytes = 0, peakRetainedBytes = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => { readyReject(error); for (const entry of pending.values()) entry.reject(error); pending.clear(); retainedBytes = 0; closed = true; };
  worker.on("error", fail);
  worker.on("exit", code => { if (!closed) fail(new Error(`GEOMETRY_WORKER_EXIT_${code}`)); });
  worker.on("message", message => {
    if (message.ready) { readyResolve(); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); retainedBytes -= entry.bytes;
    if (message.error) { entry.reject(new Error(message.error)); return; }
    const end = process.hrtime.bigint();
    entry.resolve({ ...message.result, timing: {
      endToEndMs: performance.now() - entry.began,
      // Includes serialization, scheduling and time behind earlier Worker messages.
      deliveryAndQueueMs: Number(message.receivedNs - message.postedNs) / 1e6,
      resultDeliveryMs: Number(end - message.outgoingNs) / 1e6,
      postMessageMs: entry.postMessageMs,
    } });
  });
  try { await ready; } catch (error) { await worker.terminate(); throw error; }
  return {
    run(request) {
      if (closed) return Promise.reject(new Error("GEOMETRY_WORKER_CLOSED"));
      if (pending.size >= queueDepth) return Promise.reject(new Error("GEOMETRY_QUEUE_FULL"));
      if (!(request.cells instanceof Uint8Array) || request.cells.byteLength > 1_048_576) return Promise.reject(new Error("GEOMETRY_INPUT_SIZE"));
      const id = ++nextId, bytes = request.cells?.byteLength ?? 0;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, began: performance.now(), bytes, postMessageMs: 0 };
        pending.set(id, entry); retainedBytes += bytes;
        peakPending = Math.max(peakPending, pending.size); peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
        try {
          const before = performance.now();
          worker.postMessage({ id, request, postedNs: process.hrtime.bigint() }, [request.cells.buffer]);
          entry.postMessageMs = performance.now() - before;
        } catch (error) { pending.delete(id); retainedBytes -= bytes; reject(error); }
      });
    },
    metrics: () => ({ pending: pending.size, peakPending, retainedInputBytes: retainedBytes, peakRetainedInputBytes: peakRetainedBytes, queueDepth }),
    async close() {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("GEOMETRY_WORKER_CLOSED"));
      pending.clear(); retainedBytes = 0;
      await worker.terminate();
    },
  };
}

export function geometryFixture({ side = 48, height = 16 } = {}) {
  if (!Number.isSafeInteger(side) || side < 8 || side > 128 || !Number.isSafeInteger(height) || height < 8 || height > 64 || side * side * height > 1_048_576) throw new Error("INVALID_FIXTURE_SIZE");
  const cells = new Uint8Array(side * height * side).fill(1);
  const at = (x, y, z) => (y * side + z) * side + x;
  // Eight sealed, stacked room components; floor/walls/ceiling remain observed solids.
  for (const [x0, x1] of [[1, side / 2 - 1], [side / 2 + 1, side - 1]])
    for (const [z0, z1] of [[1, side / 2 - 1], [side / 2 + 1, side - 1]])
      for (const [y0, y1] of [[1, height / 2 - 1], [height / 2 + 1, height - 1]])
        for (let y = Math.ceil(y0); y < y1; y++) for (let z = Math.ceil(z0); z < z1; z++) for (let x = Math.ceil(x0); x < x1; x++) cells[at(x, y, z)] = 0;
  return { sx: side, sy: height, sz: side, cells };
}

export function geometryRequest(fixture, overrides = {}) {
  return { schemaVersion: 1, requestId: "fixture", traceId: "fixture",
    scope: { serverProfileId: "v2-synthetic", worldId: "fixture-world-v1", dimension: "minecraft:overworld", observerBotId: "synthetic-0", sessionEpoch: 1, dimensionEpoch: 1, registryRevision: 1, generation: 1 },
    ...fixture, maxVisits: 2_097_152, maxRegions: 256, maxMs: 20, deadlineMs: Date.now() + 30_000,
    cancel: new Int32Array(new SharedArrayBuffer(8)), ...overrides };
}
