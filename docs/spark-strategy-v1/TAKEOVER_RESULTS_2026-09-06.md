# Unified Takeover Results

Production automatic team strategy dispatch remains OFF. The delivered observer is default OFF, read-only and has no goal/lease/skill execution channel. The current evidence supports a controlled observation canary, not automatic production dispatch.

## Stage Ledger

| Stage | Implementation / merge | Gates |
| --- | --- | --- |
| Rust CI | merged main `8053325daa93b58e4a6f09b85af54d2be48d7988`, PR #10 | Original 48 tests preserved; fmt, locked Cargo, Linux native build and actual find_path/WorldMirror exports; both candidate and actual-main workflows passed. Main runs [34020348507](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34020348507), [34020348580](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34020348580). |
| Spark offline repair | repair `b61c9529a75e843365a696c98d36a84374f5773d`; merged main `172427f635d43f162c9af0c3a168cd990aaff63d`, PR #11 | Seven counterexamples reproduced before repair; 87 module tests; Coordinator 567 + 5 Node. Actual-main CI [34021411829](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34021411829), [34021411852](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34021411852) passed. |
| P5-D3 | `99bb91386c4e8f4a4e0202f54db5123192e873bb` + `a7c80afee8fec5f2cabf306581286cffacd2d2c3`; merged main `df1f5a5e8963100aaae1ecd99dd9e074073d7ff7`, PR #12 | 61 Rust tests, real native/Worker smoke, 39 focused TS tests after air fast path; Bot Runtime 544 + 2 Node, 6 local integration skips. Final candidate [34024121811](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34024121811), [34024121893](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34024121893) and actual-main [34024577661](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34024577661), [34024577677](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34024577677) passed. |
| Observation integration | `56ccb648f523d6540083b3bc0033dac2c2e63ed8`; merged main `fe33fdf51af70a14a7e44a71eeac6ef9537d82b1`, PR #13 | Module 98; Coordinator 578 + 5 Node; AI Router 79. Candidate [34025375584](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34025375584), [34025375603](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34025375603) and actual-main [34025805933](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34025805933), [34025805945](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/34025805945) passed on the stated merge SHA. |

GLM ancestry is preserved through `439a6a1c671766bee38527fd5fc0e26695db344e`. No force push, destructive reset/clean/stash, model downloads, service restarts or old A/B resumption. The protected stash remains `9e12ba24107e07ef47cbd6732f5d21ce42c65318` (`post-model-gates-paused-20260903`). Git HTTPS was intermittently unavailable; exact Git blobs/trees/commits were uploaded through GitHub's Git Data API with SHA equality and non-force reference updates. No commits were reconstructed with changed identities.

## Rust and Spark Scope

The Linux failure was N-API symbol linkage in Rust test binaries. Production N-API exports are compiled outside cfg(test); pure tests are internal modules. This does not guarantee arbitrary future external Rust integration tests are isolated. Both existing Ubuntu workflows also build/load the production addon and exercise real exports; Windows tests are not substituted for Linux evidence.

Spark repairs derive mandatory gates from trusted parsed actions, preserve task/facility unknowns, bound fact age and proposal TTL, retain mandatory summary text or fail explicitly, and use the production goal parsers/builtin schemas for primary and failure-alternative actions. The five offline injected responses yielded four parses, three validator acceptances, one scope rejection and one expected parse failure, not five successful game tasks. Details: [TAKEOVER_VALIDATION.md](TAKEOVER_VALIDATION.md).

## Original D3 Gates

Source and subdivision: [P5_D3_ORIGINAL_GATES_2026-09-06.md](../research/P5_D3_ORIGINAL_GATES_2026-09-06.md). Implementation details: [P5_D3_IMPLEMENTATION_2026-09-06.md](../research/P5_D3_IMPLEMENTATION_2026-09-06.md).

Separate movement and semantic registry masks, per-chunk incremental Rust indexing, bounded nearest-N/radius union/intersection, stable order, raw-u32 import, updates/unload/reset, scope/epoch fences, Worker/N-API queries and result identity are implemented. Index/rebuild, negative height/boundary, late update/reset and capacity tests pass. D2's state loss and Empty-to-Data update gaps are repaired. The first D3 Linux candidate failed an existing zero-overrun assertion because known-air sections still scanned every cell; the follow-up proves the Prismarine SingleValueContainer identity/value and skips redundant reads. Original stress assertions remain unchanged.

U9 285H, Windows x64, Node 24.19.0, synthetic placements in real 1.21.11 prismarine columns (no Minecraft connection or Spark pressure):

| Columns | Worker query P99 ms | Snapshot allocation bytes | Normal update visibility max ms | Approx mirror bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.829 | 148 | 272.9 | 435904 |
| 81 | 0.123 | 2256 | 265.9 | 16318784 |
| 289 | 0.145 | 8784 | 264.5 | 57614272 |

300 queries + 12 normal 250ms-batch updates per size; snapshot allocation probe 200 per size. At 289 columns snapshot Worker P99 0.0042ms, import RSS delta about 91.7MB, steady observation loop P99 16.11ms; no skipped/dropped updates or desync, unload index entries zero. These short runs do not prove physicsTick P99, main-thread world.snapshot P99, long-run gameplay performance or production tails. D4 asynchronous provider replacement/legacy-scan elimination/shadow oracle, P5-E pathfinder consumption and P5-H real 1/5/10-Bot matrices remain separate and NOT delivered as D3.

## Current Spark and Application Budget

Read-only container inspection confirmed Qwen3.8-Flash-Next (two advertised aliases), max-model-len 65536, max-num-seqs 4, MTP 2, GPU fraction 0.75, chunked prefill ON and prefix caching OFF. max-num-seqs means active sequences per scheduling iteration; additional requests can queue. The actual inspected Coordinator configuration assembles maxConcurrency 3/perBotConcurrency 1/requestTimeoutMs 30000. No running Coordinator process was found, so this is configured assembly plus historical startup evidence, not a measurement of a current process. The default 2 and scheduler class fallback 12 do not describe that configuration. Dashboard 3110 and other applications were left running.

All production model paths share the scheduled router/budget. The observer adds one background request at most, 60s sampling, 180s global cooldown, bounded semantic dedup and a 120s deadline. Actual Registry facts are scoped and anonymized, with unknown death counts/shared inventory/production facts preserved. See [OBSERVER_INTEGRATION.md](OBSERVER_INTEGRATION.md).

## Live Quality and Capacity

Preset and amendments were written before dependent requests: [LIVE_BUDGET_2026-09-06.md](LIVE_BUDGET_2026-09-06.md). No retries replace failed samples. The first serial response parsed but invented Bot-to-Bot container.transfer parameters/resource IDs; validator rejected it. Actual builtin parameter schemas were then added to the shared prompt. The one amended serial qualification passed in 10.922s (2185 prompt/345 completion tokens); the original 21.276s failure is retained.

Each capacity level uses the same eight scenario categories and one shared scheduler with distinct planning client IDs. This is not multiple simultaneous production team observers. Each level: eight parses, seven validator acceptances, one deliberately stale rejection, eight expected primary action/wait matches; zero parse failures, length finishes, request timeouts/cancellations, incorrect waits or observed wrong accepted actions. Four offline negative controls per stage were rejected/reobserved, separately from live model outputs.

| Concurrent clients | N | P50 total s | P95/P99 total s | Complete responses/min | Prompt/completion tokens | Max sampled KV fraction | Max sampled server waiting |
| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 1 | 8 | 14.808 | 21.052 | 4.20 | 17939 / 3472 | 0.0598 | 0 |
| 2 | 8 | 16.139 | 21.327 | 6.76 | 17937 / 3497 | 0.1195 | 1 |
| 3 | 8 | 19.902 | 24.022 | 7.08 | 17939 / 3663 | 0.1793 | 1 |
| 4 | 8 | 23.015 | 26.351 | 9.67 | 17937 / 3345 | 0.2390 | 3 |

Client total includes scheduler queue and full non-stream inference response; scheduler queue was 0..1ms in these deliberately bounded batches. Server running reached 1/2/3/4 respectively. Brief server waiting occurred; no three consecutive waiting samples or preemption increases. Per-run token counters matched completed response usage in these capacity stages. Other callers could still race idle checks, so no exclusive-service claim. TTFT and first valid structured decision time are unavailable. N=8 P95/P99 are maxima, not reliable production tails; output lengths varied and the stages were not randomized. Behavior matches only the chosen action/wait, not arbitrary prose preconditions/success descriptions or gameplay success.

The five-ID mixed burst used the existing application concurrency 3: five planning + three chat + one team request. One planning response completed in 11.104s; three chats timed out at 15.006s; the harness then closed the scheduler, ending five remaining requests with AI_SCHEDULER_CLOSED. Those closures are test aborts, not five independent model failures. Ten-ID live burst was NOT RUN after the stop condition. Complete-response throughput was 3.73/min; the preserved original failed-run summary counted cancellation settlements as 33.58/min, corrected by `summarize-spark-takeover.mjs`.

Offline 5/10-ID scheduler replays reproduce burst chat deadlines while respecting global 3/per-Bot 1. Sparse arrivals pass only under explicit assumptions (planning/team 20s rounded from the observed median; chat 4s ASSUMED/unmeasured; new Bot planning every 30s, chat after its plan). They are not Minecraft loops or real inference capacity measurements.

One independent LOCAL_TEST/E2E cached-image world ran a real SingleBotRuntime. It produced 24 status and 24 world-state messages, a real skill catalog and an accepted food.secure suggestion in 15.242s (2108/489 tokens). Default-off check: zero reads/requests. Observation-on: no assignment events, no retained leases, no skill executions, task still idle and bread count still one. The own container and volume were removed; other containers remained running. This validates a read-only food-shortage observation, not food self-sufficiency or base production.

Total live submissions: 44, full responses: 36. Reported full-response usage: 79847 prompt / 15653 completion tokens. Aborted requests lack per-request token usage; mixed service counters also include partially generated requests. No source-reported usage is invented for them. Portable aggregate: [live-evidence-2026-09-06.json](live-evidence-2026-09-06.json). Original local artifacts remain under `runtime-data/spark-takeover/<run-id>/`; the aggregate identifies every run.

## Commands, Recommendation and Rollback

Executed: `cargo fmt --manifest-path packages/pathfinder-rs/Cargo.toml --check`; `cargo test --manifest-path packages/pathfinder-rs/Cargo.toml --locked`; `node scripts/build-pathfinder-rs.mjs`; `node scripts/check-pathfinder-native.mjs`; complete `pnpm check`; focused Coordinator/Bot Runtime/AI Router tests and builds; `node eval/spark-strategy-v1/run-offline.mjs`; `node scripts/benchmark-world-spatial-index.mjs`; `node scripts/evaluate-spark-takeover.mjs inspect|serial|capacity <1..4>|mixed 3 5` with the existing AI config loaded read-only; `node scripts/observe-spark-isolated-minecraft.mjs <local-ai-config-file>`; the four fake-clock fairness tests; `node scripts/summarize-spark-takeover.mjs`. Local GNU Cargo uses the installed MinGW tools. CI links above provide Ubuntu exact-SHA gates.

Recommendation: do not enable automatic strategy dispatch. Observation-only food review is a viable next controlled canary. For shared interactive workloads prefer application concurrency 2 as a provisional conservative budget: compared with 3 its measured throughput is close and latency lower, leaving service capacity for other callers. This does not fix same-Bot chat queue deadlines and was not a mixed-load SLO validation. Existing configured 3 is not silently changed. Use 4 only for a controlled throughput-oriented batch window; it consumed all measured slots and had higher latency.

Before automatic food dispatch: add adoption-time fresh scope/state/gate/inventory validation and atomic existing task/lease claim; test concurrent claim, cancellation, reconnect/dimension changes, L0 preemption and model outage; define machine-checked success/resource semantics; pass real one-Bot food results and the 5-ID mixed chat deadline gate under a documented sparse admission policy. The first scenario should be one idle Bot securing food without construction, shared-resource contention or combat changes. Operator decides activation after those concrete gates pass.

Rollback without rewriting history: leave `STUDIO_TEAM_STRATEGY_PROPOSAL` and `STUDIO_WORLD_MIRROR_SYNC` unset/0. A future authorized deployment can disable observation by configuration. Revert a stage with a new `git revert -m 1 <merge-sha>` commit after checking dependent stages, then rebuild TS/native together where applicable. No production restart or flag activation was performed in this takeover. Evidence-only follow-up commits, final CI and exact main SHA are recorded in the final delivery artifact.
