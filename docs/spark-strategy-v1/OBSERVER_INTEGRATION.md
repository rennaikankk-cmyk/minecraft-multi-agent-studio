# Read-Only Team Proposal Observer

`STUDIO_TEAM_STRATEGY_PROPOSAL` is independent and defaults to OFF. Explicit `1` creates the observer only when the Coordinator has a scheduled AI router. `0`/unset do not start sampling or issue requests. Invalid values fail startup. Production automatic strategy dispatch has no implementation in this observer and remains OFF.

## Facts and Privacy

`RegistryFactReader` reads actual BotRegistry status/catalog, retained assignment leases, BaseRegistry phase evidence, FacilityRegistry reservations, and WorkstationRegistry observation/lease data. Bot and assignment `inspect` methods are pure projections: they never sweep, notify, reconcile, release, acquire or renew. They copy returned records; normal execution continues to use its existing APIs.

Facts are grouped by exact server and dimension, limited to 32 scopes, 10 Bots/scope, 64 resource/facility entries and 128 reservations. Status/phase/workstation facts use a 60s freshness bound with 2s clock skew; the snapshot uses the oldest included observation. Heartbeats and sampling time cannot refresh old status. Unknown death totals and shared stock remain unknown. Catalog support is the intersection of current runtime catalogs for the reviewed action rules. Active tasks, safety holds and retained assignment reservations are non-preemptible. No task titles, arbitrary metadata, dropped-item coordinates or credentials enter the prompt.

Actual base/facility IDs encode coordinates, so IDs, Bot/runtime/session and server references use process-local keyed HMAC aliases. Custom dimension names are also aliased. The random key prevents offline enumeration of coordinate-derived IDs; aliases remain stable within one process, change across restarts, and require no growing identity cache. Absolute target positions stay in the local trusted action context. Inventory uses validated registry item names, never display/NBT text. Public logs retain only closed-schema action metadata, whitelisted params, reason codes and accounting; raw model prose is not logged.

Finding a workstation can establish its observed availability and lease ownership. Finding slots or crop blocks cannot establish aggregate farm/production availability, which stays unknown. BASE_SITE_RESERVED is also explicitly age-checked, even though the legacy BaseRegistry accessor exempts it. Unknown or absent phase evidence never becomes satisfied.

## Scheduling and Validation

One shared ScheduledAIRouter supplies planning, replan/site and the team observer, with the existing configured global/per-Bot scheduler budget and common breaker. No additional AI scheduler is constructed in production. The observer samples every 60s, has a global 180s request cooldown, allows one request in flight, and bounds its dedup cache to 32 scopes/30 minutes. Unchanged status timestamps/sequences do not trigger reviews; runtime identity and semantic state changes do. Failed requests do not receive automatic retries. Team priority is background with an effective 120s deadline, 3000 output tokens, temperature 0. A planning-priority request would still have the scheduler's 45s ceiling.

The prompt contains the existing proposal schema plus the actual reviewed builtin parameter schemas, structurally excluding trusted scope and position fields. Returned proposals pass the existing action/gate/task/resource/freshness validator. The observer re-reads semantic content after inference and marks changed/retired scopes as requiring reobservation. Its result is never execution permission. Shutdown aborts its request and drains the observer; logging failures cannot affect tasks.

vLLM finish_reason now reaches GenerateResult and proposal accounting. A length finish is unusable even when the JSON parses. Scheduler cancellation/supersession is distinct from timeout; usage and queue/execution timings remain attributable. TTFT and first structured decision time are unavailable for this non-stream path.

## Validation and Rollback

Tests cover default OFF, no-read/no-request behavior, stale inspection without notifications, expired lease observation without release, private IDs/coordinates, production status remaining unknown, scope/runtime separation, timestamp dedup, evidence age, busy workstations, one request in flight, changed facts, shutdown, native finish_reason and timeout/cancellation accounting. Before the final prompt addition, full `pnpm check` passed; final exact commit CI and live evidence are recorded in the takeover report.

Turn the observation flag off/unset and restart only through an authorized normal deployment to disable it. No automatic flag changes or production restarts occur in this takeover. To roll back code, revert this stage's merge in a new commit and rebuild; preserve the Rust/Spark repair/D3 predecessors. A future dispatch canary must reobserve at adoption, revalidate scope/gates/inventory and atomically claim through the existing task/lease authority. Start with one idle Bot's food request, preserve L0 arbitration, require zero unsafe acceptances and explicit cancellation/reconnect/lease-race tests before operator approval.
