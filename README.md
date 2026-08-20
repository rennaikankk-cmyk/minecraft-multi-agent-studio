# Minecraft Multi-Agent Studio

Hardware-neutral control foundation for safe Minecraft Bot orchestration, with a
target deployment of a Windows U9 285H controller and an MSI/DGX Spark
inference-only node.

Current verdict: **integrated foundation validated, deployment acceptance still
required**. The repository builds and has meaningful protocol, safety, task,
process, control-link, skill, AI scheduling, authenticated invocation, and
deterministic multi-Bot allocation tests. Real Spark, Minecraft, PostgreSQL,
Redis, and browser acceptance remain environment-gated.

## Validate locally

Requirements: Node 22+, Corepack, and pnpm 11.9.0 from `packageManager`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Root tests currently pass 438 cases plus 2 Node process cases, with 23 explicitly
environment-gated cases. Browser, real PostgreSQL/Redis, and real Minecraft
acceptance are separate; see `TESTING.md`.

## Architecture

- U9: Coordinator, tasks, API, Dashboard, Bot Runtime, database/cache
- Spark: one OpenAI-compatible inference service and selected model weights
- AI output: strict proposal only; no code or direct Mineflayer access
- execution: authenticated policy/authorization path, L0 safety, SkillExecutor
- team allocation: server-isolated objectives, roles, skill eligibility, Bot and
  resource leases, deterministic selection for 1–10 Bots

Authenticated task entry points are `POST /v1/bots/:botId/tasks/execute` for a
specific Bot and `POST /v1/team/tasks/execute` for Coordinator-selected team
execution. Both traverse Control API → mutually authenticated Control Link → AI
proposal → policy/authorization → Runtime Link → SkillExecutor.

The safe AI boundary is documented in `AI_ARCHITECTURE.md`. The legacy direct
Bot-to-model entry point is disabled.

## Documentation

- `PROJECT_AUDIT.md` — evidence-backed status, gaps, and weighted completion
- `SPARK_STORAGE_AUDIT.md` — disk/model/Docker inventory and cleanup gates
- `DUPLICATE_MODEL_REPORT.md` — exact and functional model duplicates
- `SPARK_SETUP.md` / `U9_SETUP.md` — host-specific preparation
- `DEPLOYMENT.md` — topology, cutover gates, and rollback
- `AI_BENCHMARK.md` — repeatable JSON/Markdown concurrency benchmark
- `TESTING.md` / `TROUBLESHOOTING.md` — validation and failure handling
- `README_CN.md` — earlier Chinese project overview; use the audit for current
  readiness claims

## Safety

Do not point Bot Runtime at an unapproved Minecraft server. Do not expose
Coordinator links, Control API, vLLM, databases, or Redis to the public network.
Never commit real tokens or shared secrets. Storage deletions over 20 GB, model
deletion, Docker volume deletion, and large downloads require explicit operator
confirmation.
