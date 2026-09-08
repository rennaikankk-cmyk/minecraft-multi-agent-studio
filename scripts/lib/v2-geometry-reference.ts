/** Benchmark-only TS Worker reference. Geometry is evidence, never ownership or permission. */
import { parentPort } from "node:worker_threads";
import { performance } from "node:perf_hooks";

type Scope = {
  serverProfileId: string; worldId: string; dimension: string; observerBotId: string;
  sessionEpoch: number; dimensionEpoch: number; registryRevision: number; generation: number;
};
type Request = {
  schemaVersion: 1; requestId: string; traceId: string; scope: Scope;
  sx: number; sy: number; sz: number; cells: Uint8Array;
  // 0 observed air, 1 observed solid, 2 unknown/unloaded. No inferred air.
  maxVisits: number; maxRegions: number; maxMs: number; deadlineMs: number;
  cancel: Int32Array;
};
type Region = {
  voxels: number; min: number[]; max: number[];
  kind: "enclosed-candidate" | "open" | "incomplete";
};
const MAX_VOXELS = 1_048_576;
const MAX_REGIONS = 256;

function analyze(request: Request) {
  const began = performance.now();
  const { sx, sy, sz, cells, cancel, scope } = request;
  const regions: Region[] = [];
  let visits = 0, unknown = 0;
  const response = (status: string, reason: string | null = null) => ({
    schemaVersion: 1, requestId: request.requestId, traceId: request.traceId, scope,
    status, reason, visits, unknown, regions, complete: status === "complete" && unknown === 0,
    computeMs: performance.now() - began,
    // Per-request working arrays, excluding input/output and Worker VM overhead.
    workingArrayBytes: status === "invalid" ? 0 : cells.length * 5,
  });
  if (request.schemaVersion !== 1 || typeof request.requestId !== "string" || !request.requestId ||
      !scope || ![scope.serverProfileId, scope.worldId, scope.dimension, scope.observerBotId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128) ||
      ![scope.sessionEpoch, scope.dimensionEpoch, scope.registryRevision, scope.generation].every(v => Number.isSafeInteger(v) && v >= 0) ||
      ![sx, sy, sz].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1024) ||
      !Number.isSafeInteger(sx * sy * sz) || sx * sy * sz > MAX_VOXELS ||
      !(cells instanceof Uint8Array) || cells.length !== sx * sy * sz ||
      !(cancel instanceof Int32Array) || !(cancel.buffer instanceof SharedArrayBuffer) || cancel.length < 2 ||
      !Number.isSafeInteger(request.maxVisits) || request.maxVisits < 1 || request.maxVisits > MAX_VOXELS * 2 ||
      !Number.isSafeInteger(request.maxRegions) || request.maxRegions < 1 || request.maxRegions > MAX_REGIONS ||
      !Number.isFinite(request.maxMs) || request.maxMs <= 0 || request.maxMs > 100 ||
      !Number.isFinite(request.deadlineMs)) return response("invalid", "INVALID_INPUT");

  Atomics.store(cancel, 1, 1); // Observable start checkpoint; cancellation is not a Promise race.
  const check = () => Atomics.load(cancel, 0) !== 0 ? "cancelled" :
    visits >= request.maxVisits ? "visit-budget" :
    performance.now() - began >= request.maxMs ? "time-budget" :
    Date.now() >= request.deadlineMs ? "deadline" : null;
  const visited = new Uint8Array(cells.length);
  const queue = new Uint32Array(cells.length);
  const finish = (reason: string) => response(reason === "cancelled" ? "cancelled" : "budgetExceeded", reason);
  for (let seed = 0; seed < cells.length; seed++) {
    if ((visits & 127) === 0) { const stopped = check(); if (stopped) return finish(stopped); }
    visits++;
    const cell = cells[seed];
    if (cell === 2) { unknown++; continue; }
    if (cell !== 0 && cell !== 1) return response("invalid", "UNKNOWN_CLASS");
    if (cell !== 0 || visited[seed]) continue;
    if (regions.length >= request.maxRegions) return response("budgetExceeded", "region-budget");
    let head = 0, tail = 1, voxels = 0, open = false, missing = false;
    queue[0] = seed; visited[seed] = 1;
    const min = [sx, sy, sz], max = [0, 0, 0];
    while (head < tail) {
      if ((visits & 127) === 0) { const stopped = check(); if (stopped) return finish(stopped); }
      visits++;
      const index = queue[head++]!;
      const x = index % sx, z = Math.floor(index / sx) % sz, y = Math.floor(index / (sx * sz));
      voxels++;
      min[0] = Math.min(min[0]!, x); min[1] = Math.min(min[1]!, y); min[2] = Math.min(min[2]!, z);
      max[0] = Math.max(max[0]!, x); max[1] = Math.max(max[1]!, y); max[2] = Math.max(max[2]!, z);
      const neighbor = (next: number, outside: boolean) => {
        if (outside) { open = true; return; }
        if (cells[next] === 2) { missing = true; return; }
        if (cells[next] !== 0 || visited[next]) return;
        visited[next] = 1; queue[tail++] = next;
      };
      neighbor(index - 1, x === 0); neighbor(index + 1, x === sx - 1);
      neighbor(index - sx, z === 0); neighbor(index + sx, z === sz - 1);
      neighbor(index - sx * sz, y === 0); neighbor(index + sx * sz, y === sy - 1);
    }
    regions.push({ voxels, min, max, kind: missing ? "incomplete" : open ? "open" : "enclosed-candidate" });
  }
  // Retain no request, input or generation snapshot beyond this reply.
  return response(unknown > 0 ? "incomplete" : "complete");
}

parentPort!.on("message", ({ id, request, postedNs }) => {
  const receivedNs = process.hrtime.bigint();
  try {
    const result = analyze(request);
    const outgoingNs = process.hrtime.bigint();
    parentPort!.postMessage({ id, result, receivedNs, outgoingNs, postedNs });
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
parentPort!.postMessage({ ready: true });
