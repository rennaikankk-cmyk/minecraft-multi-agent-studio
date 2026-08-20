# Testing

## Offline regression

```bash
pnpm typecheck
pnpm test
pnpm build
```

Recorded on Spark with Node 22.23.2 on 2026-08-20: typecheck PASS, production
build PASS, 438 Vitest cases plus 2 real child-process cases PASS, and 23
environment-gated cases skipped. The skipped total is 20 PostgreSQL/Redis cases
and 3 real isolated Minecraft cases.

## Process acceptance

```bash
pnpm test:runtime-link
pnpm test:four-process
```

These launch real local Node processes and WebSocket/HTTP links. The Runtime Link
test explicitly reports `minecraftConnected=false`; the four-process path uses a
fixture Runtime. Passing them is not a Minecraft acceptance result.

## Dashboard browser acceptance

```bash
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
```

The recorded system-Chrome run passed 11/11. Root `pnpm test` does not include
Playwright. A low-priority persisted-theme hydration warning remains.

## AI

```bash
pnpm --filter @minecraft-studio/ai-router test
pnpm --filter @minecraft-studio/coordinator test
pnpm benchmark:ai -- --mock --concurrency 1,2,4 --requests 8 \
  --output-dir /tmp/minecraft-studio-ai-benchmark-validation
```

Mock results validate scheduling and tooling only. Follow `AI_BENCHMARK.md` for a
real endpoint; preserve the output with model revision and backend version.

## PostgreSQL/Redis

Use only dedicated isolated resources. Set the three guarded variables from
`.env.example`, including a unique namespace, then run:

```bash
pnpm test:task-infra
```

The guard rejects non-loopback or insufficiently isolated configurations. Never
substitute a production database/Redis instance.

## Minecraft

The current real-server runner is PowerShell-based:

```powershell
pnpm test:minecraft-skills
```

It must use an approved isolated server/profile and acceptance markers. Linux
Spark has no equivalent runner yet. A unit-test MockBot or fixture Runtime cannot
be relabeled as real Minecraft.

## Required future scenarios

- 1/2/5/10 real Bots: connect, tasks, disconnect/reconnect, stale AI cancellation
- hunger/low health/lava/water/fall/inventory/stuck safety matrix
- gather/craft/smelt/storage and version compatibility scenarios
- conflict prevention, resource locks, role reassignment, partial team failure
- real Spark structured output, concurrency, soak, restart, and fallback
- policy/authorization replay, expiry, cancellation, and emergency stop
