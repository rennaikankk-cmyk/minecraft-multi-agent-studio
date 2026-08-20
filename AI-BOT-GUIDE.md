# AI Bot architecture and readiness

## Current boundary

The U9 controller owns high-level planning through `CoordinatorAIPlanner`,
`AIRequestScheduler`, `AIRouter`, and an `AIProvider`. Spark is an
OpenAI-compatible inference endpoint only. Bot Runtime never calls a model.

```text
U9 Coordinator -> AIRequestScheduler -> AIRouter -> Spark vLLM
       |                                      |
       | validated proposal                  | structured JSON only
       v                                      v
authorization/task path -> Bot Runtime -> L0 safety -> SkillExecutor
```

The planner currently returns a validated **proposal**, not a skill execution
authorization. It checks the live Bot status sequence, task version, and the
version-bound compatibility catalog. Responses are discarded when state or task
versions change. A model-proposed skill is accepted only when the current Bot
catalog marks it available and supplies a selected variant.

## Deliberately disabled legacy entry point

`start-ai-bot.sh` exits with status 2. The former path connected Bot Runtime
directly to a model, parsed loose JSON, and only logged an execution placeholder.
Keeping that path runnable would violate the controller/Spark boundary and could
mislead an operator into thinking actions were authorized or executed.

## What is implemented

- OpenAI-compatible and mock providers, provider fallback, and health checks
- bounded priority queue, per-Bot concurrency, backpressure, retry, timeout,
  cancellation, and stale request invalidation
- compact context and prefix-cache-friendly prompt ordering
- strict `execute_skill | wait` structured output contract
- Coordinator validation against live status, task version, and skill catalog
- Bot Runtime SkillExecutor and L0 safety remain the execution boundary

## What still blocks autonomous play

- a Coordinator task/control API must invoke `CoordinatorAIPlanner`
- a policy service must turn an accepted proposal into a scoped, expiring
  `SkillExecutionAuthorization`
- the authenticated control link needs a skill invocation message and result path
- Spark vLLM production profile and U9-to-Spark network policy need deployment
  and measured benchmark validation
- real Minecraft multi-Bot scenarios still need to be run

Until those pieces are complete, do not describe the system as autonomous or
production-ready. Unit tests use a mock provider and do not prove real model or
Minecraft execution.
