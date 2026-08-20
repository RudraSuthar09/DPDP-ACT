<#
.SYNOPSIS
  Called by the Inno Setup uninstaller BEFORE it removes files. Stops and
  removes the containers/network.

  No local-database volume prompt here (architecture correction): this
  runtime has never created a local Postgres database, so there is no local
  compliance data to ask about keeping or deleting. All platform data lives
  in the existing central database, entirely unaffected by uninstalling
  this machine's runtime.
#>
. "$PSScriptRoot\common.ps1"
$root = Get-InstallRoot
Assert-DockerAvailable
$composeArgs = Get-ComposeArgs $root

Write-Output 'Stopping and removing DPDP containers...'
& docker @composeArgs down
if ($LASTEXITCODE -ne 0) {
  Write-Warning "docker compose down exited with code $LASTEXITCODE -- containers may still be running. You can stop them manually later with Docker Desktop."
}
