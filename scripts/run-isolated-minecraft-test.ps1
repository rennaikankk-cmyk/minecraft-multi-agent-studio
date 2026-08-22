param(
  [string]$JavaExecutable = $env:MC_TEST_JAVA_EXE,
  [string]$ServerDirectory = $env:MC_TEST_SERVER_DIR,
  [string]$ServerProfilePath = $env:BOT_SERVER_PROFILE_PATH,
  [string]$PnpmExecutable = $env:MC_TEST_PNPM_EXE
)

$ErrorActionPreference = "Stop"

function Ensure-FileHashCommand {
  if ($null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
    return
  }

  # pnpm can pass a mixed PowerShell module path to Windows PowerShell. Load
  # the utility module shipped with the active host before hashing assets.
  $utilityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
  if (Test-Path -LiteralPath $utilityModule -PathType Leaf) {
    Import-Module -Name $utilityModule -Force -ErrorAction Stop
  }
  if ($null -eq (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
    throw "PowerShell Get-FileHash is unavailable; refusing to validate Minecraft assets."
  }
}

Ensure-FileHashCommand

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "runtime-data\isolated-test"))

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside the permitted directory: $candidateFull"
  }
  return $candidateFull
}

function Assert-NoReparsePointInPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $cursor"
      }
    }
    $parentInfo = [IO.Directory]::GetParent($cursor)
    $parent = if ($null -eq $parentInfo) { $null } else { $parentInfo.FullName }
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
      break
    }
    $cursor = $parent
  }
}

function Assert-NoReparsePointUnderRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-NoReparsePointInPath -Path $Root -Label $Label
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push([IO.Path]::GetFullPath($Root))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      }
    }
  }
}

$runtimeRoot = Assert-ContainedPath -Candidate $runtimeRoot -Root $projectRoot -Label "Runtime directory"
Assert-NoReparsePointInPath -Path $runtimeRoot -Label "Runtime directory"
if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
  throw "Runtime directory is missing; run scripts/prepare-isolated-minecraft.ps1 first."
}

if ([string]::IsNullOrWhiteSpace($JavaExecutable)) {
  $javaRoot = Join-Path $runtimeRoot "java"
  if (Test-Path -LiteralPath $javaRoot -PathType Container) {
    $JavaExecutable = Get-ChildItem -LiteralPath $javaRoot -Recurse -File -Filter java.exe |
      Where-Object { $_.FullName -match "\\bin\\java\.exe$" } |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
if ([string]::IsNullOrWhiteSpace($JavaExecutable)) {
  throw "Java 21 is missing. Place a trusted Java 21 runtime under runtime-data\\isolated-test\\java or set MC_TEST_JAVA_EXE."
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
if (-not (Test-Path -LiteralPath $JavaExecutable -PathType Leaf)) {
  throw "Java executable is missing: $JavaExecutable"
}
$javaVersionOutput = (& $JavaExecutable --version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $javaVersionOutput -notmatch '(?im)^\s*(?:openjdk|java)(?:\s+version)?\s+["'']?21(?:[.\s"'']|$)') {
  throw "Java 21 is required for Minecraft 1.21.8. Detected: $($javaVersionOutput.Trim())"
}
if (-not [IO.Path]::IsPathRooted($ServerDirectory)) {
  $ServerDirectory = Join-Path $runtimeRoot $ServerDirectory
}
if (-not [IO.Path]::IsPathRooted($ServerProfilePath)) {
  $ServerProfilePath = Join-Path $projectRoot $ServerProfilePath
}
$ServerDirectory = Assert-ContainedPath -Candidate $ServerDirectory -Root $runtimeRoot -Label "Server directory"
$ServerProfilePath = Assert-ContainedPath -Candidate $ServerProfilePath -Root (Join-Path $projectRoot "configs\servers") -Label "ServerProfile"
Assert-NoReparsePointUnderRoot -Root $ServerDirectory -Label "Server directory"
Assert-NoReparsePointInPath -Path $ServerProfilePath -Label "ServerProfile"
$serverJar = Join-Path $ServerDirectory "server.jar"
$eulaPath = Join-Path $ServerDirectory "eula.txt"
$propertiesPath = Join-Path $ServerDirectory "server.properties"
$acceptanceRoot = Assert-ContainedPath -Candidate (Join-Path $runtimeRoot "acceptance") -Root $runtimeRoot -Label "Acceptance directory"
$serverLogsDirectory = Assert-ContainedPath -Candidate (Join-Path $ServerDirectory "logs") -Root $ServerDirectory -Label "Server logs directory"
$serverWorldDirectory = Assert-ContainedPath -Candidate (Join-Path $ServerDirectory "world") -Root $ServerDirectory -Label "Server world directory"
foreach ($guardedDirectory in @($acceptanceRoot, $serverLogsDirectory, $serverWorldDirectory)) {
  Assert-NoReparsePointInPath -Path $guardedDirectory -Label "Isolated-server writable directory"
}
$readyFile = Join-Path $acceptanceRoot "bot-ready.marker"
$skillSetupRequest = Join-Path $acceptanceRoot "builtin-skills.setup-request.marker"
$skillSetupReady = Join-Path $acceptanceRoot "builtin-skills.setup-ready.marker"
$testStdout = Join-Path $acceptanceRoot "vitest.stdout.log"
$testStderr = Join-Path $acceptanceRoot "vitest.stderr.log"
$latestServerLog = Join-Path $serverLogsDirectory "latest.log"

foreach ($requiredPath in @($JavaExecutable, $serverJar, $eulaPath, $propertiesPath, $ServerProfilePath, $PnpmExecutable)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required file is missing: $requiredPath"
  }
}

foreach ($requiredFile in @($serverJar, $eulaPath, $propertiesPath, $ServerProfilePath)) {
  $fileItem = Get-Item -LiteralPath $requiredFile -Force
  if ($fileItem.PSIsContainer -or (($fileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Required isolated-server file must be a regular non-reparse file: $requiredFile"
  }
}

$expectedServerSha1 = "6bce4ef400e4efaa63a13d5e6f6b500be969ef81"
$actualServerSha1 = (Get-FileHash -LiteralPath $serverJar -Algorithm SHA1).Hash.ToLowerInvariant()
if ($actualServerSha1 -ne $expectedServerSha1) {
  throw "Minecraft 1.21.8 server SHA-1 validation failed."
}
$expectedServerSha256 = "2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7"
$actualServerSha256 = (Get-FileHash -LiteralPath $serverJar -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualServerSha256 -ne $expectedServerSha256) {
  throw "Minecraft 1.21.8 server SHA-256 validation failed."
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
  "level-name" = "world"
  "force-gamemode" = "true"
  "gamemode" = "survival"
  "spawn-animals" = "false"
  "spawn-monsters" = "false"
  "spawn-npcs" = "false"
}
foreach ($entry in $requiredProperties.GetEnumerator()) {
  if ($properties[$entry.Key] -ne $entry.Value) {
    throw "Unsafe isolated server property: $($entry.Key)"
  }
}

try {
  $serverProfile = Get-Content -LiteralPath $ServerProfilePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
} catch {
  throw "Isolated ServerProfile is not valid JSON."
}
$requiredProfile = @{
  "schemaVersion" = "1.0"
  "purpose" = "isolated-test"
  "networkScope" = "loopback"
  "host" = "127.0.0.1"
  "port" = 25565
  "username" = "StudioBot"
  "auth" = "offline"
}
foreach ($entry in $requiredProfile.GetEnumerator()) {
  if ($serverProfile.PSObject.Properties[$entry.Key].Value -ne $entry.Value) {
    throw "Unsafe isolated ServerProfile field: $($entry.Key)"
  }
}
if ($serverProfile.minecraftVersion -notin @("auto", "1.21.8")) {
  throw "Unsafe isolated ServerProfile field: minecraftVersion"
}

$existingListener = Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue
if ($null -ne $existingListener) {
  throw "Port 25565 is already in use; refusing to stop or reuse an unknown process."
}

New-Item -ItemType Directory -Path $acceptanceRoot -Force | Out-Null
Assert-NoReparsePointInPath -Path $acceptanceRoot -Label "Acceptance directory"
foreach ($artifact in @($readyFile, $skillSetupRequest, $skillSetupReady, $testStdout, $testStderr)) {
  $artifact = Assert-ContainedPath -Candidate $artifact -Root $acceptanceRoot -Label "Acceptance artifact"
  Assert-NoReparsePointInPath -Path $artifact -Label "Acceptance artifact"
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
  $testStdoutTask = $testProcess.StandardOutput.ReadToEndAsync()
  $testStderrTask = $testProcess.StandardError.ReadToEndAsync()
  $testDeadline = [DateTime]::UtcNow.AddMinutes(8)

  while (-not $testProcess.HasExited) {
    if ([DateTime]::UtcNow -ge $testDeadline) {
      throw "Real Minecraft integration tests exceeded the 8 minute hard deadline."
    }
    if ((Test-Path -LiteralPath $skillSetupRequest) -and -not (Test-Path -LiteralPath $skillSetupReady)) {
      # Fixed scenario; marker contents are never interpreted as commands.
      $fixtureSentinel = "MMS_FIXTURE_READY_V1"
      $fixtureLogBaseline = Get-Content -LiteralPath $latestServerLog -Raw -ErrorAction Stop
      foreach ($command in @(
        "forceload add -8 -6 10 6",
        "gamemode survival StudioBot",
        "clear StudioBot",
        "effect clear StudioBot",
        "fill -8 60 -6 10 100 6 minecraft:air replace",
        "fill -8 64 -6 10 70 6 minecraft:barrier outline",
        "fill -7 64 -5 9 64 5 minecraft:stone replace",
        "kill @e[type=!minecraft:player,x=-8,y=60,z=-6,dx=18,dy=40,dz=12]",
        "tp StudioBot 0 65 0",
        "setblock 5 65 0 minecraft:oak_log replace",
        "setblock 5 65 2 minecraft:air replace",
        "setblock 5 65 -2 minecraft:chest replace",
        "setblock 3 65 -2 minecraft:furnace replace",
        "give StudioBot minecraft:oak_planks 4",
        "give StudioBot minecraft:cobblestone 5",
        "give StudioBot minecraft:iron_helmet 1",
        "give StudioBot minecraft:iron_chestplate 1",
        "give StudioBot minecraft:iron_leggings 1",
        "give StudioBot minecraft:iron_boots 1",
        "give StudioBot minecraft:raw_iron 1",
        "give StudioBot minecraft:coal 1",
        "execute if entity @a[name=StudioBot,gamemode=survival,x=0,y=65,z=0,distance=..1] if block -8 70 -6 minecraft:barrier if block 5 65 0 minecraft:oak_log if block 5 65 2 minecraft:air if block 5 65 -2 minecraft:chest if block 3 65 -2 minecraft:furnace run say $fixtureSentinel",
        "forceload remove -8 -6 10 6"
      )) {
        $serverProcess.StandardInput.WriteLine($command)
      }
      $serverProcess.StandardInput.Flush()
      $fixtureDeadline = [DateTime]::UtcNow.AddSeconds(30)
      $fixtureReady = $false
      while ([DateTime]::UtcNow -lt $fixtureDeadline -and
             -not $serverProcess.HasExited -and
             -not $testProcess.HasExited) {
        $currentLog = Get-Content -LiteralPath $latestServerLog -Raw -ErrorAction SilentlyContinue
        if ($null -ne $currentLog -and
            $currentLog.Length -ge $fixtureLogBaseline.Length -and
            $currentLog.Substring($fixtureLogBaseline.Length).Contains($fixtureSentinel)) {
          $fixtureReady = $true
          break
        }
        Start-Sleep -Milliseconds 100
      }
      if (-not $fixtureReady) {
        throw "Isolated Minecraft fixture was not confirmed by the server within 30 seconds."
      }
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
  $testOutput = $testStdoutTask.GetAwaiter().GetResult()
  $testError = $testStderrTask.GetAwaiter().GetResult()
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
