# Deployment status and runbook

## Current supported validation topology

The repository currently supports local process acceptance with authenticated
Coordinator links and a fixture Runtime. The final U9/Spark deployment profile
is not composed yet.

| Role | U9 controller | Spark inference |
|---|---|---|
| Coordinator/task policy | intended | forbidden |
| PostgreSQL/Redis/worker | intended | forbidden |
| Dashboard/Control API | intended | forbidden |
| Bot Runtime/Mineflayer | intended | forbidden |
| vLLM/model weights | no default | intended |
| AI request queue/router | intended | forbidden |

## Validate the codebase

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm test:runtime-link
pnpm test:four-process
```

Run Dashboard E2E separately because root `pnpm test` does not include it:

```bash
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
```

Run real PostgreSQL/Redis only against explicitly isolated test resources using
the guarded variables in `.env.example`. Run real Minecraft only against the
approved isolated server workflow.

## Existing local process commands

```bash
pnpm coordinator:start
pnpm worker:start
pnpm api:start
pnpm bot:supervisor
pnpm --filter @minecraft-studio/dashboard build
pnpm --filter @minecraft-studio/dashboard start
```

Each requires its documented environment configuration. The Coordinator and
Control API deliberately reject incomplete peer/client credential lists. Do not
bind their current links beyond loopback.

`start-ai-bot.sh` is intentionally disabled. It must not be used as a deployment
entry point.

## U9/Spark cutover gates

1. Spark candidate loads without unreviewed source patches; health/model endpoints
   pass after cold start and restart.
2. Real AI benchmark report is accepted and sets `AI_MAX_CONCURRENCY`.
3. Wired private IP/firewall/SSH/API-key plan is verified on both machines.
4. Enable the Coordinator AI service and verify provider health without reducing
   stop/control-plane availability.
5. Add the task/API trigger and policy that creates scoped expiring authorization
   from validated proposals.
6. Authenticated skill invocation/result transport passes replay, stale, cancel,
   disconnect, and emergency-stop tests.
7. U9 PostgreSQL/Redis/task composition passes isolated recovery tests.
8. Real Minecraft 1/2/5/10 Bot scenarios pass without cross-Bot conflicts.
9. Dashboard reports real AI and Bot metrics and clearly marks unavailable data.

The lifecycle portion of gate 4 exists; its real endpoint validation and gates
5–9 are not complete. Therefore today’s deployment verdict is
`FOUNDATION_VALIDATED`, not `PRODUCTION_READY`.

## Rollback

- Stop Dashboard, API, Worker, Coordinator, Bot Supervisor, then vLLM.
- Keep model and database data; do not delete volumes or weights as rollback.
- Restore the previous Git commit/branch through a normal reviewed checkout.
- Retain logs and benchmark artifacts with checkpoint/container revisions.
- If Spark inference fails, the Coordinator must reject new AI plans; it must not
  silently move model calls into Bot Runtime or fabricate actions.
