# DGX Spark Stage 4 Evidence Report (2026-08-24)

## 1. Completed

Stage 3 artifact acceptance and Stage 4 measurements are archived. The service used port `18100`; port `11434` was not changed or used by vLLM. The v5 image was `minecraft-studio/vllm-sm121:8030ae625-cu1303-v5`.

Fixed controller input:

```text
model=alztrk/Ornith-1.5-35B-A3B-Abliterated
revision=27bc96e998b3084f86a196f076c0b696195a93b1
artifact=/home/rennaikank/models/alztrk--Ornith-1.5-35B-A3B-Abliterated-NVFP4/27bc96e998b3084f86a196f076c0b696195a93b1-modelopt-0.45.0-text-only
```

The BF16 source is text-only and lacks visual/MTP tensors. ModelOpt exported only language tensors that exist in that source. `ornith-ai/Ornith-1.5-35B-A3B-NVFP4` was not used.

## 2. Changes

- `configs/spark/vllm-sm121.compose.override.yml`: project-owned vLLM service, read-only fixed model mount, port `18100`, observed v5 command shape, and endpoint healthcheck.
- `docs/runbooks/dgx-spark-vllm-sm121-stage4.md`: start/health/rollback procedure, SM121 evidence, migration order, Ollama boundary, and MTP limitation.
- `docs/benchmarks/spark-phase4-vllm-sm121-2026-08-24.md`: this auditable report.
- `packages/ai-router/src/adapters/vllm-adapter.ts`: recursively removes only `propertyNames` from the request copy sent to vLLM grammar compilation; the application Zod schema remains authoritative.
- `packages/ai-router/tests/vllm-adapter.test.ts`: regression test for that vLLM request boundary.
- `scripts/run-planner-model-benchmark.mjs`: applies the same vLLM grammar sanitization to benchmark requests.

The five parallel-worktree files remain uncommitted and untouched: `.env.example`, `apps/bot-runtime/src/runtime.ts`, `apps/bot-runtime/tests/runtime.test.ts`, `apps/control-api/src/main.ts`, and `scripts/build-local-env.mjs`.

## 3. Key conclusions

### Measurement group 1: host, runtime, and kernel artifact

Command: `pnpm audit:spark`

Raw output file: `runtime-data/dgx-audit-20260824T064347Z.json`

Raw fragments:

```text
gpuQuery: NVIDIA GB10, 580.173.02, [N/A], [N/A], 41, 10
cuda: Cuda compilation tools, release 13.0, V13.0.88
toolchain: vllm=0.26.1rc1.dev858+g8030ae625.d20260824, transformers=5.15.1
```

The v5 probe file reports `device=NVIDIA GB10`, `capability=[12,1]`, `hasNativeSm121=true`, and `hasCompute121Ptx=false`. The raw commands are embedded in the evidence files:

```text
COMMAND: cuobjdump --list-text /usr/local/lib/python3.12/dist-packages/vllm/_C_stable_libtorch.abi3.so
SASS text section 17667 : ... reshape_and_cache_nvfp4_kernel...sm_121a.elf.bin
COMMAND: cuobjdump --dump-elf-symbols --gpu-architecture sm_121 /usr/local/lib/python3.12/dist-packages/vllm/_C_stable_libtorch.abi3.so
arch = sm_121
```

Evidence hashes: probe `64dda8d94f6802ce9b1e7a74013e874d4707549600df2f346d34bb4448e2b237`; cuobjdump list `f3de4077eb34ff5f5901fd2b543385b74de661953fcf345f87fe0709da37a55`; ELF symbols `36bfc087d8ed6bc6b94e370fd1452b745bf36296eb452f753fd3dd16b25ed7a7`.

Conclusion: **partial native SM121/121a kernels**. CMake architecture acceptance is not used as artifact proof; universal SM121 dispatch and B12X `121a` dynamic dispatch remain unmeasured.

### Measurement group 2: streaming concurrency and KV cache

Ornith command:

```powershell
$env:LOCAL_AI_HUB_URL='http://127.0.0.1:18100'; $env:LOCAL_AI_MODEL='ornith-sm121-v5'; $env:AI_BENCH_OUTPUT='runtime-data/spark-phase2/evidence/spark-benchmark-ornith-baseline.json'; pnpm benchmark:spark
```

Qwen comparison command:

```powershell
$env:LOCAL_AI_HUB_URL='http://127.0.0.1:18100'; $env:LOCAL_AI_MODEL='qwen38-sm121-v5'; $env:AI_BENCH_OUTPUT='runtime-data/spark-phase2/evidence/spark-benchmark-qwen38.json'; pnpm benchmark:spark
```

Raw JSON fragments (`aggregateGenerationTokensPerSecond`, `latencyMs.p95`, and `ttftMs.p95`):

| model | c1 | c2 | c4 | c8 | c16 |
| --- | --- | --- | --- | --- | --- |
| Ornith | `70.432 tok/s; 1384.343 ms; 171.674 ms` | `107.649; 1731.386; 143.186` | `182.035; 2092.782; 147.457` | `252.059; 2836.674; 185.537` | `336.123; 4728.013; 1061.768` |
| Qwen3.8 | `12.688 tok/s; 7598.598 ms; 258.602 ms` | `25.012; 7707.877; 425.286` | `46.927; 8198.334; 632.239` | `84.574; 9092.261; 1081.269` | `136.603; 11266.275; 2104.367` |

Both reports recorded `67/67` successful requests and `0` request errors/timeouts. Max observed KV-cache ratios at c16 were Ornith `0.01465872652313327` and Qwen `0.035378662244333836`. These are report fields from the vLLM Prometheus scrape in the same benchmark command, not estimates.

### Measurement group 3: long-context prefill and TTFT

The same `pnpm benchmark:spark` commands produced these raw fields:

| target | Ornith prompt usage / tokenize / prefill mean / TTFT mean | Qwen3.8 prompt usage / tokenize / prefill mean / TTFT mean | sentinel |
| --- | --- | --- | --- |
| 4k | `4026 / 3999 / 1169.953 ms / 1185.455 ms` | `4081 / 3999 / 4380.493 ms / 4392.634 ms` | both false |
| 50k | `49962 / 49935 / 10279.262 ms / 10342.05 ms` | `50020 / 49938 / 54835.139 ms / 54918.212 ms` | both false |
| 100k | `99967 / 99940 / 18616.302 ms / 18761.578 ms` | `100020 / 99938 / 73512.634 ms / 73717.402 ms` | both false |

The sentinel validator therefore failed all three cases for both models because the model returned explanation text. The prompt usage is above 2048 and at/above the tokenizer evidence in each case; no 2048 silent truncation was observed. Do not turn the failed sentinel into a quality pass.

### Measurement group 4: Planner schema and safety gate

Ornith command:

```powershell
$env:AI_BENCH_PROVIDER='vllm'; $env:AI_BENCH_BASE_URL='http://127.0.0.1:18100'; $env:AI_BENCH_MODELS='ornith-sm121-v5'; $env:AI_BENCH_OUTPUT='runtime-data/spark-phase2/evidence/planner-benchmark-ornith-vllm-full.json'; pnpm build:control-plane; pnpm benchmark:planner-models
```

Qwen used the same command with model/output `qwen38-sm121-v5` / `planner-benchmark-qwen38-vllm-full.json`.

Raw gate fields:

| model | completed | schema-compliant | thinking suppressed | c4 p95 | hard-gate result |
| --- | ---: | ---: | ---: | ---: | --- |
| Ornith | `100/100` | `91/100` | `100/100` | `24356.253 ms` | not eligible |
| Qwen3.8 | `100/100` | `100/100` | `100/100` | `41733.586 ms` | not eligible |

Ornith is below the required 99% schema gate. Qwen's schema result passes that single gate, but its c4 memory evidence, vLLM ARM64 metadata, and private-use license gates fail closed because the vLLM APIs did not expose the required metadata. Qwen is comparison-only and does not replace the Ornith controller.

### Measurement group 5: MTP and Ollama boundary

Ornith MTP: **not measured**. The specified source checkpoint lacks MTP tensors, so no MTP on/off comparison is valid. The Qwen directory's `model_mtp.safetensors` is comparison-model material and cannot substitute for this item.

Read-only Ollama command:

```bash
curl -sS -w '\nHTTP %{http_code}\n' http://127.0.0.1:11434/api/tags
```

Raw result at 2026-08-24: a real model list followed by `HTTP 200`. This is the health criterion. No Ollama stop, restart, port change, or model change was performed. `ollama -v` or version JSON may only be described as binary-readable with port unchanged, never as service health.

## 4. Commands and tests

Executed successfully:

```text
pnpm --filter @minecraft-studio/ai-router test -- vllm-adapter.test.ts  # 61 passed
pnpm --filter @minecraft-studio/ai-router build
node --check scripts/run-planner-model-benchmark.mjs
pnpm build:control-plane
pnpm audit:spark
```

The two benchmark commands completed and wrote their JSON files; `pnpm benchmark:spark` exits non-zero when the required sentinel validation fails, while retaining the complete 67-request evidence. `pnpm benchmark:planner-models` wrote the full 100-request Qwen report.

`pnpm check` has not yet been run on this final worktree. The planner schema gate is not deployable until the recorded failures are addressed; no production deployment is claimed.

## 5. Current limits

- Only partial native SM121/121a kernel presence is proven; dynamic B12X 121a dispatch is not measured.
- Ornith Planner schema compliance is `91/100`, below the `99%` launch threshold.
- Qwen c4/memory and vLLM metadata hard gates are unavailable/fail-closed.
- Long-context sentinel validation failed for both models; usage/tokenizer evidence does not establish exact task-following quality.
- Ornith MTP is not measured because the source is text-only and has no MTP tensors.
- `docs/benchmarks/planner-model-selection-2026-08-22.md` is historical and invalid for this stage because it measured CPU/Ollama fallback rather than this v5 vLLM image.

Git provenance remains unchanged. `384e830` and `146b17e` were committed by `rennaikankk-cmyk` at `2026-08-23T19:10:17+08:00` and `19:10:26+08:00`, respectively, as a nine-second batch migration of ai-router/planner work; they are not Stage 0/1/2 delivery. Commits `02a7fba` and `ce5975e` remain preserved.

## 6. Next step

Run the final full-tree `pnpm check` on the current worktree, then review the Planner schema failures before any deployment or model promotion.
