# Deployment profiles

These files describe host ownership and safe defaults; they contain no real
credentials. Copy only the profile for the current host into private runtime
secret/config storage, then merge the required authenticated link settings from
the repository root `.env.example`.

- `dev-spark.env.example`: temporary all-local development on Spark.
- `controller-u9.env.example`: U9 owns Minecraft and all control-plane services.
- `inference-spark.env.example`: Spark owns only the vLLM inference service and
  necessary metrics.

The 2026-08-20 exact-model Spark matrix produced the checked-in profile value
`AI_MAX_CONCURRENCY=4`. This is measured configuration, not a core-code default.
Reset it to empty and re-benchmark after changing model, backend, kernel,
context, MTP, prefix caching or per-request metrics. Never commit completed
secret-bearing copies.
