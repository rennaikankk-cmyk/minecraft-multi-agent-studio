# Spark inference-node setup

## Audited host state (2026-08-20)

- MSI MS-C931 / NVIDIA GB10 / ARM64 / 128 GB-class unified memory
- Ubuntu 24.04.4, kernel 6.17, driver 580.173.02, CUDA 13.0
- Docker 29.2.1, NVIDIA Container Toolkit 1.20.0
- CDI GPU container test passed with `--device=nvidia.com/gpu=all`
- installed Python environment: vLLM 0.27.1, Transformers 5.15.1,
  Torch 2.13.0+cu130
- selected validation candidate:
  `/home/rennaikank/models/qwen3.8-27b-nvfp4` (20.60 GB)

See `SPARK_STORAGE_AUDIT.md` and `DUPLICATE_MODEL_REPORT.md` before changing
storage. The 564 GiB BurnInTest file and all model/image cleanup remain
confirmation-gated.

## Preflight

```bash
nvidia-smi
docker version
nvidia-ctk cdi list
source /home/rennaikank/vllm-env/bin/activate
python -c 'import vllm, torch, transformers; print(vllm.__version__, torch.__version__, transformers.__version__)'
```

Do not update the driver, CUDA, kernel, vLLM, or checkpoint together. Record one
change per validation cycle so rollback remains possible.

## First model-load candidate (not yet executed)

The installed CLI confirms support for `--language-model-only`,
`--gpu-memory-utilization`, `--max-num-seqs`, prefix caching, quantization, and
selectable linear backends. The local metadata identifies ModelOpt
`W4A16_NVFP4`. Current vLLM documentation names the checkpoint mode
`modelopt_fp4` and auto-selects an available kernel.

Start conservatively in a private terminal, with MTP disabled:

```bash
source /home/rennaikank/vllm-env/bin/activate
export VLLM_API_KEY='<generate and store outside Git>'
vllm serve /home/rennaikank/models/qwen3.8-27b-nvfp4 \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key "$VLLM_API_KEY" \
  --served-model-name qwen3.8-27b-nvfp4 \
  --trust-remote-code \
  --language-model-only \
  --quantization modelopt_fp4 \
  --gpu-memory-utilization 0.70 \
  --max-model-len 8192 \
  --max-num-seqs 4 \
  --enable-prefix-caching
```

This is a **candidate command**, not a recorded pass. Capture the full startup
log, selected kernel/backend, memory pressure, and any fallback warning. Do not
force `--linear-backend` until auto-selection is observed. If vLLM rejects the
checkpoint, stop and diagnose; do not patch installed libraries ad hoc.

Official guidance warns that unified-memory devices can OOM under aggressive
default allocation, so the first run uses 0.70. Official vLLM docs also state
that unsupported native FP4 kernels can fall back to W4A16/Marlin; a successful
load alone therefore does not prove native NVFP4 acceleration.

References: [NVIDIA Spark vLLM playbook](https://build.nvidia.com/spark/vllm),
[vLLM ModelOpt NVFP4 docs](https://docs.vllm.ai/en/v0.27.0/features/quantization/modelopt/),
[NVIDIA vLLM unified-memory known issue](https://docs.nvidia.com/deeplearning/frameworks/vllm-release-notes/rel-26-07.html).

## Health and rollback

```bash
curl -fsS -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/health
curl -fsS -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/v1/models
nvidia-smi
```

Stop with `Ctrl+C` for the first foreground validation. This leaves the model,
environment, and existing Docker objects intact. Do not configure automatic
restart until cold start, structured output, benchmark, and restart all pass.

## Network policy for the U9 cutover

- Prefer wired Ethernet; measured Wi-Fi address `192.168.5.27` is not the final
  production plan.
- Assign stable private addresses after inspecting the real adapter/subnet.
- Allow TCP 8000 only from the U9 controller address; never expose it to WAN.
- Keep SSH key authentication and restrict port 22 to the management subnet.
- Put API keys only in process/service secret storage, never `.env` committed to
  Git.
- Add TLS or an authenticated reverse proxy before crossing an untrusted network.

Final address, MTU, firewall backend, and link speed are `NOT_VERIFIED` until the
U9 arrives.
