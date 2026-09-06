# P5-D3 Implementation and Evidence

Scope authority: [original gates](P5_D3_ORIGINAL_GATES_2026-09-06.md). This stage implements spatial indexing/query capability. D4 provider replacement, P5-E pathfinder mirror consumption, and P5-H multiplayer performance remain separate gates. Production team dispatch stays OFF.

## Data Contract

The D2 envelope stays version 1 with additive, explicitly versioned `semanticRegistryV1` and `stateDataV1` variants. Existing movement-only payloads and native exports remain supported. The TS handshake sends movement classification and a separate semantic table, verifies Rust fingerprints, and binds server, dimension, bot session, Minecraft version and selector revision. UTF-8 strings hash by byte length on both sides. Changing an installed registry requires an authoritative epoch-advancing reset.

The 24 selector IDs preserve `importantBlockNames` order. All states of an exact block name aggregate into one selector. `bed` explicitly includes the 16 vanilla color variants, as does `shulker_box` plus its uncolored form. Ores/logs are exact-name interests: deepslate ore and stripped logs are not silently added. `world-semantic-registry.ts` is the traceable TS rule source. The low four movement bits retain `classifyBlock`; additional block-name metadata describes water/lava/fire/falling/climbable/container classes, not waterlogged properties or execution authorization. Rust contains no Minecraft names.

Raw u32 state IDs cross the Worker boundary by transferable buffer. Rust derives a small per-section movement palette and a sparse ordered map of selected/UNKNOWN cells. StateId lookup remains immutable; updates no longer clone/scan the stateId registry or cast a full registry index to u16. Membership replacement removes the old selector. Empty sections promote on their first observed update. Legacy movement-only sections remain semantically unavailable. Missing/unloaded/desynced/UNKNOWN are never treated as AIR. An unknown state in a block update uses an out-of-table ID, not an invented zero/air observation.

Index and movement data share each committed chunk's COW lifetime. Import is transactional, pending imports are marked incomplete for spatial queries, queued updates replay by source order, and committed revisions advance using transport order. Unload/reset releases index entries and queued data. Epoch/scope and query-ID checks reject stale results. Query cancellation abandons the result without claiming to interrupt a running native call; the adapter retains its one-in-flight restriction until that call settles. Client waiting is limited to 10 seconds, and native query work has its own budget.

## Limits

- Query: integer block origin, inclusive Euclidean radius 0..96, nearest count 1..256, selector union/intersection, stable distance-squared then x/y/z ordering. Origin magnitude <=30,000,000. All selectors must be known revision-1 bits.
- Query work: <=131,072 indexed entries and <=10ms requested native budget, checked between small work batches. Timing is cooperative, not a real-time OS guarantee. Only a bounded top-N heap is retained. Budget exhaustion returns no approximate nearest-N result.
- Results: query ID, full local scope/epochs, snapshot generation, consulted chunk revisions/import state, work/timing counters and explicit complete/incomplete/budget/scope/not-ready statuses. Known points in an incomplete result do not prove absence elsewhere.
- Mirror: <=512 committed chunks, 32 open imports, 64 sections/chunk with sectionY -128..127, 65,536 queued updates, 1,048,576 registry states and 2,097,152 sparse index entries. Limits fail closed with a reset-required incident, without evicting arbitrary facts.
- TS extraction: <=512 queued/active columns, one serialized extraction loop, cumulative 3ms slices, existing 2,048-message/16-in-flight/8MiB transport backpressure. Coalesced positions are bounded at 65,536. Duplicate loads cancel the older extraction; unload/reset clears queued extraction work.
- Snapshots copy the loaded-chunk pointer map, not section voxel arrays. They have O(loaded chunks) creation cost, not O(1). Memory estimates report current mirror payload/index estimates; process RSS includes allocator retention and other JS/Worker memory.

The integration now subscribes before enumerating already-loaded columns, reimports them after recovery, and disposes the old mirror on the protocol respawn/dimension transition. A late async startup cannot attach a superseded adapter. `STUDIO_WORLD_MIRROR_SYNC` remains default OFF. Existing periodic scanner/provider behavior is not replaced in this stage.

## Validation

Local commands use the installed GNU Windows toolchain for native Cargo builds. Ubuntu candidate and merged-main CI are recorded in the final takeover report, not inferred from Windows results.

- `cargo fmt --manifest-path packages/pathfinder-rs/Cargo.toml --check`.
- `cargo test --manifest-path packages/pathfinder-rs/Cargo.toml --locked`: 61 tests, including all original 48. Added counterexamples/property tests cover membership churn vs final rebuild (4 seeds, 2,000 updates each), negative height/chunk edges, stable nearest ordering, union/intersection, UNKNOWN/legacy/missing distinctions, epoch/scope/reset, queued import updates, unload/late updates, full-u32 state IDs, actual hard index capacity, and snapshot allocation.
- `node scripts/build-pathfinder-rs.mjs` and `node scripts/check-pathfinder-native.mjs`: real native exports, Worker lifecycle, raw-state query/update/readback, malformed numeric/scope requests and teardown. Both existing Ubuntu workflows execute this smoke.
- Real-registry/ChunkColumn/Worker tests in `world-spatial-index.test.ts` cover versions 1.20.4 and 1.21.11, color families, all states, UTF-8 fingerprints, transferable ownership, cancellation/deadlines and stopped in-flight results. Existing sync/extractor/stress gates remain applicable, with extraction drain included in their completion predicate.
- Complete `pnpm check`: PASS (typecheck, all package tests and builds). Bot Runtime: 543 passed, 6 existing live/integration skips; Coordinator: 567 passed plus 5 Node tests. Native Rust validation remains a separate command. The stress completion predicate now waits for the newly explicit extraction queue as well as transport.

## U9 Measurements

Host: Intel Core Ultra 9 285H, 16 logical CPUs, Windows x64, Node 24.19.0. Workload: isolated synthetic chest/wheat placements in real prismarine 1.21.11 ChunkColumns, 24 data sections/column. No Minecraft connection or Spark calls. Preset: 1/81/289 columns, 300 queries and 12 normal-batch updates per size; visibility deadline 750ms; event-loop P99 target 25ms. Small update samples are insufficient for production tail-latency conclusions.

The first run used millisecond-resolution adapter spans. The second used a monotonic high-resolution clock and separated import/steady observation. A final run verified the cancellation/deadline wrapper and reserved update queue slot; all three reports are retained. The table below uses `runtime-data/p5-d3/takeover-u9-final/benchmark.json` and the final query/sync implementation.

| Columns | Worker query roundtrip P99 ms | Worker snapshot P99 ms | Import loop P99 ms | Normal batch visibility max ms | Approx mirror bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.829 | 0.0008 | 15.26 (7 samples) | 272.9 | 435904 |
| 81 | 0.123 | 0.0023 | 8.30 | 265.9 | 16318784 |
| 289 | 0.145 | 0.0042 | 2.73 | 264.5 | 57614272 |

At 289 columns, main-thread postMessage P99 was 0.0106ms, native query P99 0.0023ms, and observation-loop P99 16.11ms. No skipped/dropped updates or desyncs occurred. After unloading every column, committed chunks and index entries were zero; the current registry remained installed until disposal. RSS delta during the 289-column import was ~91.7MB, a process measurement, not the sparse index alone. Focused final regression: 61 Rust tests and 38 TS/Worker tests passed, with native build/smoke and Bot Runtime build passing after the complete check.

`cargo test --release ... snapshot_allocation_is_chunk_pointer_copy_not_voxel_clone -- --nocapture` uses a test-binary-only thread-scoped allocation probe. At 1/81/289 columns (24 data sections each), 200 snapshots per size allocated at most 148/2256/8784 bytes, with P99 creation 0.2/0.8/2.1 microseconds in that isolated run. This measures the loaded-chunk map copy, not `world.snapshot.build` in an actual Bot main thread.

## Remaining Gates and Rollback

Do not claim `physicsTick.stateChanged` P99 <=15ms, production main-thread snapshot P99 <=10ms, zero NORMAL legacy scans, D4 shadow oracle, or the 1/5/10 Bot live matrix from this evidence. No facility production/harvest permission follows from finding a block. The observer must retain unknown fields where downstream consumption is absent.

Rollback: leave `STUDIO_WORLD_MIRROR_SYNC` unset/0 to disable this optional mirror path; reverting this stage's merge commit restores the prior D2 implementation. Use a new revert commit, never a force push/reset. Native addon and TS source must be rebuilt together after a rollback. Stage commit/merge SHAs, CI links and final status belong to the takeover report.
