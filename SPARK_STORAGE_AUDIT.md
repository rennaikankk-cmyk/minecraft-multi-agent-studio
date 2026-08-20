# Spark Storage Audit

Audit time: 2026-08-20 (Asia/Chongqing)

Host: `edgexpert-8820` / MSI MS-C931 / ARM64

Method: read-only `df`, `du`, `find`, Docker inventory, Git LFS inventory, Ollama manifests, and model metadata. Cache cleanup is listed separately.

## Executive result

The earlier multi-terabyte-looking usage is not evidence of DGX OS corruption. The largest single cause is a **604,620,308,480-byte (564 GiB) PassMark BurnInTest temporary file** at `/~bittest00004.txt`. Its first bytes identify it as `BurnInTest ... temp file, this file can be deleted`; it is not open by a process and is not an NVIDIA/DGX component.

The user explicitly confirmed deletion on 2026-08-20. The exact path, size, header, and lack of an open process were rechecked immediately before removal. The file was then deleted through local administrator authentication and verified absent. No model, Docker volume, Docker image, user repository, driver, CUDA component, partition, or unknown directory was deleted.

Measured immediately around the approved deletion:

| Measurement | Before deletion | After deletion |
|---|---:|---:|
| Used | 994,778,640,384 B | 390,158,495,744 B |
| Available | 2,831,193,415,680 B | 3,435,813,560,320 B |
| Use percentage | 27% | 11% |
| Released | — | **604,620,144,640 B (about 564 GiB)** |

The small difference between file length and released filesystem blocks is normal allocation metadata/block rounding. The deletion is not recoverable through this workflow.

## Filesystem summary

| Measurement | Before safe cache cleanup | After safe cache cleanup |
|---|---:|---:|
| Root filesystem | 4,030,802,149,376 B (3.7 TiB) | same |
| Used | 996,801,937,408 B (929 GiB) | 994,523,979,776 B (927 GiB) |
| Available | 2,829,170,118,656 B (2.6 TiB) | 2,831,448,076,288 B (2.6 TiB) |
| Use percentage | 27% | 26% |
| Freed | — | **2,277,957,632 B (2.12 GiB)** |

The disk is a 4 TB Samsung `MZALC4T0HBL1-00B07`; root is ext4 on `/dev/nvme0n1p2`. `/boot/efi` is a separate 512 MiB VFAT partition. The normal 16 GiB `/swap.img` is not a cleanup target.

## Largest space owners

| Owner | Size | Classification | Action |
|---|---:|---|---|
| `/~bittest00004.txt` | 564 GiB | confirmed BurnInTest temporary file | **deleted after explicit confirmation** |
| `/home/rennaikank/models` | 123 GiB | user model data | do not auto-delete |
| `/home/rennaikank/models/Huihui-Qwen3.8-27B-abliterated` | 104 GiB | BF16 model plus duplicated Git LFS objects | confirmation required |
| `/var/snap/ollama/common/models` | 52 GiB | Ollama model store | confirmation required |
| Docker images | 65.44 GB decimal | inference/UI images | confirmation required for large/unknown images |
| `/home/rennaikank/models/qwen3.8-27b-nvfp4` | 20 GiB | candidate production NVFP4 checkpoint | retain pending validation |
| `/home/rennaikank/下载` | 10.3 GiB | includes duplicate NVFP4 shard | report; do not auto-delete model data |
| `/home/rennaikank/vllm-env` | 7.7 GiB | active Python inference environment | retain pending API validation |
| `/home/rennaikank/.config/google-chrome/.../weights.bin` | 4.0 GiB | Chrome on-device model | not required for inference; no automatic delete |
| `/var/cache/apt` | 3.9 GiB | reproducible APT packages | safe candidate, but root privileges unavailable |

## Docker

| Category | Count | Size | Reclaimable |
|---|---:|---:|---:|
| Images | 5 | 65.44 GB | 44.98 GB |
| Containers | 5 stopped/created | 52.54 MB writable layer | 52.54 MB |
| Local volumes | 1 | 277.1 MB | 0 B |
| Build cache | 0 | 0 B | 0 B |

Images:

| Image | Architecture | Size | Current reference |
|---|---|---:|---|
| `vllm/vllm-openai:latest` | arm64 | 22.48 GB | `vllm-qwen-new` container |
| `nvcr.io/nvidia/vllm:26.05.post1-py3` | arm64 | 20.45 GB | no container |
| `nvcr.io/nvidia/pytorch:24.12-py3` | arm64 | 17.90 GB | two experimental containers |
| `ghcr.io/open-webui/open-webui:main` | arm64 | 4.60 GB | two containers; one named volume |
| `alpine:latest` | arm64 | 8.66 MB | no container |

The only Docker volume is `rennaikank_open-webui-data` (277.1 MB). It was not deleted. The old containers bind model directories read-write; any future inference profile should change production model mounts to read-only.

## Model and AI cache inventory

| Store | Size after cleanup | Notes |
|---|---:|---|
| Hugging Face global cache | 12 KiB | no large global HF cache |
| Local NVFP4 model directory | 20.60 GB | direct local-dir download with HF metadata |
| Ollama model blobs | 55.59 GB | two aliases share the same blobs |
| vLLM environment | 8.22 GB | vLLM 0.27.1, Transformers 5.15.1, Torch 2.13.0+cu130 |
| vLLM compile cache | 243.3 MB | retained to avoid needless GB10 kernel recompilation |
| pip cache | 9.1 MB | reduced from 1.77 GB |
| npm cache | 28 KiB | reduced from 239 MB |
| pnpm store | 877.4 MB | pruned; most remaining packages are registered/referenced |
| Rust/Cargo caches | not present at material size | no cleanup needed |
| `/tmp` | about 46 MB | active desktop/application temp files; retained |
| system journal | 145.9 MB | normal; retained |

## Safe cleanup performed

Only package-manager caches known to be reproducible were cleaned:

1. `python3 -m pip cache purge` — 1,360 HTTP cache files.
2. `npm cache clean --force` — npm content cache.
3. `pnpm store prune` — 18.7 MB plus stale metadata/unreferenced packages.

Total filesystem reduction measured by `df`: **2.12 GiB**. No source tree, dependency installation used by the project, model, Docker object, database, credential, or user document was removed.

## Top 20 largest directories

The table intentionally includes parents and children so the ownership chain is visible.

| Rank | Bytes | Path |
|---:|---:|---|
| 1 | 163,881,529,344 | `/home` |
| 2 | 163,881,525,248 | `/home/rennaikank` |
| 3 | 131,769,552,896 | `/home/rennaikank/models` |
| 4 | 111,165,960,192 | `/home/rennaikank/models/Huihui-Qwen3.8-27B-abliterated` |
| 5 | 65,201,795,072 | `/var` |
| 6 | 55,604,707,328 | `/var/snap` |
| 7 | 55,589,961,728 | `/var/snap/ollama` |
| 8 | 55,589,953,536 | `/var/snap/ollama/common` |
| 9 | 20,603,572,224 | `/home/rennaikank/models/qwen3.8-27b-nvfp4` |
| 10 | 17,846,743,040 | `/usr` |
| 11 | 11,066,421,248 | `/home/rennaikank/下载` |
| 12 | 8,217,653,248 | `/home/rennaikank/vllm-env` |
| 13 | 8,185,368,576 | `/home/rennaikank/vllm-env/lib` |
| 14 | 6,846,394,368 | `/usr/lib` |
| 15 | 5,508,825,088 | `/home/rennaikank/.config` |
| 16 | 5,026,635,776 | `/usr/local` |
| 17 | 4,976,775,168 | `/usr/local/cuda-13.0` |
| 18 | 4,888,846,336 | `/var/lib` |
| 19 | 4,502,581,248 | `/home/rennaikank/.config/google-chrome` |
| 20 | 4,378,406,912 | `/usr/share` |

## Top 20 largest files (pre-deletion audit snapshot)

| Rank | Bytes | Path / meaning |
|---:|---:|---|
| 1 | 604,620,308,480 | `/~bittest00004.txt` — BurnInTest temp |
| 2 | 54,658,726,016 | `/var/snap/ollama/.../sha256-b87d...` — shared model blob |
| 3 | 17,179,869,184 | `/swap.img` — normal swap |
| 4 | 9,972,755,048 | `/home/rennaikank/下载/model-00001-of-00002.safetensors` — exact duplicate |
| 5 | 9,972,755,048 | NVFP4 `model-00001-of-00002.safetensors` |
| 6 | 9,770,946,240 | NVFP4 `model-00002-of-00002.safetensors` |
| 7 | 4,269,932,544 | Chrome `OptGuideOnDeviceModel/.../weights.bin` |
| 8 | 3,988,973,120 | BF16 shard 04 |
| 9 | 3,988,973,120 | Git LFS object for BF16 shard 04 |
| 10 | 3,979,564,008 | BF16 shard 16 |
| 11 | 3,979,564,008 | Git LFS object for BF16 shard 16 |
| 12 | 3,979,553,664 | BF16 shard 14 |
| 13 | 3,979,553,664 | BF16 shard 12 |
| 14 | 3,979,553,664 | BF16 shard 10 |
| 15 | 3,979,553,664 | BF16 shard 08 |
| 16 | 3,979,553,664 | BF16 shard 06 |
| 17 | 3,979,553,664 | Git LFS object for BF16 shard 14 |
| 18 | 3,979,553,664 | Git LFS object for BF16 shard 12 |
| 19 | 3,979,553,664 | Git LFS object for BF16 shard 10 |
| 20 | 3,979,553,664 | Git LFS object for BF16 shard 08 |

The same LFS duplication pattern continues across all 18 BF16 shards; see `DUPLICATE_MODEL_REPORT.md`.

## Accepted model/cache roots

Final Spark layout:

```text
AI_MODEL_ROOT=/home/rennaikank/models
AI_CACHE_ROOT=/home/rennaikank/ai-cache
```

Recommended policy:

- Keep ownership restricted to the inference service account and pre-create the cache subdirectories before enabling the hardened service.
- Read the selected production checkpoint without write access from the service; use read-only mounts if a container replaces the verified host service.
- Set `HF_HOME`, `VLLM_CACHE_ROOT` and conversion scratch directories under `AI_CACHE_ROOT`.
- The current 20+ GB model already lives under the accepted root, so no large move or duplicate is required.
- Keep exactly one production checkpoint after smoke/compatibility validation; conversion sources and temporary copies must have an owner and deletion date.

## Confirmation-gated candidates

| Candidate | Expected release | Risk | Recoverability | Recommendation |
|---|---:|---|---|---|
| `/~bittest00004.txt` | 564 GiB | low; confirmed benchmark temp | deleted; not recoverable through this workflow | **completed after explicit approval** |
| BF16 repo worktree + LFS duplication | up to 104 GiB | medium; conversion/source fallback lost locally | re-download from HF, about 52 GiB | API passed, but retain until native-FP4/backend decision, then request approval |
| Ollama model store | 52 GiB | medium; Ollama aliases stop working | re-pull about 52 GiB | remove after vLLM is selected and validated |
| Docker reclaimable images | about 42 GiB | medium; old experiments cannot restart locally | re-pull images | decide image-by-image after backend selection |
| duplicate download shard | 9.3 GiB | low; byte-identical to model shard | existing model copy remains | safe candidate, but model-file rule requires approval |
| Chrome on-device model | 4.0 GiB | low/medium; browser may re-download | re-download by Chrome | optional, not needed for Spark inference |
| APT cache | 3.9 GiB | low | packages can be re-downloaded | clean later with administrator privileges |

## Never-delete boundaries

Do not remove or modify as part of storage cleanup:

- `/usr/local/cuda-13.0`, NVIDIA packages under `/usr` and `/opt/nvidia`
- `/boot`, `/boot/efi`, `/etc`, `/var/lib/dpkg`, kernel modules, firmware
- `/swap.img` without a separate system-memory plan
- Docker volumes, databases, SSH keys, Git repositories, or unknown user files without confirmation
- the selected production model before a tested replacement is active
