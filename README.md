# Minecraft Multi-Agent Studio

A hardware-neutral, fail-closed control plane for Minecraft Java Bots, targeting
an Intel U9 285H controller and an MSI/DGX Spark inference-only node.

## Current status

The hardware-independent U9/Spark foundation is implemented and tested. Final
two-host acceptance still requires the physical U9 and an operator-approved
isolated Minecraft server. The selected Qwen checkpoint is genuine ModelOpt
NVFP4, but the current GB10 software stack uses a Marlin weight-only fallback;
native FP4 is explicitly `BLOCKED`.

## Safety and execution path

```text
Dashboard -> Control API -> Coordinator -> AI Scheduler/Router -> Spark vLLM
                                     -> structured proposal
                                     -> schema + policy + live-state validation
                                     -> authenticated Runtime Link
                                     -> SkillExecutor -> Mineflayer
```

- Bot Runtime has no model dependency or direct model call path.
- L0 survival and safety never wait for an LLM.
- One high-level planning request per Bot; stale results are cancelled/discarded.
- Model output can only select a registered Skill with bounded arguments.
- Single-Bot and team tasks use authenticated, authorized control links.
- Team allocation is deterministic, server-isolated, role/skill-aware, and uses
  Bot/resource leases for 1–10 Bots.
- U9 world memory uses immutable PostgreSQL/pgvector facts with mandatory
  server/dimension/coordinates, ACL filtering before cosine search, and a
  model-safe planner context that excludes base/storage/player coordinates.
- Authorized read-only Scout scans and storage read-back results are projected
  deterministically into that memory; model output never receives a database
  write capability.
- Projected facts first enter a protected atomic/fsync U9-local spool and replay
  idempotently after PostgreSQL or Coordinator recovery; any backlog blocks new
  planning instead of retrying an already completed Minecraft action.

## Quick validation

Requirements: Node 22.23.2+ and pnpm 11.9.0.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:runtime-link
pnpm test:four-process
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
pnpm check:minecraft-workflow
```

External infrastructure tests use explicitly isolated PostgreSQL/pgvector/Redis URLs. The
Minecraft runner never downloads files or accepts the EULA automatically.

## Spark AI commands

```bash
export AI_BASE_URL=http://127.0.0.1:8000/v1
export AI_MODEL=qwen3.8-27b-nvfp4
export AI_QUANTIZATION=ModelOpt-W4A16-NVFP4

pnpm ai:health
pnpm ai:test
pnpm ai:benchmark
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

Benchmark and soak reports are written to the ignored
`runtime-data/ai/benchmarks/` directory. The real 2026-08-20 matrix completed
52/52 requests and recommended concurrency 4; the subsequent 30.04-minute soak
completed 612/612 requests with zero errors.

## Deployment profiles

- `profiles/dev-spark.env.example` — temporary single-host development
- `profiles/controller-u9.env.example` — Coordinator/API/Dashboard/Bots/data
- `profiles/inference-spark.env.example` — inference and metrics only
- `deploy/systemd/minecraft-studio-vllm.service.example` — Spark service template

The final Spark role contains only the NVIDIA stack, vLLM, the selected model and
necessary AI monitoring. Minecraft, Mineflayer, PostgreSQL, Redis, Coordinator,
Dashboard and business logs move to the U9.

## Documentation

- `PROJECT_AUDIT.md` — evidence-backed implementation and blockers
- `SPARK_STORAGE_AUDIT.md` / `DUPLICATE_MODEL_REPORT.md` — storage evidence
- `ARCHITECTURE.md` / `AI_ARCHITECTURE.md` — trust and execution boundaries
- `SPARK_SETUP.md` / `U9_SETUP.md` / `DEPLOYMENT.md` — operations
- `AI_BENCHMARK.md` — metrics, matrix and recommendation logic
- `SKILLS.md` — deterministic Skill contracts
- `TESTING.md` / `TROUBLESHOOTING.md` — acceptance and recovery

Never expose vLLM, Redis, PostgreSQL, Control Link or Runtime Link to the public
Internet. Never commit secrets. Large model/cache deletion, Docker volume
deletion, downloads over 20 GB and system-level NVIDIA changes require explicit
operator approval.
