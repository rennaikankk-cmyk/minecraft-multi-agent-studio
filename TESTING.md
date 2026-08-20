# Test and acceptance matrix

## Offline regression

```bash
pnpm check
```

This performs package builds, all TypeScript checks, Vitest/Node process tests,
and production builds. Environment-gated PostgreSQL/Redis and Minecraft cases
remain visibly skipped unless their explicit guards are present.

The final 2026-08-20 Spark tree passed **449 Vitest cases plus 2 real Node child
process cases**; 23 external-environment cases remained visibly skipped. The
production build generated `/ai` and `/api/ai/metrics` successfully.

## Process and browser acceptance

```bash
pnpm test:runtime-link
pnpm test:four-process
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
```

Runtime Link and four-process acceptance launch real local processes and
authenticated WebSocket/HTTP links. The Runtime fixture reports
`minecraftConnected=false`; those results are not relabeled as Minecraft.
Chrome Playwright passed **12/12**, including the validated AI Node metrics page;
the persisted-theme hydration warning found during the first run was fixed and
did not recur.

## AI

```bash
pnpm --filter @minecraft-studio/ai-router test
pnpm --filter @minecraft-studio/coordinator test
pnpm ai:health
pnpm ai:test
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

The 2026-08-20 real Spark health/structured/matrix/restart and 30-minute soak
gates passed. The soak completed 612/612 requests with zero errors. See
`AI_BENCHMARK.md`. Mock mode validates tooling only:

```bash
pnpm ai:benchmark:concurrency -- --mock --requests 10 \
  --output-dir /tmp/minecraft-studio-ai-benchmark-validation
```

## PostgreSQL and Redis

Use only dedicated, loopback, disposable test resources and a unique
`studio_test_...` namespace:

```bash
export TASK_POSTGRES_URL='postgresql://...@127.0.0.1:55432/minecraft_studio_test'
export TASK_REDIS_URL='redis://127.0.0.1:56379/15'
export TASK_INFRA_TEST_NAMESPACE='studio_test_unique_identifier'
pnpm test:task-infra
```

On 2026-08-20, 20/20 real infrastructure cases passed against temporary ARM64
PostgreSQL 17 and Redis 7.4 containers backed by tmpfs. The containers/images
were removed and no Docker Volume was created.

## Minecraft

The guarded Windows/U9 workflow is:

```powershell
pnpm test:minecraft-skills
```

It pins the official Minecraft 1.21.8 server hashes, loopback/offline isolated
profile, Java 21, no RCON/query, and requires explicit human EULA acceptance.
Current real cases cover join/status/version, `smelt.item`, graceful stop,
unexpected server stop and bounded reconnect. Spark only has Java 8 and the
required EULA confirmation is not assumed, so no local real-Minecraft pass is
claimed.

## Remaining hardware gates

- run the whole suite on U9 Windows/x64;
- real isolated Minecraft 1/2/5/10 Bot scenarios and M3 PvP timing;
- U9 PostgreSQL/Redis recovery;
- wired U9↔Spark AI matrix and network-failure tests;
- native FP4 backend comparison if one becomes documented for GB10/sm_121.
