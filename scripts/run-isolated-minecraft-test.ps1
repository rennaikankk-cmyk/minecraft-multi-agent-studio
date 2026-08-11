param(
  [string]$JavaExecutable = $env:MC_TEST_JAVA_EXE,
  [string]$ServerDirectory = $env:MC_TEST_SERVER_DIR,
  [string]$ServerProfilePath = $env:BOT_SERVER_PROFILE_PATH,
  [string]$PnpmExecutable = $env:MC_TEST_PNPM_EXE
)

$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "runtime-data\isolated-test"))
if (-not $runtimeRoot.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Resolved runtime directory is outside the project."
}

if ([string]::IsNullOrWhiteSpace($JavaExecutable)) {
  $JavaExecutable = Get-ChildItem -LiteralPath (Join-Path $runtimeRoot "java") -Recurse -File -Filter java.exe |
    Where-Object { $_.FullName -match "\\bin\\java\.exe$" } |
    Select-Object -First 1 -ExpandProperty FullName
}
if ([string]::IsNullOrWhiteSpace($ServerDirectory)) {
  $ServerDirectory = Join-Path $runtimeRoot "server"
}
if ([string]::IsNullOrWhiteSpace($ServerProfilePath)) {
  $ServerProfilePath = Join-Path $projectRoot "configs\servers\isolated-test.local.json"
}
if ([string]::IsNullOrWhiteSpace($PnpmExecutable)) {
  $PnpmExecutable = Get-Command pnpm.cmd -ErrorAction Stop | Select-Object -ExpandProperty Source
}

$JavaExecutable = [IO.Path]::GetFullPath($JavaExecutable)
$ServerDirectory = [IO.Path]::GetFullPath($ServerDirectory)
$ServerProfilePath = [IO.Path]::GetFullPath($ServerProfilePath)
$serverJar = Join-Path $ServerDirectory "server.jar"
$eulaPath = Join-Path $ServerDirectory "eula.txt"
$propertiesPath = Join-Path $ServerDirectory "server.properties"
$readyFile = Join-Path $runtimeRoot "acceptance\bot-ready.marker"
$skillSetupRequest = Join-Path $runtimeRoot "acceptance\smelt-item.setup-request.marker"
$skillSetupReady = Join-Path $runtimeRoot "acceptance\smelt-item.setup-ready.marker"
$testStdout = Join-Path $runtimeRoot "acceptance\vitest.stdout.log"
$testStderr = Join-Path $runtimeRoot "acceptance\vitest.stderr.log"
$latestServerLog = Join-Path $ServerDirectory "logs\latest.log"

foreach ($requiredPath in @($JavaExecutable, $serverJar, $eulaPath, $propertiesPath, $ServerProfilePath, $PnpmExecutable)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required file is missing: $requiredPath"
  }
}

$expectedServerSha1 = "6bce4ef400e4efaa63a13d5e6f6b500be969ef81"
$actualServerSha1 = (Get-FileHash -LiteralPath $serverJar -Algorithm SHA1).Hash.ToLowerInvariant()
if ($actualServerSha1 -ne $expectedServerSha1) {
  throw "Minecraft 1.21.8 server SHA-1 validation failed."
}

$eulaText = Get-Content -LiteralPath $eulaPath -Raw -Encoding utf8
if ($eulaText -notmatch "(?m)^eula=true\s*$") {
  throw "Minecraft EULA has not been accepted; refusing to start the server."
}

$properties = @{}
foreach ($line in Get-Content -LiteralPath $propertiesPath -Encoding utf8) {
  if ($line -match "^([^#=]+)=(.*)$") {
    $properties[$Matches[1]] = $Matches[2]
  }
}
$requiredProperties = @{
  "server-ip" = "127.0.0.1"
  "server-port" = "25565"
  "online-mode" = "false"
  "enable-rcon" = "false"
  "enable-query" = "false"
  "enforce-secure-profile" = "false"
}
foreach ($entry in $requiredProperties.GetEnumerator()) {
  if ($properties[$entry.Key] -ne $entry.Value) {
    throw "Unsafe isolated server property: $($entry.Key)"
  }
}

$existingListener = Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $existingListener) {
  throw "Port 25565 is already in use; refusing to stop or reuse an unknown process."
}

$acceptanceRoot = Split-Path -Parent $readyFile
New-Item -ItemType Directory -Path $acceptanceRoot -Force | Out-Null
foreach ($artifact in @($readyFile, $skillSetupRequest, $skillSetupReady, $testStdout, $testStderr)) {
  if (Test-Path -LiteralPath $artifact) {
    Remove-Item -LiteralPath $artifact -Force
  }
}

$serverProcess = $null
$testProcess = $null
$serverStopSent = $false
$serverStartedAt = [DateTime]::UtcNow
$previousProfile = $env:BOT_SERVER_PROFILE_PATH
$previousRealTest = $env:RUN_REAL_MC_TEST
$previousReadyFile = $env:MC_TEST_READY_FILE
$previousSkillSetupRequest = $env:MC_SKILL_SETUP_REQUEST_FILE
$previousSkillSetupReady = $env:MC_SKILL_SETUP_READY_FILE

try {
  $serverStart = [Diagnostics.ProcessStartInfo]::new()
  $serverStart.FileName = $JavaExecutable
  $serverStart.Arguments = "-Xms512M -Xmx1024M -jar server.jar nogui"
  $serverStart.WorkingDirectory = $ServerDirectory
  $serverStart.UseShellExecute = $false
  $serverStart.CreateNoWindow = $true
  $serverStart.RedirectStandardInput = $true
  $serverProcess = [Diagnostics.Process]::new()
  $serverProcess.StartInfo = $serverStart
  if (-not $serverProcess.Start()) {
    throw "Failed to start the isolated Minecraft server."
  }

  $readyDeadline = [DateTime]::UtcNow.AddMinutes(3)
  $serverReady = $false
  while ([DateTime]::UtcNow -lt $readyDeadline -and -not $serverProcess.HasExited) {
    if (Test-Path -LiteralPath $latestServerLog) {
      $logItem = Get-Item -LiteralPath $latestServerLog
      if ($logItem.LastWriteTimeUtc -ge $serverStartedAt -and
          (Get-Content -LiteralPath $latestServerLog -Raw -ErrorAction SilentlyContinue) -match "Done \(") {
        $serverReady = $true
        break
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $serverReady) {
    throw "Isolated Minecraft server did not become ready within 3 minutes."
  }

  $env:BOT_SERVER_PROFILE_PATH = $ServerProfilePath
  $env:RUN_REAL_MC_TEST = "1"
  $env:MC_TEST_READY_FILE = $readyFile
  $env:MC_SKILL_SETUP_REQUEST_FILE = $skillSetupRequest
  $env:MC_SKILL_SETUP_READY_FILE = $skillSetupReady
  $testStart = [Diagnostics.ProcessStartInfo]::new()
  $testStart.FileName = $env:ComSpec
  $testStart.Arguments = '/d /s /c ""{0}" --filter @minecraft-studio/bot-runtime test:integration"' -f $PnpmExecutable
  $testStart.WorkingDirectory = $projectRoot
  $testStart.UseShellExecute = $false
  $testStart.CreateNoWindow = $true
  $testStart.RedirectStandardOutput = $true
  $testStart.RedirectStandardError = $true
  $testProcess = [Diagnostics.Process]::new()
  $testProcess.StartInfo = $testStart
  if (-not $testProcess.Start()) {
    throw "Failed to start the real Minecraft integration test process."
  }

  while (-not $testProcess.HasExited) {
    if ((Test-Path -LiteralPath $skillSetupRequest) -and -not (Test-Path -LiteralPath $skillSetupReady)) {
      # 固定场景，不读取 marker 内容为命令，避免把测试数据变成控制台注入入口。
      foreach ($command in @(
        "clear StudioBot",
        "tp StudioBot 0 65 0",
        "setblock 2 64 0 minecraft:furnace replace",
        "give StudioBot minecraft:raw_iron 5",
        "give StudioBot minecraft:coal 1"
      )) {
        $serverProcess.StandardInput.WriteLine($command)
      }
      $serverProcess.StandardInput.Flush()
      Start-Sleep -Milliseconds 500
      [IO.File]::WriteAllText($skillSetupReady, "ready`n", [Text.UTF8Encoding]::new($false))
    }
    if (-not $serverStopSent -and (Test-Path -LiteralPath $readyFile)) {
      $serverProcess.StandardInput.WriteLine("stop")
      $serverProcess.StandardInput.Flush()
      $serverStopSent = $true
    }
    Start-Sleep -Milliseconds 250
  }
  $testProcess.WaitForExit()
  $testExitCode = $testProcess.ExitCode
  $testOutput = $testProcess.StandardOutput.ReadToEnd()
  $testError = $testProcess.StandardError.ReadToEnd()
  [IO.File]::WriteAllText($testStdout, $testOutput, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($testStderr, $testError, [Text.UTF8Encoding]::new($false))
  if (-not [string]::IsNullOrWhiteSpace($testOutput)) {
    Write-Output $testOutput.TrimEnd()
  }
  if (-not [string]::IsNullOrWhiteSpace($testError)) {
    Write-Output $testError.TrimEnd()
  }
  if ($testExitCode -ne 0) {
    throw "Real Minecraft integration tests failed with exit code $testExitCode."
  }
} finally {
  if ($null -ne $testProcess -and -not $testProcess.HasExited) {
    Stop-Process -Id $testProcess.Id -Force
  }
  if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
    try {
      $serverProcess.StandardInput.WriteLine("stop")
      $serverProcess.StandardInput.Flush()
      if (-not $serverProcess.WaitForExit(20000)) {
        $serverProcess.Kill()
      }
    } catch {
      if (-not $serverProcess.HasExited) {
        $serverProcess.Kill()
      }
    }
  }
  $env:BOT_SERVER_PROFILE_PATH = $previousProfile
  $env:RUN_REAL_MC_TEST = $previousRealTest
  $env:MC_TEST_READY_FILE = $previousReadyFile
  $env:MC_SKILL_SETUP_REQUEST_FILE = $previousSkillSetupRequest
  $env:MC_SKILL_SETUP_READY_FILE = $previousSkillSetupReady
}

Write-Output "REAL_MINECRAFT_INTEGRATION=PASS"
Write-Output "MINECRAFT_SKILL_ACCEPTANCE=PASS"

