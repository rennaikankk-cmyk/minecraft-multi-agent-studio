# Duplicate Model Report

Audit time: 2026-08-20

Status: **report only — no model weight was deleted**

## Summary

Three Qwen3.8-27B families are present, plus one exact shard duplicate. They are not all bit-identical model derivatives. The existing NVFP4 checkpoint has now passed model load, health, strict API output, restart, real 1/2/4/8/10 concurrency and a 30.04-minute soak with 612/612 successful requests. The current software stacks still use weight-only Marlin instead of native GB10 FP4, so the safe sequence is:

1. Retain the verified NVFP4 checkpoint as the serving candidate.
2. Keep the BF16/source fallback until the native-FP4/backend decision is made.
3. Only then request explicit approval to remove the BF16 + Git LFS copy, Ollama copy, or download shard.

## Inventory

| Model / copy | Format | Size | Path / source | Duplicate status | Recommendation |
|---|---|---:|---|---|---|
| `hwkranger/Qwen3.8-27B-heretic-ara-NVFP4` | ModelOpt W4A16 NVFP4, packed U8 weights + FP8/F32 scales; BF16 exclusions/MTP | 20.60 GB | `/home/rennaikank/models/qwen3.8-27b-nvfp4`; download metadata revision `7cb13049d41143cc29c55936388a017665ed5ab8` | verified serving candidate; different abliteration lineage from Huihui | **retain** |
| `huihui-ai/Huihui-Qwen3.8-27B-abliterated` working tree | BF16 safetensors, 18 shards | about 55.58 GB | `/home/rennaikank/models/Huihui-Qwen3.8-27B-abliterated`; Git commit `d42ca8978c5a66e92c3446d46e8adfe03ef692ff` | source/fallback; not the same derivative as heretic-ara | retain only until NVFP4 validation decision |
| Same Huihui repo Git LFS objects | exact byte copies of the 18 checked-out BF16 shards | 55.58 GB | `.git/lfs/objects/*` inside the Huihui directory | **confirmed physical duplicate**: different inodes, identical LFS SHA-256 IDs and sizes | remove only through an approved model-repository cleanup |
| Ollama `qwen3.8-27b-abliterated:latest` | Ollama blob | 55.59 GB including projector | `/var/snap/ollama/common/models` | functional duplicate of a Qwen3.8 abliterated serving copy | remove after vLLM selection, with approval |
| Ollama `qwen-fast:latest` | alias manifest | negligible extra bytes | same Ollama store | not a second weight copy; points to the same blob digests | deleting alias alone releases almost nothing |
| NVFP4 shard in Downloads | safetensors shard | 9,972,755,048 B | `/home/rennaikank/下载/model-00001-of-00002.safetensors` | **exact duplicate** of NVFP4 shard 1; `cmp` returned identical | delete only after approval |

## Evidence that the NVFP4 candidate is not merely named “4-bit”

Local metadata and safetensors headers show:

- `config.json`: `quant_method = modelopt`, 4-bit float weights, group size 16, `Linear` targets.
- `hf_quant_config.json`: `quant_algo = W4A16_NVFP4`, group size 16.
- Weight tensors: 400 packed `U8` weight tensors across the two main shards, paired with `F8_E4M3` and `F32` scale tensors.
- Exclusions remain BF16, including embeddings, `lm_head`, vision tower, selected linear-attention tensors, and `mtp*`.
- `model_mtp.safetensors` exists (849,400,392 B) and contains 15 BF16 MTP tensors.
- Architecture: `Qwen3_5ForConditionalGeneration` / `qwen3_5_text`, 64 layers, hidden size 5120, vocabulary 248320.
- The two main shards and MTP file are present and indexed.

This is strong local evidence of an actual NVIDIA ModelOpt NVFP4 checkpoint. End-to-end vLLM load/API/restart/concurrency and 30-minute soak tests on this exact host have passed. That validates the ModelOpt checkpoint and API path, not native FP4 compute: both tested stacks selected `MarlinNvFp4LinearKernel` and reported weight-only fallback.

## BF16/LFS physical duplication

Example shard 1:

```text
working tree inode: 13384224, size 3,966,730,520
LFS object inode:   13383074, size 3,966,730,520
LFS SHA-256:        746142a26219375775e31233a25b9d06bb50cc36a45b833dfad58d45bbeb68ac
```

The inodes differ and both have one hard-link, so the filesystem stores both copies. `git lfs ls-files -l` maps all 18 worktree shards to matching LFS object hashes. The repository also has an untracked 131-byte `Modelfile`; cleanup must preserve or intentionally archive it.

## Ollama alias relationship

Both manifests refer to the same large digests:

```text
model:     sha256-b87dfcd... 54,658,726,016 B
projector: sha256-d466586...    931,145,568 B
```

Therefore the two Ollama names do not consume 2 × 55 GB. Removing only `qwen-fast` would not materially free space.

## Selected serving-weight outcome

```text
/home/rennaikank/models/qwen3.8-27b-nvfp4/
```

Retain:

- one verified NVFP4 production checkpoint;
- its tokenizer/config/license/model-card files;
- a recorded repository ID and immutable revision;
- MTP weights, but keep MTP disabled until mixed prefill/decode stability is tested.

Cleanup candidates after explicit approval:

| Candidate | Estimated release |
|---|---:|
| BF16 worktree + its local LFS objects | about 104 GiB |
| Ollama shared Qwen blobs | about 52 GiB |
| duplicate downloaded NVFP4 shard | 9.3 GiB |
| **Potential model-related total** | **about 165 GiB** |

Those functional gates have passed, but native FP4 is still blocked and no model deletion has been approved. Do not execute the cleanup without a separate explicit confirmation that names each target, size, risk and recovery method.
