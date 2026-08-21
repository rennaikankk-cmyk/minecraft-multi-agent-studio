# Local AI Bot Guide

Local AI runs through the U9 control plane. Bot Runtime never calls DGX Spark directly and never executes raw model text.

```text
DGX Spark inference API
        |
U9 AI Router + AIRequestScheduler
        |
Coordinator / Planner
        |
validated skill.invoke.v1
        |
authenticated Runtime Link
        |
Bot Runtime SkillExecutor
        |
Mineflayer capability adapters
```

## Safety boundary

- The model can propose only structured, versioned skill invocations.
- Coordinator validates identity, task, bot, expiry, and available skill catalog before dispatch.
- Runtime Link accepts the strict `skill.invoke.v1` schema after mutual authentication.
- Bot Runtime validates the selected Skill's exact input schema and derives its capability allow-list from the local registered definition. The model cannot grant capabilities to itself.
- L0 safety can pause normal work and cancel an active skill at any time.
- Movement, combat timing, target identity, reconnect and other tick-level behavior stay deterministic and local.

The removed `AI_ENABLED`, `AI_API_URL` and `index-ai.js` path was an unsafe incomplete prototype: it called the model from Bot Runtime and only logged `Would execute skill`. Do not recreate or use that path.

## Configuration

U9 AI settings are server-side only:

```text
LOCAL_AI_HUB_URL=http://192.168.100.2:8000
AI_MAX_CONCURRENCY=4
AI_MAX_QUEUE=64
AI_PER_BOT_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=30000
```

The model name and endpoint must match the model service actually verified on Spark. Do not put credentials, production server addresses, player allow-lists or base coordinates in prompts or logs.

See `docs/AI_SCHEDULER.md` for queue semantics and priority assignments. Bot Runtime and Coordinator startup still use their normal commands:

```bash
pnpm coordinator:start
pnpm bot:start
```

Both require the existing authenticated Runtime Link configuration. Only an isolated or explicitly approved server profile may be enabled during development.

## Current status

The authenticated SkillInvocation transport, strict protocol validation and deterministic runtime execution are implemented and tested. The Coordinator planner and external goal/chat ingress are separate control-plane modules; until those report ready, the Dashboard must continue to show Local AI Hub as unavailable or starting rather than claiming autonomous AI operation.
