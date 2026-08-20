# Minecraft Multi-Agent Studio — Project Audit

Audit date: 2026-08-20

Repository: `rennaikankk-cmyk/minecraft-multi-agent-studio` (private)

Implementation branch: `codex/u9-spark-ai-foundation`

## Executive verdict

The repository is a real, buildable control plane rather than a UI scaffold. The
requested hardware-independent U9/Spark foundation is implemented: one
Coordinator-owned AI path, authenticated skill execution, deterministic L0/L1,
task persistence, deterministic team allocation, version/capability resolution,
real Spark metrics, per-Bot AI telemetry, benchmark tooling, and split deployment
profiles.

It is not honest to call the final two-host production system 100% accepted yet.
Three gates are outside the currently completed code path:

1. the U9 285H host has not arrived, so Windows x64, Ethernet, firewall, service,
   and real 1/2/5/10 Bot load acceptance cannot run;
2. the isolated Minecraft workflow requires the operator to accept Mojang's EULA
   and a trusted Java 21/server bundle; this audit did not create `eula=true`;
3. the checkpoint is real ModelOpt `W4A16_NVFP4`, but both the host vLLM stack and
   NVIDIA's official container report a Marlin weight-only fallback on GB10.
   Native FP4 execution is therefore **BLOCKED**, not relabelled as complete.

Status is deliberately split instead of hidden behind one number:

| Measure | Completion | Meaning |
|---|---:|---|
| Hardware-independent implementation requested for the Spark development phase | **100%** | code, schemas, profiles, tests, dashboard, metrics, CLI, benchmark and runbooks are present |
| Acceptance possible on the current Spark without accepting a third-party EULA | **100%** | Spark, model, API, benchmark, database/cache and offline/process/browser gates |
| Final U9 + Spark two-host production acceptance | **BLOCKED / not yet measurable** | requires the U9 and operator-approved Minecraft acceptance |
| Broader long-horizon anarchy/PvP M0–M6 roadmap | **not claimed complete** | advanced crystal/anchor PvP, production memory ingestion/concrete embedding-reranking, non-spatial task experience and formal skill-promotion automation remain later milestones |

For the single percentage requested by the original audit, the full end-state is
**87% weighted complete**. This number includes—not hides—the unavailable U9,
Minecraft and native-FP4 gates:

| Area | Weight | Completion | Contribution |
|---|---:|---:|---:|
| Spark system, storage and Git preservation | 10% | 100% | 10.0% |
| AI Provider/Router/Scheduler and safe execution path | 20% | 100% | 20.0% |
| task persistence, APIs and Worker foundation | 10% | 95% | 9.5% |
| deterministic L0 and practical Skill library | 15% | 85% | 12.75% |
| multi-Bot coordination, world memory and compatibility | 15% | 90% | 13.5% |
| Dashboard, metrics, benchmark and diagnosis | 10% | 100% | 10.0% |
| Spark model/backend acceptance | 10% | 85% | 8.5% |
| final U9/Minecraft production acceptance | 10% | 25% | 2.5% |
| **Total** | **100%** | — | **86.75% → 87%** |

The lower full-system number is not unfinished foundation code: it is mainly
real U9/Minecraft execution plus deliberately gated high-risk combat, production
memory-ingestion and skill-promotion milestones. It must not be raised by mock
data or documentation.

## Implemented architecture

```text
Browser
  -> Dashboard server proxy
  -> authenticated Control API
  <-> mutually authenticated Coordinator Control Link
  -> TeamCoordinator / AIService / AIRequestScheduler / AIRouter
  -> OpenAI-compatible Spark vLLM endpoint
  -> strict structured decision
  -> schema -> policy -> live-state validation -> authorization grant
  <-> mutually authenticated Runtime Link
  -> SkillExecutor -> bounded Mineflayer capability adapter

Task Worker -> BullMQ/Redis -> PostgreSQL task repository + outbox

Memory Agent -> immutable PostgreSQL/pgvector world facts
             -> server/dimension/ACL filtering -> safe planner context
```

No Bot Runtime can call a model directly. No model response can execute JavaScript,
shell commands, arbitrary Mineflayer calls, or an unregistered Skill. Planning is
limited to one in-flight high-level decision per Bot; state/task version changes
cancel or discard stale work.

## Module status

| Area | Current reality | Remaining acceptance |
|---|---|---|
| Spark system/storage | DGX OS/Ubuntu, ARM64, GB10, driver/CUDA, memory, disk, Docker and network inventoried; safe cleanup only; model and volumes preserved | none on Spark |
| AI Provider/Router | Mock and OpenAI-compatible providers, strict structured output/repair/fallback, prefix-cache prompt layout | optional future cloud providers |
| Scheduler | priority, concurrency, bounded queue, timeout, retry, cancellation, per-Bot limit, backpressure and stale protection | U9-to-Spark network load |
| Task execution | authenticated single-Bot and team task endpoints traverse Coordinator policy/state/authorization and Runtime SkillExecutor | production account/role integration |
| Task infrastructure | PostgreSQL migrations/repository/outbox, Redis/BullMQ, cancellation, leases, recovery; real isolated integration passed | install/configure services on U9 |
| World memory | Immutable PostgreSQL/pgvector spatial facts, idempotent writes, hard server/dimension/ACL isolation, exact cosine retrieval and fail-closed planner injection | production scout/storage writers, concrete embedding/reranker adapters and non-spatial task experience |
| L0 safety | deterministic fall/lava/drowning/critical health/disconnect/stuck/basic-survival responses | real scenario matrix |
| Skills | 16 default deterministic Skills, 17 with explicit isolated PvP allow-list; bounded adapters and read-back verification | real cross-version scenarios; advanced high-risk PvP remains gated |
| Multi-Bot | deterministic 1–10 Bot selection, roles, shared objectives, skill eligibility, Bot/resource leases, conflict prevention, server isolation | real U9 multi-Bot load |
| Compatibility | negotiated Minecraft version plus feature/resource/capability variants and fail-closed degradation | real version matrix; Fabric remains conditional after M3 timing evidence |
| AI observability | `/v1/ai/metrics`, Spark health/models/version/Prometheus collector, Dashboard trends, per-Bot queue/TTFT/generation metrics | persistent external metrics backend is optional operations work |
| Benchmark | health, one-request test, concurrency matrix, recommendation algorithm and soak CLI; JSON/Markdown evidence | rerun after backend/kernel changes |
| Deployment | `dev-spark`, `controller-u9`, `inference-spark` profiles and vLLM systemd template | execute on the physical U9 |

## Real evidence collected on 2026-08-20

### Spark and model

- MSI `MS-C931`, Ubuntu 24.04.4, Linux 6.17.0-1029-nvidia, ARM64.
- NVIDIA GB10, driver 580.173.02, CUDA 13.0; approximately 121 GiB unified
  memory.
- SSD approximately 3.7 TiB total, 364 GiB used, 3.2 TiB free at audit time.
- Model path: `/home/rennaikank/models/qwen3.8-27b-nvfp4`, about 20 GiB.
- Cached revision: `7cb13049d41143cc29c55936388a017665ed5ab8`.
- Quantization metadata: ModelOpt 0.45.0, `W4A16_NVFP4`, group size 16.
- vLLM 0.27.1 loaded the checkpoint in 17.91 GiB and exposed `/health`,
  `/v1/models`, `/version`, `/metrics`, and OpenAI-compatible chat completions.
- At the accepted service profile, KV capacity was about 65 GiB with
  `--max-num-seqs 4` and `--max-model-len 8192`.

### Real concurrency matrix

All 52 requests succeeded; the latency/throughput/queue-aware recommendation was
concurrency **4**.

| Concurrency | Aggregate output tok/s | Per-request output tok/s P50 | TTFT P95 ms | Provider queue P95 ms |
|---:|---:|---:|---:|---:|
| 1 | 11.711 | 11.662 | 181.309 | 0.023 |
| 2 | 23.174 | 11.679 | 272.921 | 0.011 |
| 4 | 44.193 | 11.103 | 383.648 | 0.020 |
| 8 | 44.245 | 11.041 | 429.975 | 11,517.395 |
| 10 | 44.488 | 11.156 | 491.764 | 22,893.214 |

Throughput plateaus after four concurrent sequences while queue latency grows by
seconds, so selecting 4 instead of the maximum observed tok/s is intentional.
Peak observed temperature was about 71 °C, GPU utilization 95%, and power about
53 W during the matrix.

The accepted concurrency-4 soak ran 30.04 minutes: **612/612 requests passed,
zero errors**, mean aggregate output 43.643 tok/s, maximum provider queue P95
0.066 ms, maximum TTFT P95 443.984 ms, maximum 69 °C and 42.06 W. A post-soak
strict structured request and online/idle metrics snapshot passed before the
temporary server was stopped; port 8000 was then verified closed.

### Infrastructure and process evidence

- Real PostgreSQL 17 + pgvector 0.8.6 + Redis 7.4 isolated integration:
  **25/25 passed** (20 task cases + 5 world-memory cases) using loopback-only
  temporary ARM64 containers and tmpfs. The first world-memory run exposed an
  idempotent-replay projection omission; the fix passed the complete rerun. The
  final migration hash then passed a separate 5/5 custom-schema pgvector rerun.
- Temporary test containers and the two newly pulled test images were removed.
- Both test ports were verified closed; no Docker Volume was created or deleted,
  and the pre-existing `rennaikank_open-webui-data` volume was not touched.
- Runtime Link, four-process chain, browser E2E and the root regression are listed
  in `TESTING.md`; final counts are refreshed with each release candidate.

## Native NVFP4 verdict

```text
Checkpoint format: PASS (real ModelOpt W4A16_NVFP4)
Model identity: PASS (requested Qwen lineage retained)
API serving: PASS
Native GB10 FP4 compute kernel: BLOCKED
Observed execution: MarlinNvFp4LinearKernel, weight-only FP4 fallback
```

The same fallback appeared in the existing NVIDIA `nvcr.io/nvidia/vllm` image.
Changing the model name, downloading a substitute, or calling weight compression
“native FP4” would be misleading. Keep this checkpoint and revalidate when an
NVIDIA/vLLM build advertises a native GB10 FP4 kernel.

## Known gates and deliberate non-features

- Real Minecraft is **not run** until the operator explicitly accepts the EULA.
- Fabric/Meteor is **not added**. `AGENTS.md` requires the current Mineflayer
  headless stack until M3 event-loop p99 evidence demonstrates it cannot meet the
  timing budget.
- Advanced crystal/anchor/potion/team PvP is not presented as complete. The only
  PvP Skill is an isolated, allow-listed, R3 melee foundation.
- No Rust was added without evidence. Existing scheduler/supervisor benchmarks
  have not demonstrated a qualifying CPU hot path; Rust remains reserved for a
  measured path/geometry or event-processing bottleneck behind a narrow adapter.
- U9 production secrets, Windows services, firewall rules, NIC addresses and
  performance numbers are not invented before the machine exists.
- No large model, Docker volume, unknown directory, CUDA component, driver or DGX
  system component was deleted or reinstalled.

## Final audit decision

The Spark-side development phase is complete and reproducible. The repository is
ready to move the controller profile to the U9 without a code fork. Final system
acceptance must remain open until the U9 and operator-approved Minecraft test are
available; native NVFP4 stays explicitly **BLOCKED** by the observed kernel.
