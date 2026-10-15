<#
  .SYNOPSIS
    Removes the DPDP Gateway Agent Windows Service. Run by the Inno Setup
    uninstaller (elevated). Idempotent.

  .DESCRIPTION
    UNINSTALL POLICY (customer data):
      - The service registration is removed.
      - %ProgramData%\DPDP Gateway (config, device credential, sources,
        logs) is KEPT by default, so a reinstall resumes as the same paired
        device with the same sources. It stays readable only by
        Administrators/SYSTEM (and, for config, local users). Uninstalling
        does NOT de-enrol the device: use Gateway Setup -> Remove Gateway
        first (or revoke the device in the DPDP dashboard).
      - -PurgeState deletes that directory entirely, including the
        DPAPI-protected device credential and source credentials.

  .PARAMETER InstallDir
    Inno Setup's {app}.
  .PARAMETER PurgeState
    Also delete %ProgramData%\DPDP Gateway.
#>
#Requires -RunAsAdministrator
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [switch]$PurgeState
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServiceName = 'DPDPGatewayAgent'
$WinswExe = Join-Path $InstallDir 'DPDPGatewayAgent.exe'
$Root = Join-Path $env:ProgramData 'DPDP Gateway'

try {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.Status -ne 'Stopped') {
      Stop-Service -Name $ServiceName -Force
      $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    if (Test-Path -LiteralPath $WinswExe) {
      & $WinswExe uninstall | Out-Null
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      # WinSW missing (interrupted install) or its uninstall failed.
      & sc.exe delete $ServiceName | Out-Null
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
      throw "The '$ServiceName' service could not be removed (it may be marked for deletion until reboot)."
    }
    Write-Host 'DPDP Gateway Agent service removed.'
  } else {
    Write-Host "Service '$ServiceName' is not registered -- nothing to remove."
  }

  if ($PurgeState) {
    if (Test-Path -LiteralPath $Root) {
      Remove-Item -LiteralPath $Root -Recurse -Force
      Write-Host "Deleted $Root (device credential, sources, logs)."
    }
  } else {
    Write-Host "Kept $Root. This device is still paired with DPDP until it is removed in Gateway Setup or revoked in the dashboard."
  }
  exit 0
} catch {
  Write-Host "UNINSTALL FAILED: $($_.Exception.Message)"
  exit 1
}
