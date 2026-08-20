# U9 controller-node setup

Status: preparation only. The U9 285H Windows host was not available during the
2026-08-20 audit, so no CPU topology, adapter, path, Docker, Node, PostgreSQL,
Redis, Minecraft, or firewall result is claimed.

## Intended ownership

The U9 runs Coordinator, task system/worker, Control API, Dashboard, Bot Runtime
processes, Minecraft client-side automation, PostgreSQL, Redis, and future
memory/log services. It calls Spark only through the OpenAI-compatible provider.
It does not host a second model by default.

## Arrival checklist (read-only first)

In PowerShell:

```powershell
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsBuildNumber,CsTotalPhysicalMemory
Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
Get-NetAdapter | Select-Object Name,Status,LinkSpeed,MacAddress
Get-NetIPConfiguration
node --version
corepack --version
git --version
docker version
```

Save the output before installing or changing anything. Node must be 22 or newer;
the repository pins 22.23.2 in `.nvmrc`. Do not enable CPU affinity until the
existing topology profiler and scheduler benchmarks pass on this exact host.

## Repository verification

```powershell
git clone git@github.com:rennaikankk-cmyk/minecraft-multi-agent-studio.git
Set-Location minecraft-multi-agent-studio
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Use the implementation branch only after reviewing/pushing it. Real PostgreSQL,
Redis, Minecraft, and Playwright checks are separate; offline unit tests do not
prove them.

## Spark link acceptance

Replace placeholders only after reading the actual network configuration:

```powershell
$env:AI_BASE_URL = 'http://<SPARK_PRIVATE_IP>:8000/v1'
$env:AI_MODEL = 'qwen3.8-27b-nvfp4'
$env:AI_API_KEY = '<runtime secret>'
Invoke-RestMethod -Headers @{ Authorization = "Bearer $env:AI_API_KEY" } -Uri 'http://<SPARK_PRIVATE_IP>:8000/health'
pnpm benchmark:ai -- --concurrency 1,2,5,10 --output-dir artifacts
```

The benchmark can run on Windows and records host architecture plus endpoint
performance. NVIDIA GPU metrics describe the machine running the command; to
record Spark GPU data, run the same benchmark on Spark or collect Spark metrics
through a future authenticated exporter.

## Fail-closed defaults

- `AI_MAX_CONCURRENCY` remains unset until a real model benchmark is accepted.
- CPU scheduler and CPU affinity remain disabled.
- Control API, Coordinator links, and Dashboard bind to loopback in current code.
- No public port forwarding, UPnP, or firewall broad allow rule.
- No real credentials in repository files or shell history.
- Do not call the system autonomous until the planner startup/API,
  authorization, and skill invocation transport are implemented.
