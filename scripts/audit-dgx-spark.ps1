[CmdletBinding()]
param(
  [string]$SparkHost = "192.168.100.2",
  [string]$SparkUser = "rennaikank",
  [string]$IdentityFile = (Join-Path $env:USERPROFILE ".ssh\dgx_spark_ed25519"),
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
  throw "DGX Spark SSH identity file was not found."
}
if ($SparkHost -notmatch '^[A-Za-z0-9.-]{1,253}$' -or
    $SparkUser -notmatch '^[A-Za-z0-9._-]{1,64}$') {
  throw "DGX Spark SSH target is invalid."
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $OutputPath = Join-Path $repositoryRoot "runtime-data\dgx-audit-$stamp.json"
}
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot "runtime-data"))
if (-not $resolvedOutput.StartsWith($runtimeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw "Audit output must remain inside the repository runtime-data directory."
}
$outputDirectory = Split-Path -Parent $resolvedOutput
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

function Assert-NoReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $current = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while ($null -ne $current) {
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Audit output path cannot traverse a reparse point."
    }
    if ($current.FullName.TrimEnd([System.IO.Path]::DirectorySeparatorChar) -ieq
        $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
      return
    }
    $current = $current.Parent
  }
  throw "Audit output path is outside the repository runtime-data directory."
}

Assert-NoReparsePoint -Path $outputDirectory -Root $runtimeRoot
if (Test-Path -LiteralPath $resolvedOutput -PathType Leaf) {
  Assert-NoReparsePoint -Path $resolvedOutput -Root $runtimeRoot
}

function Invoke-SparkReadOnly {
  param([Parameter(Mandatory = $true)][string]$Command)

  # OpenSSH on Windows joins the trailing arguments into one remote command.
  # Quote the static bash script explicitly so spaces and embedded shell
  # operators are not re-tokenized by the remote login shell.
  $escapedCommand = $Command.Replace("'", "'\''")
  $remoteCommand = "bash -lc '$escapedCommand'"
  $arguments = @(
    "-i", $IdentityFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=yes",
    "$SparkUser@$SparkHost",
    $remoteCommand
  )
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & ssh @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $text = (($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
  $text = Protect-SparkOutput -Text $text
  [ordered]@{
    exitCode = $exitCode
    output = $text
  }
}

function Protect-SparkOutput {
  param([AllowEmptyString()][string]$Text)

  if ([string]::IsNullOrEmpty($Text)) {
    return $Text
  }
  $redacted = $Text
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)(\b(?:password|passwd|secret|token|api[-_]?key|authorization|private[-_]?key)\b\s*[:=]\s*)[^\s,;}]+',
    '$1[REDACTED]'
  )
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)(--(?:password|passwd|secret|token|api[-_]?key|hf[-_]?token)(?:=|\s+))[^\s]+',
    '$1[REDACTED]'
  )
  $redacted = [regex]::Replace(
    $redacted,
    '(?i)(\bBearer\s+)[A-Za-z0-9._~+/=-]+',
    '$1[REDACTED]'
  )
  return $redacted
}

$preflight = Invoke-SparkReadOnly -Command "printf dgx-spark-audit-ready"
if ($preflight.exitCode -ne 0 -or $preflight.output -ne "dgx-spark-audit-ready") {
  throw "DGX Spark SSH preflight failed. Confirm that the dedicated public key is present in ~/.ssh/authorized_keys."
}

$checks = [ordered]@{
  identity = "hostname; id; date --iso-8601=seconds"
  os = "uname -a; printf '\n'; cat /etc/os-release"
  gpu = "command -v nvidia-smi >/dev/null && nvidia-smi || true"
  gpuQuery = "command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,temperature.gpu,power.draw --format=csv,noheader || true"
  cuda = "command -v nvcc >/dev/null && nvcc --version || true; ldconfig -p 2>/dev/null | grep -E 'libcuda|libcudart' | head -20 || true"
  memory = "free -h; printf '\n'; cat /proc/meminfo | head -20"
  disk = "df -hT; printf '\n'; lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS,MODEL"
  network = "ip -brief addr; printf '\n'; ip -s link"
  docker = "docker --version 2>&1 || true; docker info --format '{{json .}}' 2>&1 || true"
  nvidiaContainerToolkit = "nvidia-ctk --version 2>&1 || true; dpkg-query -W 'nvidia-container-toolkit*' 2>&1 || true"
  containers = "docker ps --no-trunc --format '{{json .}}' 2>&1 || true"
  services = "systemctl list-units --type=service --state=running --no-pager --no-legend 2>&1 | grep -Ei 'vllm|sglang|nvidia|docker|model|inference' || true"
  listeningPorts = "ss -lntup 2>&1 || true"
  modelDirectories = 'for p in /models /model /opt/models /srv/models /data/models "$HOME/.cache/huggingface"; do if [ -e "$p" ]; then du -sh "$p" 2>/dev/null; find "$p" -maxdepth 2 -mindepth 1 -type d 2>/dev/null | head -100; fi; done'
  inferenceProcesses = "ps -eo pid,etimes,%cpu,%mem,args --sort=-%mem | grep -Ei 'vllm|sglang|triton|python.*api_server' | grep -v grep || true"
  toolchainVersions = 'python3 --version 2>&1 || true; python3 -c "import importlib.metadata as m, json; names=[\"torch\",\"vllm\",\"transformers\"]; installed={d.metadata[\"Name\"].lower() for d in m.distributions()}; print(json.dumps({n:(m.version(n) if n in installed else None) for n in names}, sort_keys=True))" 2>&1 || true; vllm --version 2>&1 || true'
  sm121Capability = 'python3 -c "import torch; c=torch.cuda.get_device_capability(0); a=torch.cuda.get_arch_list(); print(\"device=\"+torch.cuda.get_device_name(0)); print(\"capability=%d.%d\" % c); print(\"arch_list=\"+str(a)); print(\"sm121_native=\"+str(\"sm_121\" in a))" 2>&1 || true'
  sm121KernelArtifacts = "command -v cuobjdump >/dev/null && cuobjdump --version 2>&1 || true; find /usr/local/lib /usr/lib /opt /home -type f -name '*.so' -size -500M 2>/dev/null | head -100"
  gpuMemoryBreakdown = "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>&1 || true; nvidia-smi -q -d MEMORY 2>&1 | head -120 || true"
  processMemoryBreakdown = "ps -eo pid,comm,rss,vsz,args --sort=-rss | head -100"
}

$results = [ordered]@{}
foreach ($entry in $checks.GetEnumerator()) {
  $results[$entry.Key] = Invoke-SparkReadOnly -Command $entry.Value
}

$report = [ordered]@{
  schemaVersion = "1.1"
  auditType = "dgx-spark-read-only"
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  target = [ordered]@{
    host = $SparkHost
    user = $SparkUser
  }
  destructiveActions = $false
  readOnly = $true
  acceptance = [ordered]@{
    driverCudaVllmTransformers = [ordered]@{
      status = if ($results.toolchainVersions.output -match 'torch' -and $results.gpu.output -match 'Driver Version' -and $results.cuda.output -match 'release 13\.0') { "partial" } else { "not-verified" }
      evidence = "gpu, cuda and toolchainVersions checks; vLLM/Transformers must be present to complete the four-tuple"
    }
    sm121NativeKernel = [ordered]@{
      status = if ($results.sm121Capability.output -match 'sm121_native=True' -and $results.sm121KernelArtifacts.output -match 'sm_121|compute_121') { "candidate-evidence" } else { "not-verified" }
      evidence = "sm121Capability plus cuobjdump output; profiler trace during model inference is still required to prove dispatch"
    }
    memoryBreakdown = [ordered]@{
      status = if ($results.gpuMemoryBreakdown.output -and $results.processMemoryBreakdown.output) { "observed" } else { "not-verified" }
      evidence = "gpuMemoryBreakdown and processMemoryBreakdown; weights/KV/CUDA-graph bytes require serving metrics or allocator trace"
    }
  }
  checks = $results
}

$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedOutput -Encoding utf8
Write-Output $resolvedOutput
