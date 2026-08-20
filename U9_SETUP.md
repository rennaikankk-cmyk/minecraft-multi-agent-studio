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

## Fail-closed defaults

- No public port forwarding or broad firewall allow rule.
- All Coordinator/Runtime/Control API links remain loopback on U9.
- Spark 8000 accepts only the U9 private address and requires an API key.
- No committed credentials, production server addresses, or base coordinates.
- Keep CPU affinity off until measured.
- Keep MTP off until independent concurrency/soak stability passes.
