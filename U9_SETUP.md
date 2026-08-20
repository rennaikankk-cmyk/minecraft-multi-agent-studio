# Intel U9 285H controller-node setup

Status: hardware-dependent validation pending. No U9 result is claimed before
the machine arrives.

## Read-only inventory first

Run in PowerShell and save the output before installing or changing anything:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,CsTotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
Get-Volume
Get-NetAdapter | Select-Object Name,Status,LinkSpeed,MacAddress
Get-NetIPConfiguration
node --version
corepack --version
git --version
docker version
```

Node must be 22 or newer; `.nvmrc` records the Spark development version
22.23.2. CPU affinity and P/E-core scheduling remain disabled until the existing
topology profiler and OFF/ON benchmarks pass on this exact U9.

## Repository acceptance

```powershell
git clone git@github.com:rennaikankk-cmyk/minecraft-multi-agent-studio.git
Set-Location minecraft-multi-agent-studio
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:runtime-link
pnpm test:four-process
$env:PLAYWRIGHT_BROWSER_CHANNEL = 'chrome'
pnpm test:e2e
```

Start from `profiles/controller-u9.env.example`; store completed settings and
secrets outside the repository. Merge authenticated peer/client/principal data
from `.env.example`. The Dashboard-facing Control API principal needs
`ai.metrics.read` in addition to its Bot/task permissions, or the AI page will
fail closed with 403.

## Wired Spark acceptance

After recording the real adapters and choosing private addresses:

```powershell
$env:AI_BASE_URL = 'http://<SPARK_PRIVATE_IP>:8000/v1'
$env:SPARK_AI_BASE_URL = $env:AI_BASE_URL
$env:AI_MODEL = 'qwen3.8-27b-nvfp4'
$env:AI_QUANTIZATION = 'modelopt_fp4'
$env:SPARK_AI_QUANTIZATION = 'ModelOpt-W4A16-NVFP4'
$env:AI_API_KEY = '<runtime secret>'
$env:SPARK_AI_API_KEY = $env:AI_API_KEY
$env:AI_MAX_CONCURRENCY = '4'
pnpm ai:health
pnpm ai:test
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

Compare wired RTT and results with the local Spark matrix. Do not accept a
concurrency above 4 merely because all requests complete; the local 8/10 levels
showed large provider queues with no material throughput gain.

## Services owned by U9

- Coordinator, AI Router/Scheduler, TeamCoordinator
- Bot Supervisor and Mineflayer Runtime processes
- Minecraft isolated/production servers
- PostgreSQL/pgvector, Redis/BullMQ, Task Worker
- Control API, Dashboard, logs, monitoring and automated tests

Spark owns none of those. U9 does not run a second production model by default.

## PostgreSQL, pgvector and durable world memory

Install PostgreSQL 17 with pgvector 0.8 or newer in the `public` schema on the
U9, create a dedicated database/principal with least privilege, and apply the
checked migrations in order. The world-memory migration is
`packages/world-memory/migrations/0001_world_memory.sql`; migrations are never
applied automatically and never delete an existing schema.

Keep the password-bearing PostgreSQL URL in the U9 service secret store rather
than a command line, checked file or log. Configure the task and memory services
from `profiles/controller-u9.env.example`, then validate with dedicated,
loopback-only test resources and a fresh disposable namespace:

```powershell
$env:TASK_POSTGRES_URL = '<secret from the service store>'
$env:TASK_REDIS_URL = 'redis://127.0.0.1:6379/15'
$env:TASK_INFRA_TEST_NAMESPACE = 'studio_test_u9_unique_identifier'
pnpm test:task-infra
```

Production `WORLD_MEMORY_POSTGRES_URL` must name a database host on loopback;
startup verifies the schema and pgvector version and fails closed if either is
invalid. Every spatial lookup is bound to the authoritative ServerProfile and
dimension. Exact base/storage locations and restricted player activity are not
eligible for model context.

Set `WORLD_MEMORY_INGESTION_SPOOL_DIR` to a dedicated absolute directory on the
U9 local persistent disk, for example
`C:\ProgramData\MinecraftMultiAgentStudio\world-memory-ingestion`. Grant only
the Coordinator service identity access; do not place it on Temp, a network
share, the repository or Spark. Keep the bounded batch/capacity/poll/retry values
from `profiles/controller-u9.env.example` until the U9 load test supplies better
evidence.

With world memory enabled, completed authorized Scout scans and storage
read-backs are written through the same loopback database. Alert on
outbox reconcile/failure events and nonzero `deferredCount` or
`pendingBatchCount`. PostgreSQL failure retains and replays the validated fact
batch across Coordinator restart; it never replays the Minecraft action. An
observer failure before durable enqueue is recovered with a fresh read-only
scan, not a possibly irreversible container transfer.

## Fail-closed defaults

- No public port forwarding or broad firewall allow rule.
- All Coordinator/Runtime/Control API links remain loopback on U9.
- Spark 8000 accepts only the U9 private address and requires an API key.
- No committed credentials, production server addresses, or base coordinates.
- Keep CPU affinity off until measured.
- Keep MTP off until independent concurrency/soak stability passes.
