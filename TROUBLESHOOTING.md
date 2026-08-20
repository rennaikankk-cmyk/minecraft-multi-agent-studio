# Troubleshooting

## pnpm rejects Node

The repository needs Node 22+. On the audited Spark host:

```bash
export PATH=/home/rennaikank/.nvm/versions/node/v22.23.2/bin:$PATH
node --version
pnpm --version
```

Do not upgrade pnpm or regenerate the lockfile merely to bypass an engine error.

## Playwright browser executable is missing

Use an already-installed browser when available:

```bash
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
```

A browser download may be large; do not start one implicitly.

## vLLM health fails

Check the foreground startup log first, then:

```bash
curl -v http://127.0.0.1:8000/health
curl -v http://127.0.0.1:8000/v1/models
nvidia-smi
```

If API-key protection is enabled, supply the bearer token. Confirm the exact
served model ID. Do not disable authentication or open the firewall broadly to
make a health check pass.

## GB10 memory fields are N/A

This is expected for some `nvidia-smi --query-gpu` fields on unified-memory
systems. Use plain `nvidia-smi`, host memory observation, vLLM logs, and benchmark
success/error/latency. The benchmark records unsupported fields as `null`.

## NVFP4 loads but performance is poor

Inspect the startup log for the selected linear backend or a W4A16/Marlin
fallback. A checkpoint labeled NVFP4 and a successful load do not prove native
FP4 execution. Keep backend auto-selection for the first run, benchmark it, then
change one flag at a time.

## Model load OOMs

Stop the process and confirm it released memory. Start with the conservative
settings in `SPARK_SETUP.md` (`--gpu-memory-utilization 0.70`, context 8192,
`--max-num-seqs 4`, MTP off). Do not delete another model, swap, caches, or Docker
volumes as an OOM workaround.

## AI plan is rejected as stale

This is expected when Bot status or task version advances during inference.
Request a new plan from the latest state. Do not reuse or force-apply the old
proposal.

## AI proposes an unavailable skill

Coordinator rejects it by design. Inspect the current version-bound skill
catalog and compatibility reasons. Never add an authorization merely to satisfy
the model response.

## Coordinator/API refuses startup

Current links are fail-closed. Verify peer/client JSON shape, unique IDs,
permissions, SHA-256 values, and matching runtime secrets from `.env.example`.
Do not put plaintext secrets into the JSON config or repository.

## Task integration tests skip

The isolated PostgreSQL/Redis variables are absent or rejected. Follow
`TESTING.md`; never point the test runner at production data.

## Disk still appears large

Read `SPARK_STORAGE_AUDIT.md`. The 564 GiB PassMark BurnInTest temporary file is
still present unless the operator explicitly approved its deletion. Models,
Docker images/volumes, and other confirmation-gated data were deliberately not
removed.
