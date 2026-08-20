# U9 controller + Spark inference deployment

## Final ownership

| Service | U9 controller | Spark inference |
|---|---:|---:|
| Coordinator, AI Router/Scheduler | yes | no |
| Mineflayer Bot Runtime and Minecraft server | yes | no |
| PostgreSQL, pgvector, Redis/BullMQ | yes | no |
| Control API, Dashboard, logs and tests | yes | no |
| vLLM, model weights and AI metrics | no | yes |

Host-neutral code and committed examples live under `profiles/`. The Spark
systemd template is under `deploy/systemd/`. Completed copies and all secrets
remain outside Git.

## Implemented control path

```text
Dashboard
  -> authenticated loopback Control API
  -> mutually authenticated Control Link
  -> deterministic TeamCoordinator allocation/resource claims
  -> Coordinator AI planner and one global scheduler
  -> Spark OpenAI-compatible API
  -> strict JSON schema
  -> policy + fresh state/catalog validation
  -> scoped expiring skill authorization
  -> authenticated Runtime Link
  -> Bot Runtime L0 safety + SkillExecutor + Mineflayer
```

The task and team execution APIs are real and rate/permission limited. One
Scheduler/model serves all Bots; per-Bot high-level planning remains at most
one inflight. Stale state/task responses are cancelled or discarded. Spark
failure never fabricates a decision or disables the stop plane.

## Controller validation

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:runtime-link
pnpm test:four-process
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
```

Use dedicated isolated PostgreSQL/Redis resources for `pnpm test:task-infra`.
Use the guarded Minecraft workflow only after explicit EULA acceptance. See
`TESTING.md`.

## U9 world-memory database

Install PostgreSQL 17 plus pgvector on U9, bind it to loopback, create a
credential-bearing connection outside Git, then apply the checked-in migration
with `ON_ERROR_STOP` before setting `WORLD_MEMORY_ENABLED=true`:

```text
packages/world-memory/migrations/0001_world_memory.sql
```

Use a protected `.pgpass`, OS credential store, or service EnvironmentFile;
do not place a password-bearing URL on a command line. Coordinator startup
verifies pgvector 0.8+ and the memory table and fails closed when enabled but
unavailable. The migration is forward-only and creates immutable facts; rollback
means stopping the Coordinator and returning to the previous reviewed code,
not deleting the database. Back up the database before future schema changes.

When enabled, the same runtime persists validated `scout.scan-blocks`,
`storage.account`, and `container.transfer` completions. Monitor
`coordinator_skill_result_observer_failed`; it means the game action completed
but its derived memory did not persist. Do not automatically retry a
non-idempotent Minecraft action to repair memory—schedule a fresh read-only scan
or account operation until the durable ingestion outbox is implemented.

## Spark validation

Follow `SPARK_SETUP.md`, then:

```bash
pnpm ai:health
pnpm ai:test
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

The recorded functional recommendation is `AI_MAX_CONCURRENCY=4` for the exact
2026-08-20 configuration. Re-benchmark after any checkpoint, vLLM/container,
kernel, context, quantization, prefix-cache, MTP, or per-request-metrics change.

## U9 arrival gates

Only hardware/network-dependent gates remain:

1. Record U9 OS, CPU topology, memory, storage, Node, Docker, and adapters.
2. Verify wired private IPs, MTU/link speed, routing, SSH, API key, and firewall
   allow-list from U9 to Spark TCP 8000 only.
3. Run the full code/test/browser suite on U9 x64/Windows.
4. Run PostgreSQL/pgvector/Redis on U9 and repeat task recovery plus world-memory
   isolation/semantic acceptance.
5. Run real Minecraft 1/2/5/10 Bot scenarios on the isolated server.
6. Repeat the AI matrix across Ethernet and accept the network RTT/concurrency.
7. Decide whether Marlin fallback is acceptable or test a documented native
   GB10/sm_121 FP4 backend; never silently change the production model.
8. Only then install/enable service startup and production credentials.

Fabric/Meteor is not part of the current headless deployment. Per `AGENTS.md`,
reconsider a real-client/Fabric fallback only if the separate M3 real PvP timing
milestone proves Mineflayer cannot meet the required timing.

## Rollback

- Stop U9 Dashboard/API/Worker/Coordinator/Bot processes, then stop vLLM.
- Disable service startup without deleting models, caches, databases, or logs.
- Return to the previous reviewed Git commit through a normal checkout; never
  force-push shared history.
- Keep benchmark, kernel, model-revision, and failure evidence.
- If Spark is unavailable, reject new AI planning and retain deterministic L0
  safety and authenticated stop capability.
