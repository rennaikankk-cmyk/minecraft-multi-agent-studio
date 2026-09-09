# V2 native / Worker measurement (2026-09-09)

This is a bounded synthetic measurement. It uses the built `pathfinder_rs.node`, the existing `WorldSyncAdapter` and its single public native Worker, real `prismarine-chunk` columns, and a separate TypeScript Worker reference for connected components. It makes no Minecraft connection, starts no bot, and calls no model or external API.

Run from the repository root:

```powershell
pnpm --filter @minecraft-studio/pathfinder-rs build
pnpm --filter @minecraft-studio/bot-runtime build
node scripts/measure-v2-baseline.mjs docs/benchmarks/v2-native-worker-2026-09-09.json
node --test scripts/lib/v2-geometry-worker.test.mjs
```

The JSON report is the machine-readable evidence: [v2-native-worker-2026-09-09.json](./v2-native-worker-2026-09-09.json). It records the commit/branch, Node/Rust/Minecraft-data versions, native addon SHA-256, RSS samples, CPU time, event-loop delay, ACK RTT, queue depth, extraction and query spans, native mirror memory estimates, correctness oracle comparisons, cancellation and reset probes, and cleanup status.

Measured synthetic logical sessions were 1, 5 and 10 in one process. The 10-session row is a replay/load projection and must not be read as a 10-Bot server result. The run completed with `MEASURED_CORRECTNESS_PASS`; the declared steady synthetic budgets held for the 1 and 5 session rows. Geometry end-to-end P99 was approximately 2.25 ms (1), 4.75 ms (5), and 7.86 ms (10); steady event-loop P99 was approximately 16.30 ms, 15.78 ms, and 16.47 ms respectively. Exact percentile values and all other metrics are in the JSON.

The TypeScript reference distinguishes enclosed candidates, open components, stacked components, and incomplete components containing unknown cells. Its cancellation uses a `SharedArrayBuffer` checkpoint observed during computation; the test measured a 0.14 ms cancellation-to-reply sample. Queue depth is bounded and full submissions are rejected explicitly. Input buffers are transferred and released; the report shows zero retained input bytes after completion.

The existing native API does not expose separate queue, FFI-copy, or result-delivery timestamps. The report therefore labels the residual as a combined transport/queue/delivery value, and labels native mirror bytes as an estimated payload/index size rather than allocator RSS. Native per-query cancellation is not supported by the public API; native work is bounded by its internal visit/time limits and whole-Worker termination is measured separately.

Decision from this workload: the bounded TypeScript Worker met the declared 1/5-session synthetic budgets, so no Rust room analysis is enabled or claimed. A real survey/L0 integration profile is required before changing that decision. Minecraft room ownership, permission, doors/stairs semantics, live coverage, COW retention under long-lived snapshots, and multi-process Runtime behavior remain `NOT_VERIFIED`.
