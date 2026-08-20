. "$PSScriptRoot\common.ps1"
$root = Get-InstallRoot
Assert-DockerAvailable
$composeArgs = Get-ComposeArgs $root
Write-Output 'Stopping DPDP...'
& docker @composeArgs stop
if ($LASTEXITCODE -ne 0) { Write-Error "docker compose stop failed (exit $LASTEXITCODE)"; exit 1 }
