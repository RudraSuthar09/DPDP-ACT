<#
  .SYNOPSIS
    Installs or upgrades the DPDP Gateway Agent Windows Service. Run by the
    Inno Setup installer (already elevated). Idempotent: rerunning it on an
    installed or half-installed machine converges to the same state.

  .DESCRIPTION
    1. Refuses to continue if {app} (binaries + scripts the service and the
       elevated helper execute) is writable by non-administrators.
    2. Registers the service with WinSW if it is not registered yet. An
       existing registration is KEPT on upgrade (never uninstalled), so the
       service's identity and its DPAPI-protected credentials survive.
    3. Sets the service to run as the virtual account
       NT SERVICE\DPDPGatewayAgent with sc.exe and VERIFIES it. WinSW 2.x
       ignores any username argument to `install` and would otherwise
       register the service as LocalSystem.
    4. Creates %ProgramData%\DPDP Gateway\{config,state,state\logs} with
       explicit, protected ACLs, owned by Administrators (see ACL section).
    5. Configures SCM recovery, starts the service and waits for Running.

    Every native command's exit code is checked; any failure throws, and the
    installer reports it. A transcript is written to
    {app}\install-service.log (Administrators-only location).

  .PARAMETER InstallDir
    Inno Setup's {app}.
#>
#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName = 'DPDPGatewayAgent'
$ServiceAccount = "NT SERVICE\$ServiceName"
$Root = Join-Path $env:ProgramData 'DPDP Gateway'
$ConfigDir = Join-Path $Root 'config'
$StateDir = Join-Path $Root 'state'
$LogsDir = Join-Path $StateDir 'logs'
$WinswExe = Join-Path $InstallDir 'DPDPGatewayAgent.exe'

# Well-known SIDs: locale-independent (group NAMES are localized on
# non-English Windows, which made the previous version fail there).
$SidSystem = '*S-1-5-18'
$SidAdmins = '*S-1-5-32-544'
$SidUsers = '*S-1-5-32-545'

try { Start-Transcript -Path (Join-Path $InstallDir 'install-service.log') -Append | Out-Null } catch {}

function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [int[]]$OkExitCodes = @(0))
  # Exit codes decide success. Under 'Stop', PowerShell 5.1 would turn any
  # stderr line from a native exe into a terminating error even on success.
  $ErrorActionPreference = 'Continue'
  $output = & $File @Arguments 2>&1 | Out-String
  if ($OkExitCodes -notcontains $LASTEXITCODE) {
    throw "'$File $($Arguments -join ' ')' failed with exit code $LASTEXITCODE.`n$output"
  }
  return $output
}

function Get-ServiceSid {
  $out = Invoke-Native 'sc.exe' @('showsid', $ServiceName)
  if ($out -notmatch '(S-1-5-80(?:-\d+)+)') { throw "Could not determine the service SID for $ServiceName." }
  return "*$($Matches[1])"
}

function Assert-AdminOnlyWritable([string]$Path) {
  # Standard users must not be able to replace anything the service (or the
  # elevated helper) executes -- that would be a privilege escalation.
  $risky = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-4')  # Everyone, Authenticated Users, Users, Interactive
  # ONLY bits that grant writing. (The composite names Modify/FullControl also
  # contain READ bits -- ReadData, Execute, Synchronize... -- so OR-ing them
  # in made the ordinary "Users: Read & execute" entry on every Program Files
  # folder look writable, and the install always failed.)
  #   WriteData/CreateFiles 0x2, AppendData/CreateDirectories 0x4,
  #   WriteExtendedAttributes 0x10, DeleteSubdirectoriesAndFiles 0x40,
  #   WriteAttributes 0x100, Delete 0x10000, ChangePermissions 0x40000,
  #   TakeOwnership 0x80000, GENERIC_ALL 0x10000000, GENERIC_WRITE 0x40000000.
  $writeMask = [long](0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000)
  foreach ($item in @(Get-Item -LiteralPath $Path) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue)) {
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing to install: $($item.FullName) is a link/junction." }
    foreach ($ace in (Get-Acl -LiteralPath $item.FullName).Access) {
      if ($ace.AccessControlType -ne 'Allow') { continue }
      $sid = try { $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' }
      # Generic rights (e.g. GENERIC_READ 0x80000000) surface as a negative Int32: take the low 32 bits as unsigned.
      $rights = ([long][int]$ace.FileSystemRights) -band [long]4294967295
      if ($risky -contains $sid -and ($rights -band $writeMask)) {
        throw "Refusing to install: non-administrators can modify $($item.FullName). Install under Program Files."
      }
    }
  }
}

function Set-ProtectedDirectory([string]$Path, [string[]]$Grants) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to use $Path -- it is a link/junction (possibly pre-created by another user)."
    }
  } else {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
  # A standard user can pre-create folders under %ProgramData% and would stay
  # OWNER (and could re-grant themselves access). Take ownership first.
  Invoke-Native 'icacls.exe' @($Path, '/setowner', $SidAdmins, '/T', '/C', '/Q') | Out-Null
  Invoke-Native 'icacls.exe' @($Path, '/inheritance:r', '/Q') | Out-Null
  Invoke-Native 'icacls.exe' (@($Path, '/grant:r') + $Grants + @('/Q')) | Out-Null
  # Remove any ACEs on pre-existing children so they inherit only from here.
  if (Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue) {
    foreach ($child in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
      if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing to continue: $($child.FullName) is a link/junction." }
    }
    Invoke-Native 'icacls.exe' @("$Path\*", '/reset', '/T', '/C', '/Q') | Out-Null
  }
}

# The installer shows this file's text when the script fails, so the customer
# sees the real cause (e.g. WinSW's own error) and not just an exit code.
# Installation messages carry no secrets; it lives in admin-only {app}.
$ErrorFile = Join-Path $InstallDir 'install-service.error.txt'
Remove-Item -LiteralPath $ErrorFile -Force -ErrorAction SilentlyContinue

try {
  Write-Host "Installing the DPDP Gateway Agent service from $InstallDir ..."

  foreach ($required in @($WinswExe, (Join-Path $InstallDir 'DPDPGatewayAgent.xml'), (Join-Path $InstallDir 'runtime\node.exe'), (Join-Path $InstallDir 'agent\dist\index.js'), (Join-Path $InstallDir 'elevated-helper.ps1'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing installed file: $required" }
  }
  Assert-AdminOnlyWritable $InstallDir

  # --- 1. Registration (kept on upgrade) ------------------------------------
  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host 'Service already registered -- upgrading in place (identity and credentials preserved).'
    if ($existing.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
  } else {
    Invoke-Native $WinswExe @('install') | Out-Null
  }

  # --- 2. Run as the virtual account, and prove it --------------------------
  Invoke-Native 'sc.exe' @('config', $ServiceName, 'obj=', $ServiceAccount, 'start=', 'auto') | Out-Null
  Invoke-Native 'sc.exe' @('sidtype', $ServiceName, 'unrestricted') | Out-Null
  $qc = Invoke-Native 'sc.exe' @('qc', $ServiceName)
  if ($qc -notmatch [regex]::Escape($ServiceAccount)) {
    throw "The service is not configured to run as $ServiceAccount. Refusing to start it under another (possibly LocalSystem) account.`n$qc"
  }
  # SCM-level recovery in case the WinSW wrapper itself dies (WinSW restarts
  # node.exe on its own; this covers WinSW).
  Invoke-Native 'sc.exe' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000') | Out-Null

  # --- 3. Data directories ----------------------------------------------------
  #   Root   : Admins/SYSTEM full; Users read+traverse.
  #   config : config.json (non-secret, but it decides WHERE the service sends
  #            its device token and which interface it listens on). Admins/
  #            SYSTEM full; service account and Users READ-ONLY. All writes go
  #            through the elevated helper. (Phase 2 let any signed-in user
  #            modify it -- that allowed token exfiltration.)
  #   state  : device credential, sources, hand-off files, logs. Admins/SYSTEM
  #            full; service account Modify; no access for anyone else.
  $ServiceSid = Get-ServiceSid
  Set-ProtectedDirectory $Root @("${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F", "${SidUsers}:(RX)")
  Set-ProtectedDirectory $ConfigDir @("${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F", "${ServiceSid}:(OI)(CI)RX", "${SidUsers}:(OI)(CI)RX")
  Set-ProtectedDirectory $StateDir @("${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F", "${ServiceSid}:(OI)(CI)M")
  if (-not (Test-Path -LiteralPath $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir | Out-Null }

  # --- 4. Start -----------------------------------------------------------------
  Start-Service -Name $ServiceName
  (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
  Write-Host 'DPDP Gateway Agent service is running as NT SERVICE\DPDPGatewayAgent.'
  exit 0
} catch {
  Write-Host "INSTALL FAILED: $($_.Exception.Message)"
  Write-Host "Logs: $InstallDir\install-service.log and $LogsDir"
  # Collapse to readable lines (native tools' output is appended to the
  # message) and cap the length for the installer's dialog.
  $summary = (($_.Exception.Message -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 6) -join "`r`n"
  if ($summary.Length -gt 700) { $summary = $summary.Substring(0, 700) + ' ...' }
  try { [IO.File]::WriteAllText($ErrorFile, $summary, (New-Object Text.UTF8Encoding $false)) } catch {}
  exit 1
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
