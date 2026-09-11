# Windows ACL hardening for AuthCredentialStore credential files.
#
# Fixed invocation (SECURITY.md §2, execFile + shell:false, no string interpolation):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
#     -File win-acl-restrict.ps1 <targetsBase64>
#
# The target list arrives as a single base64 argv token.
# Why base64 and not JSON text: this script must run under Windows PowerShell 5.1
# (the only powershell.exe on many hosts, including this repo's target machines).
# 5.1's -File argument parser passes each argv token through a CommandLineToArgvW
# round trip that drops the double quotes a JSON payload needs, and it cannot bind a
# `string[]` literal element-wise; a bare base64 token is unaffected by both. The
# decoded payload is parsed with ConvertFrom-Json and never evaluated as code, and
# the argv shape itself is fixed (only this one token varies).
#
# Semantics: DACL := protected (inheritance removed) + owner-only.
#   directory -> owner+SYSTEM+Administrators (owner must be able to repair the ACL)
#   file      -> owner only
# The ACL is re-read after writing; anything unexpected yields a non-ok status for
# that target so the caller can fail closed (no plaintext secret left readable).
#
# Properties that make this safe to call repeatedly:
#   - an already-correct ACL short-circuits to ok (idempotent, no re-ACL churn);
#   - ACEs are built from SecurityIdentifier objects, never from translated account
#     names (works where name translation is restricted);
#   - the owner is only rewritten when it actually differs, and a failure to rewrite
#     it degrades to unverified rather than to "hardened".
#
# NOTE: this file is deliberately ASCII-only so it runs identically under Windows
# PowerShell 5.1 (ANSI / UTF-8-with-BOM parsing) and PowerShell 7.
param(
  [Parameter(Mandatory = $true)][string]$TargetsBase64
)

$ErrorActionPreference = 'Stop'
$TargetsJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TargetsBase64))
# 注意：不要用 @() 包 ConvertFrom-Json 的结果——在 Windows PowerShell 5.1 上
# 它会把 JSON 数组再套一层成 Object[]，逐项属性访问就取不到值了。
$targets = ConvertFrom-Json -InputObject $TargetsJson
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = New-Object System.Security.Principal.SecurityIdentifier($ownerSid.Value)
$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

function Test-AclTarget {
  param([string]$Path, [string]$Purpose, [string[]]$AllowedSids)
  if ($Purpose -eq 'directory') {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  } elseif (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  $current = Get-Acl -LiteralPath $Path
  if (-not $current.AreAccessRulesProtected) { return $false }
  $rules = @($current.Access)
  if ($rules.Count -lt 1) { return $false }
  foreach ($rule in $rules) {
    if ($rule.IsInherited) { return $false }
    $idValue = $rule.IdentityReference.Value
    if ($rule.IdentityReference -is [System.Security.Principal.SecurityIdentifier]) {
      if ($AllowedSids -notcontains $idValue) { return $false }
    } else {
      try {
        $translated = ([System.Security.Principal.NTAccount]$idValue).Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($AllowedSids -notcontains $translated) { return $false }
      } catch { return $false }
    }
  }
  try {
    $ownerNow = ([System.Security.Principal.NTAccount]$current.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $ownerNow = $current.Owner
  }
  return (($ownerNow -replace '^\.\\', '') -eq $ownerSid.Value)
}

foreach ($entry in $targets) {
  $path = [string]$entry.path
  $purpose = [string]$entry.purpose
  if (-not $path -or (@('directory', 'file') -notcontains $purpose)) {
    Write-Output '{"status":"bad-argument"}'
    continue
  }
  try {
    $full = [System.IO.Path]::GetFullPath($path)
    if ($purpose -eq 'directory') {
      if (-not (Test-Path -LiteralPath $full -PathType Container)) {
        New-Item -ItemType Directory -LiteralPath $full -Force | Out-Null
      }
    } elseif (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Write-Output '{"status":"missing-target"}'
      continue
    }

    $allowed = @($ownerSid.Value)
    $extra = @()
    if ($purpose -eq 'directory') {
      $allowed += @($system.Value, $admins.Value)
      $extra = @($system, $admins)
    }

    if (-not (Test-AclTarget -Path $full -Purpose $purpose -AllowedSids $allowed)) {
      # Files must not carry inheritance flags at all ("No flags can be set").
      $inherit = if ($purpose -eq 'directory') {
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
      } else {
        [System.Security.AccessControl.InheritanceFlags]::None
      }
      $propagate = [System.Security.AccessControl.PropagationFlags]::None
      $allowType = [System.Security.AccessControl.AccessControlType]::Allow

      $acl = Get-Acl -LiteralPath $full
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($existing) }
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', $inherit, $propagate, $allowType)))
      foreach ($sidObject in $extra) {
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sidObject, 'FullControl', $inherit, $propagate, $allowType)))
      }
      # Ownership is normally already correct (we created the entry); only rewrite it
      # when it differs, and never let that rewrite turn the result into a false "ok".
      try {
        $ownerNow = ([System.Security.Principal.NTAccount](Get-Acl -LiteralPath $full).Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
      } catch {
        $ownerNow = ''
      }
      if (($ownerNow -replace '^\.\\', '') -ne $ownerSid.Value) {
        try { $acl.SetOwner($owner) } catch { }
      }
      Set-Acl -LiteralPath $full -AclObject $acl
    }

    if (-not (Test-AclTarget -Path $full -Purpose $purpose -AllowedSids $allowed)) {
      Write-Output '{"status":"acl-not-hardened"}'
      continue
    }

    Write-Output ('{"status":"ok","owner":"' + $ownerSid.Value + '","purpose":"' + $purpose + '"}')
  } catch {
    # Stable failure signal; never echo the target path (it may identify a credential file).
    Write-Output ('{"status":"error","kind":"' + $_.Exception.GetType().Name + '"}')
  }
}
