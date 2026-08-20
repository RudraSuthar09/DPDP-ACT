<#
  Shared helpers, dot-sourced by the other scripts in this directory. Not a
  standalone script itself.
#>

function Get-InstallRoot {
  # Scripts live at <InstallRoot>\scripts\*.ps1 both in the source repo
  # (installer\scripts\) and once installed (...\DPDP Platform\scripts\).
  return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-ComposeArgs([string]$InstallRoot) {
  # --env-file feeds Compose's OWN ${VAR} substitution in the YAML (e.g.
  # POSTGRES_PASSWORD in the postgres service's `environment:` block) -- a
  # SEPARATE mechanism from each service's own `env_file:` line, which only
  # injects vars into that container's process environment. Both are needed.
  return @(
    'compose', '-p', 'dpdp',
    '-f', (Join-Path $InstallRoot 'runtime\docker-compose.runtime.yml'),
    '--env-file', (Join-Path $InstallRoot 'config\.env')
  )
}

function Assert-DockerAvailable {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) {
    Write-Error @"
Docker was not found on this machine.

DPDP requires Docker Desktop for Windows (this is a documented prerequisite
for this version -- see installer\README.md). Install it from
https://www.docker.com/products/docker-desktop/, make sure it is RUNNING,
then run this installer again.
"@
    exit 1
  }
  # A failed native command does not throw in PowerShell -- check
  # $LASTEXITCODE explicitly rather than relying on try/catch.
  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'Docker Desktop does not appear to be running. Start Docker Desktop, wait for it to finish starting, then try again.'
    exit 1
  }
}
