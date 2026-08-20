. "$PSScriptRoot\common.ps1"
$root = Get-InstallRoot
Assert-DockerAvailable
$composeArgs = Get-ComposeArgs $root
Write-Output 'Restarting DPDP...'
& docker @composeArgs restart
if ($LASTEXITCODE -ne 0) { Write-Error "docker compose restart failed (exit $LASTEXITCODE)"; exit 1 }
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\health-check.ps1"
