<#
  .SYNOPSIS
    Read-only check, run by installer\DPDP-Setup.iss after it has run the
    bundled DPDP Gateway installer: is the DPDPGatewayAgent Windows service
    registered, configured for automatic start under its own virtual account,
    and running?

  .DESCRIPTION
    Changes nothing. The Gateway's own installer (gateway-installer\setup.iss)
    exits 0 even when its service step fails (it reports that in a dialog,
    which a silent install suppresses), so DPDP-Setup must not trust its exit
    code alone. Exit codes (mapped to messages by DPDP-Setup.iss):
      0   registered, Automatic start, NT SERVICE\DPDPGatewayAgent, Running
      10  service not registered
      11  start type is not Automatic
      12  service account is not NT SERVICE\DPDPGatewayAgent
      13  not Running within the wait period
      14  unexpected error while checking
#>
param(
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
$name = 'DPDPGatewayAgent'

try {
  $svc = Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'"
  if (-not $svc) { Write-Output "Service $name is not registered."; exit 10 }

  if ($svc.StartMode -ne 'Auto') { Write-Output "Service $name start type is '$($svc.StartMode)', expected Auto."; exit 11 }

  if ($svc.StartName -ne "NT SERVICE\$name") { Write-Output "Service $name runs as '$($svc.StartName)', expected NT SERVICE\$name."; exit 12 }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ($true) {
    $state = (Get-CimInstance -ClassName Win32_Service -Filter "Name='$name'").State
    if ($state -eq 'Running') { break }
    if ((Get-Date) -ge $deadline) { Write-Output "Service $name is '$state', expected Running."; exit 13 }
    Start-Sleep -Seconds 2
  }

  Write-Output "Service $name is registered, Automatic, NT SERVICE\$name, Running."
  exit 0
} catch {
  Write-Output "Could not check service ${name}: $($_.Exception.Message)"
  exit 14
}
