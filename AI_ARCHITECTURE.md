# AI architecture

## Ownership and execution boundary

```text
U9 task/team request
  -> CoordinatorAIPlanner
  -> AIRequestScheduler (global bounded priority queue, per-Bot limit)
  -> AIRouter -> OpenAI-compatible Provider
  -> Spark vLLM
  -> strict structured proposal
  -> schema -> policy -> fresh state/catalog -> scoped authorization
  -> authenticated Runtime Link -> L0 safety -> SkillExecutor -> Mineflayer
```

Spark owns inference only. Bot Runtime never calls a model. The model can only
propose `execute_skill` or `wait`; it cannot emit executable code, shell, raw
Mineflayer calls, credentials, or authorization.

## Request and freshness contract

Every scheduled request carries UUID `requestId`, trace/Bot/task identity,
`taskType`, priority, timestamp, monotonic state/task versions, timeout, token
budget, and a strict output contract. Global and per-Bot concurrency, bounded
queue/backpressure, timeout, retry, cancellation, and priority starvation tests
are implemented.

Registry changes invalidate obsolete queued/running work. After inference the
Coordinator rechecks runtime identity, online state, state sequence, task
version, compatible skill/version/variant, policy and authorization expiry. A
late response cannot execute against newer state.

## Prefix-cache layout

Stable content is first: system policy, Minecraft rules, compatible skill
catalog, output schema. Volatile compact Bot context, team state, failures and
task are last. Missing inventory/entity data remains empty rather than invented.

## Multi-Bot path

One `TeamCoordinator` deterministically assigns roles and compatible online
Bots, enforces one active task per Bot, uses expiring named/area resource claims,
prevents cross-objective collisions, recovers expired leases, and provides team
state to the planner. Tests cover 1/2/5/10 Bots. All requests still share one
Scheduler and one Spark model instance.

## Metrics path

```text
Spark /health, /v1/models, /version, /metrics
  -> SparkMetricsCollector
  -> authenticated Control API GET /v1/ai/metrics
  -> server-only Dashboard proxy
  -> AI Node cards and 1m/5m/15m/1h browser-session trends

vLLM chat-completion metrics
  -> Provider normalized per-request metrics
  -> Planner observation tracker
  -> Control Link Bot state
  -> Bot detail AI performance
```

Controller queue and provider queue are separate. Missing metrics remain null;
the UI never substitutes simulated values. Per-Bot detail includes AI state,
task type, model, prompt/output tokens, controller/provider queue, TTFT,
generation latency/rate and total latency.

## Configuration

`AI_MAX_CONCURRENCY` has no code default and is selected by benchmark. Current
accepted Spark fallback-path result is 4. Queue defaults to 64, per-Bot
concurrency to 1, stale window to 30 seconds, and retries to one bounded attempt.
See `.env.example` and `AI_BENCHMARK.md`.

## Current inference limitation

The selected checkpoint is genuine ModelOpt W4A16 NVFP4 and functional. Both
installed host and NVIDIA-container backends chose weight-only Marlin instead of
native FP4 compute. This is recorded as `BLOCKED` for native NVFP4 performance,
without changing the production model target.
