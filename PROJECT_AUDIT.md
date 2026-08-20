# Minecraft Multi-Agent Studio Project Audit

Audit date: 2026-08-20

Repository: `rennaikankk-cmyk/minecraft-multi-agent-studio` (private)

Audited base: `ee88c77` on `main`; active implementation branch includes `40beb91`, `81faeaf`, and the current Coordinator AI slice
Conclusion: **healthy engineering foundation, not yet a complete multi-agent Minecraft product**

## Executive assessment

The repository is real, buildable, and unusually strong in safety boundaries, protocol validation, authenticated control links, cancellation, task persistence primitives, and honest “not connected” UI states. It is not a pile of fake tests. The Coordinator now conditionally owns a tested high-level AI service with strict output and live state/catalog validation, and the unsafe direct Bot model path has been removed. However, most user-facing multi-agent/gameplay goals remain disconnected: task/control APIs do not invoke the service, only seven foundational skills exist, and PvP/Fabric/memory remain design-only.

Estimated completion toward the full U9-controller + Spark-inference target: **45%** (44.5% weighted).

This percentage is weighted by production outcomes, not lines of code:

| Area | Weight | Current completion | Weighted contribution |
|---|---:|---:|---:|
| Safe Runtime/control foundation | 15% | 90% | 13.5% |
| Task persistence/worker foundation | 10% | 65% | 6.5% |
| AI Provider/Router/Scheduler | 15% | 70% | 10.5% |
| L0 + practical skill library | 20% | 25% | 5.0% |
| Multi-Bot Coordinator | 10% | 25% | 2.5% |
| Version/Fabric adapter layer | 10% | 30% | 3.0% |
| Dashboard/AI metrics/benchmark | 10% | 25% | 2.5% |
| U9/Spark deployment profiles and inference | 10% | 10% | 1.0% |
| **Total** | **100%** | — | **44.5%** |

The foundation alone is much further along than 40%; the number is lower because the requested final scope includes real gameplay skills, multi-bot planning, inference deployment, metrics, benchmarks, Fabric fallback, and dual-host operations.

## Repository and build facts

| Fact | Result |
|---|---|
| Git working tree before changes | clean |
| Base branch/remote | `main`, `origin` = target GitHub repository |
| Base commit | `ee88c77` |
| Open GitHub Issues/PRs | none at audit time |
| Monorepo | pnpm workspace, 5 apps + 8 packages |
| Runtime requirement | Node ≥22; `.nvmrc` now pins existing Node 22.23.2 |
| Source size | about 28,632 TS/TSX lines |
| Test size | about 17,536 test lines across 67 current test files |
| Typecheck | PASS with Node 22 |
| Unit/integration tests | **396 passed, 23 environment-gated skipped** |
| Production build | PASS |
| Runtime Link two-process acceptance | PASS; `minecraftConnected=false` |
| Four-process acceptance | PASS; Dashboard → Control API → Coordinator → fixture Runtime, final offline |
| Dashboard Playwright | 11/11 PASS using installed system Chrome |
| Minecraft workflow policy validation | PASS |
| Real Minecraft this audit | not run |
| Real PostgreSQL/Redis this audit | not run; 20 tests gated |

The first Playwright attempt failed only because Playwright's bundled Chromium was absent. Re-running with the already-installed Chrome channel passed all 11 tests without downloading a browser. A React hydration warning for the persisted `data-theme` attribute remains a real low-priority UI defect.

## Current architecture

```text
Dashboard (Next.js)
  -> server-side Control API proxy
  -> Control API (HTTP/WebSocket, auth/rate limits)
  -> authenticated Coordinator Control Link
  -> Coordinator in-memory Bot registry / stop controller
  -> authenticated Runtime Link
  -> Bot Runtime / Mineflayer / L0 / SkillExecutor

Task Worker
  -> BullMQ / Redis
  -> PostgreSQL task repository + outbox

Coordinator AI service (conditional production lifecycle, not task/API-wired)
  -> validates live Bot status/task version/compatible skill catalog
  -> AIRequestScheduler
  -> AIRouter
  -> OpenAI-compatible Provider / Mock Provider
  -> future Spark API
```

The required final ownership split is not implemented as deployment profiles yet. The code is mostly hardware-neutral and TypeScript-based, but shell scripts, the Minecraft acceptance runner, and local AI entrypoints still contain Linux/Windows or host-role assumptions.

## Module-by-module status

### Applications

| Module | Real implementation | Missing / limitation |
|---|---|---|
| `apps/bot-runtime` | Mineflayer client, strict isolated `ServerProfile`, telemetry, reconnect, authenticated Runtime Link, L0 actions, SkillExecutor, process supervisor; no model dependency or call path | real danger scenarios and multi-Bot Minecraft load not run; authenticated skill invocation transport is not implemented |
| `apps/coordinator` | Bot registry, stale/sequence protection, Runtime Link, Control Link, stop authorization/audit, expired lease recovery, conditional AI provider/router/scheduler/planner lifecycle with catalog/state/task validation | no task/API trigger, proposal-to-authorization policy bridge, task assignment/resource allocation/roles/team memory; most control state is in memory |
| `apps/task-worker` | strict config and isolated handler profile; real BullMQ worker primitives | no production gameplay handler catalog or controller startup profile |
| `apps/control-api` | authenticated HTTP/WebSocket Bot state and stop endpoints, rate/connection limits, fail-closed Coordinator mirror | no task API, AI node metrics API, audit query API, user/role system, cross-host TLS |
| `apps/dashboard` | real environment page, Bot list/detail, live stream + polling fallback, safe stop confirmation, explicit failure states | Tasks page is a placeholder; Combat page is static design copy; no AI node, per-Bot AI metrics, benchmark UI, trends, logs, task controls, or role/team view |

### Packages

| Module | Real implementation | Missing / limitation |
|---|---|---|
| `protocol` | strict Zod schemas for telemetry, control links, tasks, skills, version facts | AI request/metric protocols are currently package-local, not cross-service protocol messages |
| `observability` | structured redacted logger and in-memory metric registry | no persistent log/metric backend, tracing exporter, retention, or Spark metrics |
| `environment` | real host/container OS, CPU, memory, GPU probing with explicit unavailable state | no durable node inventory/monitoring service |
| `cpu-resource-manager` | topology detection, generic fallback, pools, scheduler/affinity gates, benchmarks | U9 285H P/E-core validation not possible yet; features correctly default off |
| `safety` | deterministic L0 detection/actions for critical health, lava, drowning, falling, low health, stuck, inventory, hunger | simple stuck recovery only; no corner/door/fence/vertical/swim/dig/place recovery graph; no real hazard matrix this audit |
| `skills` | strict registry/executor/auth/capability boundary and seven skills: move, collect, craft, place, equip, container transfer, smelt | survival suite, food/heal/sleep, farming/fishing, fuel/tool progression, storage accounting/sorting, PvE/PvP, building blueprints, advanced unstuck all missing |
| `task-system` | schemas/state machine/PostgreSQL/BullMQ/outbox/leases/idempotency/cancellation/recovery | production Coordinator/API/Worker wiring incomplete; current local run skipped external services |
| `ai-router` | Provider abstraction, OpenAI-compatible and mock providers, strict `execute_skill \| wait` decision contract, structured validation/repair/fallback, compact context, prefix-cache prompt layout, priority scheduler with concurrency/queue/backpressure/timeout/retry/cancel/per-Bot limit/stale protection; concurrency benchmark emits JSON/Markdown and GB10 GPU snapshots; 34 dedicated tests | no persistent request logs/metrics and no real Spark API/benchmark result yet |

## What is genuinely runnable

- TypeScript compilation and Next.js production build.
- Offline unit/integration suite across all packages/apps.
- Real local WebSocket/HTTP process topology with a test Runtime fixture.
- Authenticated stop path from Dashboard service to Runtime fixture.
- Mineflayer Runtime code against a strictly isolated profile, when an approved test server is supplied.
- Task PostgreSQL/Redis integration in CI or when explicit isolated test URLs are supplied.
- System Chrome Dashboard E2E.
- AI Router/Scheduler entirely with Mock provider; OpenAI-compatible transport contract is tested with mocked HTTP.

## What is scaffold, interface-only, or design-only

| Item | Reality |
|---|---|
| Direct local AI Bot | **removed and fail-closed**: legacy files were deleted and `start-ai-bot.sh` exits with status 2; AI planning is Coordinator-owned |
| Coordinator AI planning | real tested component that returns catalog-bound proposals; production startup/API/policy/execution transport remain unconnected |
| Tasks dashboard | explicit “backend not connected” page |
| Combat dashboard | static six-role design cards; no runtime data |
| Production multi-agent Coordinator | interfaces/control registry exist; task assignment/team/resource algorithms do not |
| Long-term memory / pgvector | not implemented |
| Redis/PostgreSQL controller deployment | libraries and migrations exist; not composed into a controller profile |
| Fabric bridge | no Fabric source tree or build in the repository |
| Advanced PvP/PvE | design PDFs/reference notes only |
| Spark metrics/benchmark | repeatable benchmark and local GPU snapshots implemented; only Mock validation run, no real model result |
| vLLM production service | local environment/images/checkpoint exist on Spark, but project service profile is absent and API not yet validated |
| Skill self-improvement lifecycle | policy described in `AGENTS.md`; no Draft/Sandbox/Canary/Production controller implementation |

## Test quality and “fake test” audit

The repository has extensive meaningful tests. Mocking is used at process or infrastructure boundaries and usually asserts fail-closed behavior; it is not presented as real Minecraft or real database validation.

Environment-gated tests are honest:

- 20 PostgreSQL/Redis cases are skipped unless isolated `TASK_POSTGRES_URL`, `TASK_REDIS_URL`, and namespace are supplied.
- 3 real isolated Minecraft cases are skipped unless the acceptance runner supplies server/profile markers.
- Prior GitHub Actions history records successful real PostgreSQL/Redis runs, but this audit does not relabel historical CI as a current local pass.

Gaps:

- Root `pnpm test` does not run Playwright; `pnpm check` therefore does not include browser E2E.
- Linux Spark cannot use the PowerShell-only `test:minecraft-skills` runner directly.
- No Spark vLLM process test or workload soak exists yet; OpenAI transport has mocked-HTTP tests and benchmark machinery has Mock-provider tests only.
- No 1/2/5/10 real Mineflayer multi-Bot scenario; current 1/2/5/10 AI tests are simulations through one provider.
- Combat, stuck recovery, survival progression, disconnect recovery, and storage skills lack real Minecraft scenario automation.

## Cross-version and platform assessment

Strengths:

- Core code uses Node APIs and path utilities rather than hard-coded ARM64 binaries.
- Mineflayer version negotiation and feature/resource/capability-based skill variants exist.
- Docker images observed on Spark are ARM64, and the project does not assume a per-Bot model process.
- CPU affinity is gated and falls back generically.

Gaps:

- No explicit `ServerVersionDetector`, `ProtocolCapabilityRegistry`, and `SkillCapabilityRegistry` service boundary; equivalent facts are split across Runtime and skills.
- No protocol adapter interface for future packet overrides/Fabric/real-client bridges.
- Isolated Minecraft automation is PowerShell/Windows-centric.
- The sole retained legacy AI start script is a fail-closed migration notice; deployable U9/Spark role scripts do not exist yet.
- No `profiles/dev-spark`, `profiles/controller-u9`, `profiles/inference-spark` composition yet.
- U9 Windows path/process/native dependency validation must wait for hardware.

## Critical technical debt and blockers

### P0/P1 blockers

1. Wire the Coordinator-owned AI service into task/control APIs.
2. Connect validated AI proposals to `Schema -> Policy -> State -> Skill authorization`, never directly to Mineflayer or `SkillExecutor` without trusted authorization.
3. Add an authenticated skill invocation/result protocol between Coordinator and Bot Runtime.
4. Add task API and production Coordinator/Worker composition; otherwise task persistence is isolated infrastructure.
5. Add Linux-safe isolated Minecraft runner before claiming Spark-hosted real scenarios.

### Major feature gaps

- Survival/gather/craft/storage/stuck/PvE/PvP skill depth.
- Real multi-Bot assignment, resource locks, team memory, roles, conflict prevention.
- Fabric compatibility bridge and future protocol adapter.
- Spark metrics, AI node/dashboard metrics, trends, benchmark/recommended concurrency.
- Dual-node profiles, secrets/TLS/network plan, start/stop/restart/runbooks.
- Long-term memory, pgvector, centralized logs/metrics.

### Documentation debt

- `PROJECT_AUDIT.md` was a stale 2026-07-19 “source missing” snapshot and has now been replaced.
- `AI-BOT-GUIDE.md` now documents the safe boundary and remaining blockers.
- `ROADMAP.md` predates the new scheduler and understates the seven-skill count.
- Added current `README.md`, `DEPLOYMENT.md`, `SPARK_SETUP.md`, `U9_SETUP.md`, `AI_ARCHITECTURE.md`, `AI_BENCHMARK.md`, `TESTING.md`, and `TROUBLESHOOTING.md`.

## Recommended next implementation sequence

1. **Production AI request path:** expose a task-owned request path and add the policy/authorization/invocation bridge around the configured service.
2. **Real Spark inference validation:** run the new health/benchmark workflow, inspect kernel fallback and unified-memory behavior, then accept a concurrency limit.
3. **Dual-role profiles:** controller U9 and inference Spark, with a development profile that does not change core code.
4. **Task API/Worker composition:** turn existing persistence primitives into a runnable controller loop.
5. **Linux isolated Minecraft harness:** then expand L0 and practical skills with real scenarios.
6. **Dashboard AI node and Bot AI details:** consume real metrics only.
7. **Advanced multi-Bot/compatibility/Fabric/PvP:** after the above control and test foundations are real.

## Audit verdict

```text
Build: PASS
Typecheck: PASS
Offline tests: PASS (396 passed, 23 environment-gated skipped)
Runtime Link acceptance: PASS (no Minecraft)
Four-process acceptance: PASS (fixture Runtime, no Minecraft)
Dashboard E2E: PASS with system Chrome (11/11)
Real Minecraft: NOT RUN
Real PostgreSQL/Redis: NOT RUN locally
AI production loop: PARTIAL; lifecycle exists, task/API/authorization transport missing
Overall completion: 45% (44.5% weighted)
```
