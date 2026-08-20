# AI architecture

## Ownership boundary

```text
U9 controller
  task/control input
       -> CoordinatorAIPlanner
       -> AIRequestScheduler (bounded queue, priority, per-Bot concurrency)
       -> AIRouter (health and provider fallback)
       -> OpenAICompatibleProvider ----------------------+
                                                          |
Spark inference-only                                     |
  vLLM OpenAI-compatible API <---------------------------+

validated proposal
  -> future policy + scoped authorization bridge
  -> authenticated skill invocation
  -> Bot Runtime
  -> L0 safety
  -> SkillExecutor
  -> Mineflayer
```

Spark does not own tasks, Bot state, scheduling, memory, authorization, or
Minecraft connections. Bot Runtime does not call a model. The model can only
propose `execute_skill` or `wait`; it cannot emit code, shell commands, raw
Mineflayer calls, or an authorization.

## Request and stale-state contract

Every scheduled request carries:

- UUID `requestId`, bounded `traceId`, `botId`, optional `taskId`
- `taskType`, numeric priority, enqueue timestamp
- monotonic `stateVersion` and `taskVersion`
- bounded prompt/token/temperature/timeout fields
- optional preferred provider and strict structured-output contract

The scheduler cancels queued or running work when a newer state/task version is
observed. The Coordinator rechecks runtime identity, online state, status
sequence, task version, and the current compatibility catalog after inference.
This second check closes the race between provider completion and state change.

## Prompt and output rules

Stable prompt sections come first for prefix caching: system rules, Minecraft
rules, compatible skill catalog, then output schema. Volatile compact Bot state
and current task come last. The context is deliberately bounded; current
telemetry does not yet contain inventory/entity details, so those arrays remain
empty instead of being invented.

Structured output is a strict discriminated union:

```json
{
  "action": "execute_skill",
  "skill": "movement.goto",
  "arguments": { "x": 10, "y": 64, "z": 10 },
  "reason": "Move to the assigned site.",
  "confidence": 0.9
}
```

or:

```json
{
  "action": "wait",
  "reason": "No compatible safe action is available.",
  "confidence": 1
}
```

Only JSON values are accepted. A proposed skill must be present and `available`
in the latest version-bound Bot catalog. The resulting object is a proposal with
the chosen skill version and variant, not `SkillExecutionAuthorization`.

## Scheduling defaults and configuration

`AI_MAX_CONCURRENCY` intentionally has no default. Set it only from a real
benchmark on the selected model/backend. Defaults that do exist are bounded:

| Variable | Default |
|---|---:|
| `AI_MAX_QUEUE` | 64 |
| `AI_PER_BOT_CONCURRENCY` | 1 |
| `AI_STALE_AFTER_MS` | 30,000 ms |
| `AI_MAX_RETRIES` | 1 |
| retry delay | 250–2,000 ms |

Priority order places critical planning and combat strategy ahead of recovery,
normal planning, exploration, chat, and background summaries. Concurrency is
global plus per-Bot, so one Bot cannot occupy multiple planning slots by default.

## Current readiness

Implemented and tested: provider abstraction, OpenAI-compatible transport,
fallback, health, strict structured output, scheduler, compact/prefix prompt,
Coordinator state/task/catalog validation, and fail-closed legacy removal.

Not yet implemented: production Coordinator startup ownership, task/API trigger,
proposal policy and authorization, authenticated skill invocation/result
protocol, durable AI metrics, and real Spark inference validation. See
`PROJECT_AUDIT.md` for the weighted status.
