# Controlled Spark Observation Budget

Written before the first live request on 2026-09-06. This is an independent takeover evaluation; frozen model-selection contracts and historical artifacts are unchanged. No production configuration or model changes. Automatic team dispatch remains OFF.

Verified service: Qwen3.8-Flash-Next aliases, max-model-len 65536, max-num-seqs 4, MTP 2, GPU fraction 0.75, chunked prefill ON, prefix cache OFF. max-num-seqs bounds active sequences per scheduling iteration; it is not a permanent physical limit on total accepted requests. Before each stage require idle service metrics; record running/waiting/KV/preemptions and token counters during requests. Other applications can race the idle check; detected interference must be reported, not hidden.

## Preset

- Protocol qualification: 1 serial planning-length team request, max_tokens=3000, background deadline 120s. Require parse, validator and expected food behavior to pass before escalation.
- Capacity: concurrency 1, 2, 3, 4; eight distinct scenarios per level (32 requests). Each level covers food shortage, construction material shortage, repeated failure, reasonable wait, active task conflict, unknown task, stale facts and competing resource claims. Context includes actual summary constraints and output schema; max_tokens=3000, 120s team deadline. Capacity requests simulate independent planning clients through one scheduler; they do not represent several simultaneous team observers. The production observer remains one in flight.
- Mixed fairness: only after applicable capacity levels pass. Select an evidence-supported level <=4, then 5 and 10 synthetic Bot IDs. Each Bot receives one planning request; three chat requests share three of those IDs, and one background team review shares the same scheduler (9 and 14 requests). Planning deadline 45s, chat 15s, team 120s; max_tokens=3000 for planning/team and 384 for chat. Priorities do not preempt already-running server inference.
- Maximum live requests: 56; maximum requested completion tokens: 152304 (50*3000 + 6*384). Input target <=8000 model tokens/request; character estimate is only a preflight guard, actual server usage is reported. Overall wall-clock budget 45 minutes. No retries. No extra load merely to fill slots.
- Poll metrics every 2s with bounded fetch time. Stop escalation on request errors, cancellation/timeouts, truncation, unsafe accepted actions, increasing preemptions, three consecutive waiting samples, or running requests beyond this run's in-flight requests. Preserve all samples. A failure requires diagnosis and a documented revised budget before any extra live samples.

## Accounting

Client latency starts immediately before scheduler submission and ends when the complete non-stream response resolves. Scheduler queue and execution durations come from scheduler results. Prompt/completion tokens and finish_reason are SOURCE-REPORTED by vLLM. TTFT and first valid structured decision time are unavailable on this non-stream path, never derived from total latency. Service metrics include all callers and cannot by themselves attribute tokens to one client.

Report sample counts, parse failures, truncation, request errors/timeouts/cancellations, validator acceptance, expected behavior, incorrect waits, accepted wrong actions, resource conflict handling, latency distribution, throughput and token usage per level. Small-sample P95/P99 are descriptive maxima, not production reliability evidence. Controlled negative proposals run through the same validator but are explicitly offline controls, separate from model-generated actions. Mixed Bot IDs are workload simulation, not 5/10 live Minecraft bots.

An isolated one-Bot Minecraft observation may use one already-cached E2E image, a new disposable world and unique container/volume. It must not reclaim other fixtures. Its Registry evidence and observation logs are reported separately from synthetic capacity inputs; no production goals or leases are acquired by the observer.

## Revision After First Serial Sample

The first sample (`1788687153513-serial-1-b114a2a8`) returned parseable JSON in 21276ms, 1615 prompt/636 completion tokens, finish=stop. Validator rejected INVALID_ACTION and UNKNOWN_RESOURCE_REFERENCE: the model invented Bot-to-Bot container.transfer params and a bread:8 resource ID. No capacity escalation occurred. Its failed qualification remains in the denominator.

Add the actual reviewed builtin parameter schemas (with trusted scope/position fields removed structurally) to the shared observer prompt, and explicitly distinguish container transfer from Bot handoff. Clarify the scenario's shortage as food item count, not hunger level. Budget amendment: exactly one additional serial qualification, max_tokens=3000, 120s. Revised total ceiling 57 live requests / 155304 requested completion tokens; the 45-minute aggregate wall budget and stop conditions remain. This is a diagnosed protocol correction, not a retry that replaces a failure.

## Mixed Workload Stop and Isolated Observation

All four capacity levels completed without request errors. The five-ID mixed burst at application concurrency 3 timed out all three 15s chat requests while planning occupied slots; the harness then stopped and closed five remaining requests. The ten-ID live burst is NOT RUN. Its unused budget is not filled with replacement pressure. Offline 5/10-ID scheduler replay will distinguish burst behavior from sparse arrival assumptions. One of the unused request slots may be used for the independently scoped one-Bot isolated Minecraft observer check (3000 tokens / 120s / concurrency 1), after an idle service check. The total ceiling remains unchanged. This verifies actual telemetry and read-only effects, not mixed-load stability.
