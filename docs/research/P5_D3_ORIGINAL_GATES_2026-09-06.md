# P5-D3 Scope and Original Gates

Source: the user's original Phase 5 attachment, `pasted-text-20260904-223052-180ce95c.txt`, and subsequent P5-D subdivision instruction. Both were recovered read-only from the local session history on 2026-09-06. The newer unified takeover task supersedes historical no-push instructions.

The subdivision explicitly assigns D3:

- MovementClassMask (solid/diggable/hazard/water) and SemanticSelectorId (the original 24 block interests) are separate concepts.
- TypeScript uses the current registry to map stateId to classMask plus selectorIds. Rust stores no hardcoded block names.
- Per-chunk sparse indexes, radius/count/stable ordering, multi-state aggregation.
- Block updates remove old membership and insert new membership.

Original Phase 5 sections 9, 17 and 18 add applicable query contracts:

- Radius queries, nearest N, union/intersection, UNKNOWN/unloaded exclusion, bounded count and work/time budget.
- Snapshot generation and consulted chunk revisions are returned.
- Incremental results equal a rebuild from final data; duplicates, unload, reset, negative coordinates and boundaries remain correct.
- Snapshot creation has O(loaded chunks) pointer-copy cost. Measure its time and allocation size, along with index memory, import/update/query cost and main-thread impact on the actual U9 host.
- Update visibility is bounded by the normal batch cycle (currently 250ms) plus measured queue/worker time; do not claim a tick-level bound without evidence.
- No dropped updates or unbounded index growth; UNKNOWN never becomes AIR.

The original overall Phase 5 targets remain unchanged: main-thread snapshot P99 <=10ms, physicsTick.stateChanged P99 <=15ms, event-loop delay P99 target <=25ms, zero periodic NORMAL findBlocks x24 scan and zero stable-region oracle mismatches. These are overall integration gates, not claims that a standalone D3 microbenchmark proves production latency.

D4 separately owns the default-off asynchronous provider, latest-completed synchronous reads, true shared in-flight query, LOCAL_TEST/E2E shadow oracle and retiring NORMAL findBlocks x24. P5-E separately owns Pathfinder mirror consumption and corridor invalidation. P5-F/G/H own broader worker recovery, live oracle and 1/5/10 Bot AB matrices (1 and 5 Bot at least 10 minutes; 10 may be explicitly NOT RUN). None is relabeled D3.

Implementation findings: D2's legacy section payload merges stateIds into movement class masks, so it cannot reconstruct semantic membership. D3 needs a versioned semantic handshake and a raw-state section variant while preserving legacy D2 exports. Legacy-only sections must return semantic UNAVAILABLE/INCOMPLETE, not invented empty results. D2 also ignores updates to explicit Empty sections; D3 must promote them on the first observed update and preserve NotPresent as distinct.

Production strategy dispatch remains OFF. D3 queries do not authorize harvesting, prove facility production or replace server-side action verification.
