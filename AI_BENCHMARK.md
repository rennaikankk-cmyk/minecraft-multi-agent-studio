# AI benchmark

## Command

Build and run against a selected OpenAI-compatible endpoint:

```bash
export AI_BASE_URL=http://192.168.50.2:8000/v1
export AI_MODEL=qwen3.8-27b-nvfp4
export AI_API_KEY='<runtime secret if configured>'
pnpm benchmark:ai -- --concurrency 1,2,5,10 --output-dir artifacts
```

The command performs a health check, then measures bounded concurrent synthetic
planning prompts. Each level defaults to `max(4, concurrency * 2)` requests. Use
`--requests N` only when `N` is at least the highest concurrency. Other options:
`--max-tokens`, `--timeout-ms`, and `--output-dir`.

Outputs:

- timestamped JSON with raw per-level metrics and pre/post GPU snapshots
- timestamped Markdown summary
- recommended `AI_MAX_CONCURRENCY`

Metrics include success/failure/error codes, error rate, wall time, p50/p95 total
latency, requests/s, completion tokens, and output tokens/s. NVIDIA temperature,
utilization, memory, and power fields are sampled when supported. On GB10 unified
memory, `nvidia-smi --query-gpu` memory fields may be unavailable; the report
writes `null` and never estimates them.

## Recommendation rule

The tool chooses the lowest healthy level within 95% of maximum measured
throughput. A healthy level has at least one success and error rate no higher
than 1%. If no level is healthy, the recommendation is `null`. Operators should
also reject a recommendation when temperature, system memory, queueing latency,
or longer soak behavior is unacceptable.

The recommended value is only for the exact combination of checkpoint revision,
vLLM/container version, kernel backend, context/token limits, and Spark software.
Re-run after changing any of them.

## Validation-only mode

```bash
pnpm benchmark:ai -- --mock --concurrency 1,2,4 --requests 8 \
  --output-dir /tmp/minecraft-studio-ai-benchmark-validation
```

This checks the benchmark machinery without inference. On 2026-08-20 the mock
run completed and sampled an idle NVIDIA GB10 at 38 °C, 0% utilization, and about
4.1 W. Its throughput and concurrency recommendation are **not model results**
and must never populate production configuration.

## Required real acceptance matrix

Before calling the Spark backend production-ready, retain reports for:

1. `/health` and `/v1/models` after cold start and restart.
2. Structured `execute_skill | wait` response at concurrency 1.
3. Concurrency 1/2/5/10 with 128-token output.
4. Short and long prompt variants, prefix caching off/on.
5. At least 30-minute soak with error, queue, temperature, power, and host-memory
   observation.
6. Model quality fixtures for safe skill selection and hallucinated-skill
   rejection.
7. MTP off first; enable it only after independent correctness/stability results.

The benchmark does not measure Minecraft quality, task completion, Bot execution,
or end-to-end controller latency. Those need separate real Minecraft scenarios.
