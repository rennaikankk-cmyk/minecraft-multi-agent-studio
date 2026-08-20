# MSI DGX Spark inference-node runbook

## Verified host state — 2026-08-20

- MSI MS-C931, NVIDIA GB10, ARM64, 128 GB-class unified memory
- Ubuntu 24.04.4, kernel 6.17.0-1029-nvidia
- driver 580.173.02, CUDA 13.0
- Docker 29.2.1, NVIDIA Container Toolkit 1.20.0; CDI GPU test passed
- host vLLM 0.27.1, Transformers 5.15.1, Torch 2.13.0+cu130
- SSD: 3.7 TiB total, about 364 GiB used, 3.2 TiB available after cleanup
- production candidate: `/home/rennaikank/models/qwen3.8-27b-nvfp4`, 20.60 GB
- checkpoint revision recorded by Hugging Face cache:
  `7cb13049d41143cc29c55936388a017665ed5ab8`

See `SPARK_STORAGE_AUDIT.md` and `DUPLICATE_MODEL_REPORT.md` before changing
storage. The confirmed BurnInTest file was removed earlier; no model, user
Docker Volume, driver, CUDA, or unknown container/image was deleted. Temporary
PostgreSQL/Redis acceptance containers and their two known test images were
removed after their tests; no Docker Volume was created.

## Storage policy

```text
AI_MODEL_ROOT=/home/rennaikank/models
AI_CACHE_ROOT=/home/rennaikank/ai-cache
```

Keep one accepted production weight set. Do not move or delete the current
checkpoint until a replacement has a recorded repository, revision, hash,
backend, kernel, quality test, and rollback result. Never delete SSH keys,
`/var/lib/docker`, the user Docker Volume, DGX OS, driver, or CUDA directories as
cache cleanup.

## Verified foreground start

MTP remains off. Activating the venv is required because its `ninja` executable
is needed by FlashInfer JIT:

```bash
source /home/rennaikank/vllm-env/bin/activate
vllm serve /home/rennaikank/models/qwen3.8-27b-nvfp4 \
  --host 127.0.0.1 \
  --port 8000 \
  --served-model-name qwen3.8-27b-nvfp4 \
  --trust-remote-code \
  --language-model-only \
  --quantization modelopt_fp4 \
  --gpu-memory-utilization 0.70 \
  --max-model-len 8192 \
  --max-num-seqs 4 \
  --enable-prefix-caching \
  --enable-per-request-metrics
```

This exact loopback command passed cold start, structured output, concurrency,
restart and a 30.04-minute soak (612/612, zero errors). Stop the foreground process with `Ctrl+C`. It consumes about
17.91 GiB for model loading and configures about 65 GiB of KV cache at 0.70.

Before exposing the service to U9, bind only the verified wired private
interface/firewall scope and add `--api-key`. Do not use `0.0.0.0` without a
source-restricted firewall and runtime secret.

## Health, metrics, benchmark

```bash
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:8000/v1/models
curl -fsS http://127.0.0.1:8000/version
curl -fsS http://127.0.0.1:8000/metrics

export AI_BASE_URL=http://127.0.0.1:8000/v1
export AI_MODEL=qwen3.8-27b-nvfp4
export AI_QUANTIZATION=modelopt_fp4
export AI_MAX_CONCURRENCY=4
pnpm ai:health
pnpm ai:test
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

See `AI_BENCHMARK.md` for the recorded result.

## Kernel verdict

The files and runtime both identify ModelOpt `W4A16_NVFP4`; this is not a fake
4-bit/GGUF checkpoint. However:

- host vLLM 0.27.1 selected `MarlinNvFp4LinearKernel`;
- NVIDIA vLLM 26.05.post1 also warned that native FP4 computation was
  unavailable and used weight-only Marlin.

Therefore API functionality and performance are validated, while the requested
**native/TRUE NVFP4 compute path is BLOCKED** on the installed stacks. Do not
silently switch models. Resolve by testing a documented GB10/sm_121 native
kernel build in an isolated environment, then repeat the full benchmark. Do not
upgrade driver, CUDA, and vLLM together.

## Service lifecycle template

The committed profile is `profiles/inference-spark.env.example`; the hardened
unit template is `deploy/systemd/minecraft-studio-vllm.service.example`.
Install completed copies under `/etc/minecraft-studio/` only after U9 network,
API key, firewall, and kernel decisions are approved.

Before first service start, pre-create the configured `AI_CACHE_ROOT`/vLLM/HF
cache directories owned by the service user and make the completed environment
file mode `0600`. The unit reads `VLLM_API_KEY` from that protected environment
file; it deliberately does not place the key in `ExecStart`/the process list.
`VLLM_CACHE_ROOT`, `XDG_CACHE_HOME`, `CUDA_CACHE_PATH` and
`FLASHINFER_WORKSPACE_BASE` point writable compiler/kernel/backend state into
`/home/rennaikank/ai-cache`, the only home path reopened by the strict unit.

```bash
sudo systemctl daemon-reload
sudo systemctl start minecraft-studio-vllm
sudo systemctl status minecraft-studio-vllm --no-pager
sudo systemctl restart minecraft-studio-vllm
sudo systemctl stop minecraft-studio-vllm
```

Use `enable` only after cold-start/restart/soak and U9 connectivity pass. Roll
back by stopping/disabling the unit; keep weights and caches intact.

## U9 connection policy

- wired private Ethernet only; final IP, MTU, firewall backend, and link speed
  remain `NOT_VERIFIED` until U9 arrives;
- allow TCP 8000 only from the U9 controller;
- never expose vLLM or metrics to WAN;
- keep API keys in OS secret storage, never committed env files;
- Spark runs inference and necessary monitoring only—no Minecraft, Bots,
  Coordinator, PostgreSQL, Redis, Dashboard, IDE, or business logs.
