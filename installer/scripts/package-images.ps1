<#
.SYNOPSIS
  Release-packaging step -- WE run this, not the customer. Builds the three
  Docker images (reusing the existing, already-verified docker-compose.yml
  build definitions) plus the installer-specific frontend variant, then
  exports each to a .tar the Inno Setup installer bundles and `docker load`s
  at install time. This is what turns "docker compose build works" into
  "a customer never needs pnpm/node/the source tree."
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)


# NOTE: deliberately NOT using $ErrorActionPreference = 'Stop'. Docker's CLI
# writes normal build progress to stderr; PowerShell 5.1 wraps redirected
# stderr lines as (non-terminating) ErrorRecords, which 'Stop' would escalate
# into aborting this whole script on ordinary, successful output. Instead we
# check $LASTEXITCODE explicitly after each command that actually matters.
Set-Location $RepoRoot

$outDir = Join-Path $PSScriptRoot '..\dist\images'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Invoke-Checked([string]$Description, [scriptblock]$Command) {
  Write-Output "=== $Description ==="
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (exit code $LASTEXITCODE)"
  }
}

Invoke-Checked 'Building the standard images (backend, frontend, agent) via the existing docker-compose.yml' {
  docker compose build backend frontend agent
}

Invoke-Checked 'Building the installer-specific frontend variant (NEXT_PUBLIC_REQUIRE_ACTIVATION=true)' {
  docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:3001 --build-arg NEXT_PUBLIC_REQUIRE_ACTIVATION=true -t dpdp-frontend:installer .
}

$images = @(
  @{ Tag = 'dpdp-backend:local';     File = 'dpdp-backend.tar' },
  @{ Tag = 'dpdp-frontend:installer'; File = 'dpdp-frontend-installer.tar' },
  @{ Tag = 'dpdp-agent:local';       File = 'dpdp-agent.tar' }
)

foreach ($img in $images) {
  $out = Join-Path $outDir $img.File
  Invoke-Checked "Exporting $($img.Tag) -> $out" {
    docker save -o $out $img.Tag
  }
}

Write-Output "Done. Images staged in $outDir"
Get-ChildItem $outDir | Select-Object Name, @{Name = 'SizeMB'; Expression = { [math]::Round($_.Length / 1MB, 1) } }

# --- Desktop shell staging --------------------------------------------------
# Ships the raw Electron runtime binary + our own tiny, dependency-free app
# source directly (no electron-packager -- it fights pnpm's strict node_modules
# isolation on transitive deps like @electron/get/debug; shipping
# `electron.exe <app-dir>` is the same thing electron-packager would produce,
# without that tooling). desktop/src only uses Node/Electron builtins, so no
# node_modules needs to ship with it.
Invoke-Checked 'Installing desktop shell dependencies (Electron runtime)' {
  pnpm --filter @dpdp/desktop install
}

$desktopOut = Join-Path $PSScriptRoot '..\dist\desktop'
Remove-Item $desktopOut -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$desktopOut\electron" | Out-Null
New-Item -ItemType Directory -Force -Path "$desktopOut\app\src" | Out-Null

$electronDist = Join-Path $RepoRoot 'desktop\node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
  throw "Electron runtime not found at $electronDist -- did 'pnpm --filter @dpdp/desktop install' succeed?"
}
Copy-Item "$electronDist\*" -Destination "$desktopOut\electron" -Recurse -Force
Copy-Item (Join-Path $RepoRoot 'desktop\package.json') -Destination "$desktopOut\app\package.json" -Force
Copy-Item (Join-Path $RepoRoot 'desktop\src\*') -Destination "$desktopOut\app\src" -Recurse -Force

Write-Output "Done. Desktop shell staged in $desktopOut"
