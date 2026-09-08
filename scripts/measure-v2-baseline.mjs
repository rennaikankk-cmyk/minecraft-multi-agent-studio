import os from "node:os";
import process from "node:process";
import { performance } from "node:perf_hooks";
const iterations = Number(process.env.V2_MEASURE_ITERATIONS ?? 100_000);
const start = performance.now();
let checksum = 0;
for (let i = 0; i < iterations; i++) checksum = (checksum + ((i * 31) ^ (i >>> 3))) >>> 0;
const elapsedMs = performance.now() - start;
const result = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  scope: "deterministic-control-plane-baseline",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpuCount: os.cpus().length,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  rssBytes: process.memoryUsage().rss,
  iterations,
  elapsedMs,
  opsPerSecond: elapsedMs > 0 ? Math.round(iterations / elapsedMs * 1000) : null,
  checksum,
  minecraft: "NOT_RUN",
  rust: "NOT_MEASURED"
};
console.log(JSON.stringify(result, null, 2));
