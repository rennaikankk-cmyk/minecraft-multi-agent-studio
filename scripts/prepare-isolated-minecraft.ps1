[CmdletBinding()]
param(
  [string]$RuntimeRoot = "",
  [string]$ServerProfilePath = ""
)

$ErrorActionPreference = "Stop"

# This script only prepares a loopback, offline test server. It never starts a
# server and it never accepts the Minecraft EULA on the user's behalf.
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

function Resolve-ProjectRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    throw "$Label cannot be empty."
  }
  if ([IO.Path]::IsPathRooted($Candidate)) {
    return [IO.Path]::GetFullPath($Candidate)
  }
  return [IO.Path]::GetFullPath((Join-Path $projectRoot $Candidate))
}

function Assert-ContainedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $rootFull = [IO.Path]::GetFullPath($Root)
  if ($rootFull.EndsWith([IO.Path]::DirectorySeparatorChar)) {
    $rootFull = $rootFull.Substring(0, $rootFull.Length - 1)
  }
  $candidateFull = [IO.Path]::GetFullPath($Candidate)
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must stay inside $rootFull."
  }
  return $candidateFull
}

function Assert-NoReparsePointInPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  # Check every existing ancestor. A lexical path check alone would allow a
  # junction or symlink inside the workspace to redirect writes elsewhere.
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

function Ensure-Directory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-NoReparsePointInPath -Path $Path -Label $Label
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Item -LiteralPath $Path -Force
    if (-not $existing.PSIsContainer) {
      throw "$Label is not a directory: $Path"
    }
    return
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  Assert-NoReparsePointInPath -Path $Path -Label $Label
}

function Write-GeneratedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content,
    [Parameter(Mandatory = $true)][string]$Label
  )

  Assert-NoReparsePointInPath -Path $Path -Label $Label
  if (Test-Path -LiteralPath $Path) {
    $existing = Get-Item -LiteralPath $Path -Force
    if ($existing.PSIsContainer) {
      throw "$Label is a directory, not a file: $Path"
    }
    $current = [IO.File]::ReadAllText($Path)
    if ($current -ne $Content) {
      throw "$Label already exists with different contents; refusing to overwrite it: $Path"
    }
    return $false
  }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
  return $true
}

function Assert-ServerJarHash {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Minecraft server JAR is missing: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Minecraft server JAR must not be a symlink or junction: $Path"
  }
  $sha1 = (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash.ToLowerInvariant()
  if ($sha1 -ne $script:ExpectedSha1) {
    throw "Minecraft 1.21.8 server SHA-1 validation failed."
  }
  $sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha256 -ne $script:ExpectedSha256) {
    throw "Minecraft 1.21.8 server SHA-256 validation failed."
  }
}

$script:MinecraftVersion = "1.21.8"
$script:ServerUrl = "https://piston-data.mojang.com/v1/objects/6bce4ef400e4efaa63a13d5e6f6b500be969ef81/server.jar"
$script:ExpectedSha1 = "6bce4ef400e4efaa63a13d5e6f6b500be969ef81"
$script:ExpectedSha256 = "2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7"

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $projectRoot "runtime-data\isolated-test"
} else {
  $RuntimeRoot = Resolve-ProjectRelativePath -Candidate $RuntimeRoot -Label "RuntimeRoot"
}
if ([string]::IsNullOrWhiteSpace($ServerProfilePath)) {
  $ServerProfilePath = Join-Path $projectRoot "configs\servers\isolated-test.local.json"
} else {
  $ServerProfilePath = Resolve-ProjectRelativePath -Candidate $ServerProfilePath -Label "ServerProfilePath"
}

$RuntimeRoot = Assert-ContainedPath -Candidate $RuntimeRoot -Root $projectRoot -Label "RuntimeRoot"
$ServerDirectory = Assert-ContainedPath -Candidate (Join-Path $RuntimeRoot "server") -Root $RuntimeRoot -Label "ServerDirectory"
$ServerProfilePath = Assert-ContainedPath -Candidate $ServerProfilePath -Root (Join-Path $projectRoot "configs\servers") -Label "ServerProfilePath"
$profileParentInfo = [IO.Directory]::GetParent($ServerProfilePath)
if ($null -eq $profileParentInfo) {
  throw "ServerProfilePath must have a parent directory."
}
$profileParent = $profileParentInfo.FullName
$serverJar = Join-Path $ServerDirectory "server.jar"
$eulaPath = Join-Path $ServerDirectory "eula.txt"
$propertiesPath = Join-Path $ServerDirectory "server.properties"

Ensure-Directory -Path $RuntimeRoot -Label "RuntimeRoot"
Ensure-Directory -Path $ServerDirectory -Label "ServerDirectory"
Ensure-Directory -Path $profileParent -Label "ServerProfile directory"

if (Test-Path -LiteralPath $serverJar) {
  Assert-ServerJarHash -Path $serverJar
  Write-Output "Minecraft 1.21.8 server.jar already exists and passed SHA-1/SHA-256 validation."
} else {
  $temporaryJar = Join-Path $ServerDirectory ("server.jar.download.{0}.{1}.tmp" -f $PID, [Guid]::NewGuid().ToString("N"))
  try {
    Write-Output "Downloading the fixed Minecraft 1.21.8 server from the official Mojang URL..."
    Invoke-WebRequest -Uri $script:ServerUrl -OutFile $temporaryJar -TimeoutSec 120 -UseBasicParsing
    Assert-ServerJarHash -Path $temporaryJar
    if (Test-Path -LiteralPath $serverJar) {
      Assert-ServerJarHash -Path $serverJar
    } else {
      Move-Item -LiteralPath $temporaryJar -Destination $serverJar
    }
  } finally {
    if (Test-Path -LiteralPath $temporaryJar) {
      Remove-Item -LiteralPath $temporaryJar -Force
    }
  }
  Assert-ServerJarHash -Path $serverJar
  Write-Output "Minecraft 1.21.8 server.jar downloaded and passed SHA-1/SHA-256 validation."
}

$propertiesText = @(
  "server-ip=127.0.0.1"
  "server-port=25565"
  "online-mode=false"
  "enable-rcon=false"
  "enable-query=false"
  "enforce-secure-profile=false"
  "level-name=world"
  "force-gamemode=true"
  "enable-status=true"
  "spawn-protection=0"
  "difficulty=peaceful"
  "gamemode=survival"
  "spawn-animals=false"
  "spawn-monsters=false"
  "spawn-npcs=false"
  "max-players=2"
  "motd=Minecraft Studio isolated test"
) -join [Environment]::NewLine
$propertiesText += [Environment]::NewLine
[void](Write-GeneratedFile -Path $propertiesPath -Content $propertiesText -Label "server.properties")

if (-not (Test-Path -LiteralPath $eulaPath)) {
  # The preparation step is intentionally not consent. The user must review
  # the EULA and edit this file manually before starting the server.
  [IO.File]::WriteAllText($eulaPath, "eula=false$([Environment]::NewLine)", [Text.UTF8Encoding]::new($false))
  Write-Output "Created eula.txt with eula=false. Manual EULA acceptance is required before startup."
} else {
  Assert-NoReparsePointInPath -Path $eulaPath -Label "eula.txt"
  $eulaItem = Get-Item -LiteralPath $eulaPath -Force
  if ($eulaItem.PSIsContainer) {
    throw "eula.txt is a directory, not a file: $eulaPath"
  }
  $eulaText = [IO.File]::ReadAllText($eulaPath)
  if ($eulaText -notmatch "(?m)^eula=(?:false|true)\s*$") {
    throw "eula.txt must contain one eula=false or eula=true setting; refusing to modify it."
  }
  Write-Output "Preserved existing eula.txt; this script never changes EULA consent."
}

$profile = [ordered]@{
  schemaVersion = "1.0"
  id = "local-isolated-test"
  botId = "studio-bot-01"
  purpose = "isolated-test"
  networkScope = "loopback"
  host = "127.0.0.1"
  port = 25565
  minecraftVersion = $script:MinecraftVersion
  username = "StudioBot"
  auth = "offline"
  statusIntervalMs = 1000
  heartbeatIntervalMs = 5000
  stopGracePeriodMs = 5000
  reconnect = [ordered]@{
    enabled = $true
    maxAttempts = 5
    baseDelayMs = 2000
    maxDelayMs = 30000
  }
}
$profileText = (($profile | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
[void](Write-GeneratedFile -Path $ServerProfilePath -Content $profileText -Label "isolated ServerProfile")

Write-Output "ISOLATED_MINECRAFT_PREPARED=PASS"
Write-Output "Server directory: $ServerDirectory"
Write-Output "ServerProfile: $ServerProfilePath"
Write-Output "The server is not started. Review the Minecraft EULA and manually set eula=true before running the integration script."
