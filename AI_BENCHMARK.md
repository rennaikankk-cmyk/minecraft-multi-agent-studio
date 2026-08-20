# AI benchmark and acceptance

## Stable commands

Configure the selected OpenAI-compatible endpoint without committing secrets:

```bash
export AI_BASE_URL=http://127.0.0.1:8000/v1
export AI_MODEL=qwen3.8-27b-nvfp4
export AI_QUANTIZATION=modelopt_fp4
```

Leave `AI_API_KEY` unset only for the loopback development endpoint. Set the
matching vLLM API key for every wired/non-loopback run.

Then use the four required entry points:

```bash
pnpm ai:health
pnpm ai:test
pnpm ai:benchmark
pnpm ai:benchmark:concurrency
```

`ai:health` reads `/health`, `/v1/models`, `/version`, and `/metrics`.
`ai:test` requires one schema-valid `execute_skill | wait` response and reports
vLLM's real per-request timing fields. `ai:benchmark` runs concurrency 1. The
matrix command runs 1/2/4/8/10 at 128 output tokens and stores timestamped JSON
and Markdown in `runtime-data/ai/benchmarks/`.

For the stability gate:

```bash
export AI_MAX_CONCURRENCY=4
pnpm ai:soak
```

The soak defaults to 30 minutes, concurrency 4, and 128 output tokens. Raw
reports are runtime data and intentionally ignored by Git.

## Metrics and recommendation

Each matrix level retains:

- prompt, aggregate output, and per-request generation tok/s
- requests/s, success/failure, stable error counts and error rate
- controller queue and provider queue P50/P95/P99
- end-to-end P50/P95/P99
- per-request TTFT and TPOT P50/P95/P99
- vLLM running/waiting requests, KV use, cumulative histogram snapshots
- pre/post GPU temperature, utilization, memory (when supported), and power

The recommendation rejects levels with excessive error, latency growth,
provider queueing, waiting requests, or KV pressure, then selects the lowest
level within 90% of peak healthy throughput. It is not simply the maximum
tok/s level.

## Recorded Spark result — 2026-08-20

Endpoint: vLLM 0.27.1, Qwen3.8-27B heretic ARA ModelOpt W4A16 NVFP4, MTP off,
8,192 context, `max-num-seqs=4`, prefix cache on, per-request metrics on.

The health, model, metrics, version, strict structured-output, cold-start, and
restart checks passed. The 1/2/4/8/10 matrix completed 52/52 requests with zero
failures and recommended `AI_MAX_CONCURRENCY=4`.

| Concurrency | Aggregate output tok/s | Per-request tok/s P50 | TTFT P95 | Provider queue P95 | Result |
|---:|---:|---:|---:|---:|---|
| 1 | 11.71 | 11.66 | 181 ms | 0.02 ms | healthy baseline |
| 2 | 23.17 | 11.68 | 273 ms | 0.01 ms | healthy |
| 4 | 44.19 | 11.10 | 384 ms | 0.02 ms | **recommended** |
| 8 | 44.25 | 11.04 | 430 ms | 11,517 ms | reject: queueing |
| 10 | 44.49 | 11.16 | 492 ms | 22,893 ms | reject: queueing |

Peak observed during the matrix was approximately 71 °C, 95% GPU utilization,
and 53 W. GB10 unified-memory fields are unavailable from `nvidia-smi` and stay
`null`; the tool does not estimate them.

The concurrency-4 release soak then ran for 30.04 minutes with 128 output tokens
per request: **612/612 succeeded, zero errors**. Mean aggregate output was
43.643 tok/s; maximum provider-queue P95 was 0.066 ms, maximum per-batch TTFT
P95 was 443.984 ms, maximum temperature was 69 °C, and maximum power was
42.06 W. A post-soak strict structured request and health/metrics snapshot also
passed before the temporary vLLM process was stopped.

The vLLM cumulative histogram includes the cold JIT request and uses coarse
buckets, so its lifetime P95 may differ from the exact per-request P95 retained
for the matrix. Prefer per-request data for a bounded run and Prometheus data
for long-lived service trends.

## Backend requirement

Start vLLM with `--enable-per-request-metrics`; otherwise the five exact
per-request fields remain unavailable. This option can add CPU overhead at high
concurrency, so keep it enabled for the accepted matrix and repeat the benchmark
if changing it.

The checkpoint format was verified as ModelOpt `W4A16_NVFP4`, but both the host
vLLM 0.27.1 and installed NVIDIA 26.05 container selected weight-only Marlin and
warned that native FP4 computation was unavailable. The API benchmark is valid
for that fallback path; it is not proof of native GB10 FP4 acceleration.
