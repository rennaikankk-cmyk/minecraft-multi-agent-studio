# DGX Spark vLLM SM121 Stage 4 Runbook

## Scope and fixed inputs

This runbook serves the specified text-only controller model only:

- model: `alztrk/Ornith-1.5-35B-A3B-Abliterated`
- revision: `27bc96e998b3084f86a196f076c0b696195a93b1`
- NVFP4 directory: `/home/rennaikank/models/alztrk--Ornith-1.5-35B-A3B-Abliterated-NVFP4/27bc96e998b3084f86a196f076c0b696195a93b1-modelopt-0.45.0-text-only`
- image: `minecraft-studio/vllm-sm121:8030ae625-cu1303-v5`
- service port: `18100` (never `11434`)

The BF16 source is text-only and lacks visual/MTP tensors. Stage 2 intentionally quantized only language tensors that exist in the source. Do not replace this model with `ornith-ai/Ornith-1.5-35B-A3B-NVFP4`.

## Host and artifact evidence

Run the read-only audit from the repository root:

```powershell
pnpm audit:spark
```

The 2026-08-24 run was saved as `runtime-data/dgx-audit-20260824T064347Z.json`. Its raw checks report NVIDIA GB10, CUDA 13.0, aarch64, and the vLLM process. This audit is evidence collection only; it does not stop or restart any service.

Stage 3 acceptance requires artifact evidence, not only CMake configuration output. The v5 probe and raw cuobjdump files are:

```text
runtime-data/spark-phase2/evidence/vllm-sm121-probe-v5.jsonl
runtime-data/spark-phase2/evidence/vllm-sm121-cuobjdump-list-text-v5.txt
runtime-data/spark-phase2/evidence/vllm-sm121-cuobjdump-elf-symbols-sm121-v5.txt
```

The probe reports `NVIDIA GB10`, capability `[12,1]`, `hasNativeSm121=true`, and `hasCompute121Ptx=false`. The cuobjdump listing contains NVFP4 symbols ending in `sm_121a.elf.bin`, for example `reshape_and_cache_nvfp4_kernel...sm_121a.elf.bin`. The supported conclusion is therefore **partial native SM121/121a kernels**, not universal SM121 dispatch.

## Compose override

The reproducible override is `configs/spark/vllm-sm121.compose.override.yml`. It binds the fixed model directory read-only, publishes only `18100`, and uses the observed v5 command shape (`/model`, `--dtype auto`, `--max-model-len 131072`). Set `SPARK_MODEL_PATH` only when the same fixed revision directory is mounted at another host path.

Validate before starting:

```bash
docker compose -f configs/spark/vllm-sm121.compose.override.yml config
docker image inspect minecraft-studio/vllm-sm121:8030ae625-cu1303-v5
test -d /home/rennaikank/models/alztrk--Ornith-1.5-35B-A3B-Abliterated-NVFP4/27bc96e998b3084f86a196f076c0b696195a93b1-modelopt-0.45.0-text-only
```

Start only the project-owned service after validating the model path:

```bash
docker compose -f configs/spark/vllm-sm121.compose.override.yml up -d vllm-sm121
```

Do not run a command that targets the Ollama container or port `11434`.

## Health and smoke checks

Use both endpoint checks and model discovery. `/health` alone is not model readiness:

```bash
curl -fsS http://127.0.0.1:18100/health
curl -fsS http://127.0.0.1:18100/v1/models
```

The expected model id for this override is `ornith-sm121-v5`. The application health check must use `/v1/models` and verify that id. A vLLM version string is diagnostic metadata, not a health result.

## Benchmarks and evidence

Run the five evidence groups in this order, preserving stdout and the JSON files:

1. Hardware and process audit: `pnpm audit:spark`.
2. Streaming concurrency and context: `$env:LOCAL_AI_HUB_URL='http://127.0.0.1:18100'; $env:LOCAL_AI_MODEL='ornith-sm121-v5'; $env:AI_BENCH_OUTPUT='runtime-data/spark-phase2/evidence/spark-benchmark-ornith-baseline.json'; pnpm benchmark:spark`.
3. Planner gate: `$env:AI_BENCH_PROVIDER='vllm'; $env:AI_BENCH_BASE_URL='http://127.0.0.1:18100'; $env:AI_BENCH_MODELS='ornith-sm121-v5'; $env:AI_BENCH_OUTPUT='runtime-data/spark-phase2/evidence/planner-benchmark-ornith-vllm-full.json'; pnpm build:control-plane; pnpm benchmark:planner-models`.
4. Qwen parallel comparison uses the same two commands with model `qwen38-sm121-v5` and separate output files. Qwen is comparison-only.
5. MTP comparison for Ornith is **not measured**: the source checkpoint has no MTP tensors. Do not substitute Qwen's `model_mtp.safetensors` for this result.

Every reported number must cite its command and a raw output fragment from the corresponding evidence file. A failed sentinel check is recorded as failed validation; prompt usage/tokenize counts are the only truncation evidence.

## Planner and deployment gates

Planner schema compliance below 99% is not deployable. The full Ornith run produced `91/100` parsed schema-compliant responses; Qwen produced `100/100`, but Qwen still failed the concurrency/memory, vLLM ARM64 metadata, and license hard gates because those data are not exposed by the vLLM APIs. Keep the gate fail-closed.

## Database migrations

Before enabling control-plane persistence, manually execute `packages/world-memory/migrations/0001_world_memory.sql`. This exact path conflicts with the old branch's same-path file; inspect the checked-out file and resolve the conflict deliberately rather than applying both copies.

Apply task-system migrations in strict order, once per database:

```text
packages/task-system/migrations/0001_task_system.sql
packages/task-system/migrations/0002_task_lease_invariants.sql
packages/task-system/migrations/0003_task_delivery.sql
packages/task-system/migrations/0004_task_delivery_hardening.sql
packages/task-system/migrations/0005_task_goal_input.sql
packages/task-system/migrations/0006_task_execution_fsm.sql
```

Record migration filenames, checksums, operator, UTC time, and transaction result. Do not run migrations automatically from compose startup.

## Ollama boundary and rollback

Ollama is out of scope. Do not stop, restart, reconfigure, change the model, or change port `11434`. The current read-only command is:

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:11434/api/tags
```

The 2026-08-24 response returned `HTTP 200` and a real model list. This is the health criterion. `ollama -v` or a version JSON string means only "binary version readable, port unchanged"; never label that as service health.

To roll back this project-owned vLLM service only:

```bash
docker compose -f configs/spark/vllm-sm121.compose.override.yml stop vllm-sm121
docker compose -f configs/spark/vllm-sm121.compose.override.yml rm -f vllm-sm121
```

Do not use `docker system prune`, remove unrelated containers, or touch Ollama.
