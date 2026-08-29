# DGX Spark: Ornith Heretic deployment

This runbook deploys the community Ornith Heretic checkpoint as a project-owned
vLLM service on the DGX Spark. It does not install Minecraft, Mineflayer,
PostgreSQL, Redis, a dashboard, or a web UI on the Spark. The checked-in
Compose file is intentionally parameter-only:

```text
configs/spark/ornith-heretic.compose.yml
```

The old `configs/spark/vllm-sm121.compose.override.yml` remains the rollback
configuration for the previously measured text-only controller. Do not delete
its container or model directory.

## Deployment contract

Before a start is attempted, all of the following must be known and recorded:

- an ARM64 registry digest pinned with `@sha256:<64 hex characters>`, or an
  immutable local `sha256:<64 hex characters>` image ID when the audited local
  build has no registry digest;
- the exact model Git revision (full commit SHA), with one model directory for
  that revision only;
- a directory containing only the verified Safetensors artifact and model
  configuration;
- a dedicated writable vLLM cache directory (not a second model copy);
- a separate API-key env file with mode `0600`;
- a Spark bind address that was observed with `ip addr` and is reachable only
  from the trusted U9/LAN; and
- a chosen deployment profile: `canary` (0.85, port 8001, no auto-restart) or `production`
  (0.90, port 8000).

The target address `192.168.50.2` is not assumed. Verify it on the Spark first.
Use `127.0.0.1` while the address is uncertain. The service listens on port
8000 inside the container; the host port and host bind address are profile
parameters.

## Prepare private files

Run these commands on the Spark from a checkout of this repository. Keep the
private files outside Git and use absolute paths in the profile file:

```bash
install -d -m 0750 /home/rennaikank/studio-private
install -d -m 0750 /home/rennaikank/vllm-cache/ornith15-heretic
cp configs/spark/ornith-heretic.canary.env.example \
  /home/rennaikank/studio-private/ornith-heretic.canary.env
cp configs/spark/ornith-heretic.api-key.env.example \
  /home/rennaikank/studio-private/ornith-heretic.api-key.env
chmod 0640 /home/rennaikank/studio-private/ornith-heretic.canary.env
chmod 0600 /home/rennaikank/studio-private/ornith-heretic.api-key.env
```

Edit the private canary file and set `SPARK_VLLM_IMAGE`,
`SPARK_MODEL_REVISION`, `SPARK_MODEL_PATH`, `SPARK_CACHE_PATH`, and
`SPARK_API_KEY_ENV_FILE`. The API key file must contain exactly the private
variable used by the Compose entrypoint:

```text
VLLM_API_KEY=<value kept only on the Spark>
```

Do not put the key in the profile file, shell history, Git, or a command-line
argument. vLLM 0.27.1 reads `VLLM_API_KEY` directly from its environment; the
Compose entrypoint deliberately does not add it to process arguments. Check
permissions without printing contents:

```bash
stat -c '%a %n' /home/rennaikank/studio-private/ornith-heretic.api-key.env
```

## Verify the immutable inputs

The following checks are read-only. Replace the image and model values with
the values in the private profile, without echoing the API-key file:

```bash
(
set -a
. /home/rennaikank/studio-private/ornith-heretic.canary.env
set +a

if [[ ! "$SPARK_VLLM_IMAGE" =~ (^sha256:|@sha256:)[0-9a-fA-F]{64}$ ]]; then
  echo 'image must be a registry digest or immutable local image ID' >&2
  exit 1
fi
test "${#SPARK_MODEL_REVISION}" -eq 40
test -d "$SPARK_MODEL_PATH"
test -d "$SPARK_CACHE_PATH"
test "$(stat -c '%a' "$SPARK_API_KEY_ENV_FILE")" = 600

docker image inspect "$SPARK_VLLM_IMAGE" \
  --format 'image={{.Id}} os={{.Os}} arch={{.Architecture}}'
docker image inspect "$SPARK_VLLM_IMAGE" \
  --format '{{range .RepoDigests}}{{println .}}{{end}}'
find "$SPARK_MODEL_PATH" -maxdepth 1 -type f -printf '%f\n' | sort
find "$SPARK_MODEL_PATH" -maxdepth 1 -type f \
  ! -name '*.safetensors' ! -name '*.json' ! -name '*.jinja' \
  ! -name '*.md' ! -name '*.txt' -print
)
```

The final `find` command must produce no unexpected pickle or binary file.
Safetensors shard opening and key traversal are a separate model acceptance
gate; a successful container start is not evidence that the artifact is intact.
Do not use a floating tag, `latest`, or a second Hugging Face cache copy.

Confirm the runtime arguments before starting. The pinned Spark image used for
this deployment line was inspected as ARM64/aarch64 with vLLM 0.27.1,
Transformers 5.15.0, Torch 2.13.0+cu130, and GB10 capability `(12,1)`. Run
the same checks against the exact digest selected in the profile:

```bash
docker run --rm --gpus all "$SPARK_VLLM_IMAGE" vllm --version
docker run --rm --gpus all "$SPARK_VLLM_IMAGE" vllm serve --help \
  | grep -E -- '--(api-key|safetensors-load-strategy|limit-mm-per-prompt|speculative-config|tool-call-parser|reasoning-parser|enable-auto-tool-choice|enable-prefix-caching|enable-chunked-prefill|kv-cache-dtype)'
```

The command must show the arguments used below. If the help output differs,
stop and update the command only after checking the exact image version.

Run the project preflight against the selected profile. It does not contact
Docker or start anything; it checks the immutable inputs, trusted bind, profile
resource values, explicit MTP/vision settings, model/cache directories, and API-key mode
without printing the key:

```bash
node scripts/validate-spark-ornith-deployment.mjs \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env
```

The expected result is `Spark Ornith deployment preflight: PASS`. A failure is
an intentional start gate; fix the private profile or artifact and rerun it.

## Render and start the 0.85 canary

Render the Compose model first. This catches missing paths and mutable image
references without creating a container:

```bash
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env \
  -f configs/spark/ornith-heretic.compose.yml config --quiet
```

Inspect the rendered command without resolving the API-key env file. This keeps
the secret out of terminal output while allowing the resource values to be
checked:

```bash
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env \
  -f configs/spark/ornith-heretic.compose.yml config --no-env-resolution \
  | grep -E -- 'gpu-memory-utilization|max-num-batched-tokens|speculative-config|limit-mm-per-prompt|published:'
```

Ensure it contains `--gpu-memory-utilization 0.85`,
`--max-num-batched-tokens 32768`, FP8 KV cache, MTP with two speculative tokens, one
image, and zero video before starting. Do not run an unfiltered
`docker compose config` after
putting a real key in the env file: some Compose versions resolve and print
service environment values. The command uses:

```text
--max-model-len 262144
--max-num-seqs 16
--max-num-batched-tokens 32768
--gpu-memory-utilization 0.85
--kv-cache-dtype fp8
--enable-prefix-caching
--enable-chunked-prefill
--reasoning-parser qwen3
--tool-call-parser qwen3_xml
--enable-auto-tool-choice
--safetensors-load-strategy prefetch
--limit-mm-per-prompt {"image":1,"video":0}
```

The target revision contains no `mtp.*`-prefixed tensor keys, despite its
README and config claims. That static observation is not sufficient to decide
runtime support: the pinned vLLM 0.27.1 image resolved `Qwen3_5MoeMTP`, loaded
the drafter, shared the target embedding and LM-head weights, and produced
positive speculative draft-token counters with two speculative tokens. The
deployable profiles therefore set `SPARK_MTP_EXPECTED=true` and pass
`{"method":"mtp","num_speculative_tokens":2}`. They omit
`--trust-remote-code` because the fixed repository contains no Python or
custom modeling files.

Start only the project-owned service:

```bash
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env \
  -f configs/spark/ornith-heretic.compose.yml up -d ornith-heretic
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env \
  -f configs/spark/ornith-heretic.compose.yml ps
```

The Compose healthcheck waits for both `/health` and the expected model ID in
`/v1/models`, authenticated with the private key. Verify from the U9 or Spark
without printing the key. One safe pattern is to load the key into an
ephemeral shell variable and unset it immediately after the probes:

```bash
set -a
. /home/rennaikank/studio-private/ornith-heretic.canary.env
. /home/rennaikank/studio-private/ornith-heretic.api-key.env
set +a
base_url="http://${SPARK_BIND_ADDRESS}:${SPARK_HOST_PORT}"
unauth_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/v1/models")"
case "$unauth_status" in 401|403) ;; *) exit 1 ;; esac
curl -fsS "$base_url/health"
curl -fsS -H "Authorization: Bearer $VLLM_API_KEY" \
  "$base_url/v1/models"
curl -fsS -H "Authorization: Bearer $VLLM_API_KEY" \
  "$base_url/metrics" | head -c 2000
unset VLLM_API_KEY base_url unauth_status
```

Use `/v1/chat/completions` for a non-streaming and a streaming smoke request,
then run the repository benchmark and planner/tool gates. Do not call the
service ready based on `/health` alone.

## Runtime and MTP evidence

The immutable model index has 124,376 keys, including 333 `model.visual.*`
keys, but zero `mtp.*`-prefixed keys. Runtime evidence on the pinned image is
authoritative for this packaging layout: vLLM resolved `Qwen3_5MoeMTP`, loaded
the drafter, completed warmup, returned a correct completion, and incremented
both draft and draft-token counters with `num_speculative_tokens=2`. Preserve
the startup log, request result, and before/after speculative metric values for
each accepted profile. A config field or model-card tag alone is not enough;
positive runtime counters and a successful response are required.

The same evidence must record actual process/device memory, KV-cache usage,
temperature, power, and any CUDA/Xid/OOM messages. The old official Ornith
112--114 GiB estimate is not a Heretic measurement.

## 0.90 performance profile and production cutover

Only after every 0.85 gate passes, prepare a separate private profile:

```bash
cp configs/spark/ornith-heretic.production.env.example \
  /home/rennaikank/studio-private/ornith-heretic.production.env
chmod 0640 /home/rennaikank/studio-private/ornith-heretic.production.env
```

Set the same image digest, model revision, model path, cache path, and API-key
file. The production template changes only the deployment identity, host port
(`8000`), batch-token ceiling (`65536`), and GPU utilization (`0.90`). Render
and inspect it before starting. Never start canary and production together on
the same GPU:

```bash
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.canary.env \
  -f configs/spark/ornith-heretic.compose.yml stop ornith-heretic
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.production.env \
  -f configs/spark/ornith-heretic.compose.yml up -d ornith-heretic
```

The 0.90 profile must repeat health, concurrency, long-context, tool-call,
memory, and 30-minute pressure gates. Immediately revert to the canary values
if MemAvailable falls below 6 GiB, swap grows, CUDA OOM/Xid appears, a restart
occurs, tool/JSON quality degrades, P95 regresses materially, or throughput
improves by less than 5%.

## Stop and rollback

Stop the Heretic service without deleting the model or cache:

```bash
docker compose \
  --env-file /home/rennaikank/studio-private/ornith-heretic.production.env \
  -f configs/spark/ornith-heretic.compose.yml stop ornith-heretic
```

To roll back to the previous project-owned controller, use its saved profile
and command from `docs/runbooks/dgx-spark-vllm-sm121-stage4.md`. Do not run
`docker system prune`, remove unrelated containers, or touch Ollama/port
`11434`. Keep the old container stopped but recoverable until the Heretic
acceptance and restart gates are complete.

## Troubleshooting boundaries

- A missing registry digest or immutable local image ID is a configuration
  failure; do not pull an unverified replacement automatically.
- A missing model path, a non-40-character revision, or an unexpected pickle
  file is an artifact failure; do not delete the existing model directories.
- A bind error for `192.168.50.2` means that address is not present on the
  Spark interface. Revert to loopback and verify networking; do not guess a
  route or expose the API publicly.
- A vLLM argument error means the image/help contract changed. Preserve the
  logs, check the exact digest, and adjust only to an argument shown by that
  image's help output.
- CUDA OOM, Linux OOM-killer, or NVIDIA Xid messages are hard acceptance
  failures. Stop the new service and preserve the evidence; do not repair them
  by changing drivers, CUDA, kernel, or DGX OS as part of this runbook.
