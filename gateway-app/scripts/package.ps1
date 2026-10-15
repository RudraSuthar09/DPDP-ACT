<#
  .SYNOPSIS
    Stages the Gateway Setup app into gateway-app\dist, ready for
    gateway-installer\scripts\build-agent-bundle.ps1 to copy into the
    installer's staging directory.

  .DESCRIPTION
    Ships the raw Electron runtime binary + this app's own tiny,
    dependency-free source directly (no electron-builder/electron-packager
    -- same reasoning and same pattern as installer\scripts\
    package-images.ps1's existing desktop-shell staging: shipping
    `electron.exe <app-dir>` is the same thing a packager would produce,
    without fighting pnpm's strict node_modules isolation on a toolchain
    this app doesn't otherwise need). gateway-app\src only uses Node/
    Electron builtins, so no node_modules ships with the app itself --
    only the Electron runtime does.

    Produces:
      gateway-app\dist\electron\electron.exe (+ its runtime files)
      gateway-app\dist\app\package.json
      gateway-app\dist\app\src\*

    The Inno Setup installer's [Icons]/[Run] sections launch
    "{app}\gateway-app\electron\electron.exe" "{app}\gateway-app\app"
    -- the same explicit-app-directory invocation style the existing
    desktop shell's shortcuts already use.
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$AppDir = Join-Path $PSScriptRoot '..'

Write-Host "Installing gateway-app dependencies (Electron runtime)..."
Push-Location $AppDir
try {
  # --frozen-lockfile: a release build must install exactly what
  # pnpm-lock.yaml pins (including the Electron version), never re-resolve.
  pnpm install --frozen-lockfile --filter @dpdp/gateway-app
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install for @dpdp/gateway-app failed (is pnpm-lock.yaml up to date?).' }
} finally {
  Pop-Location
}

Remove-Item $OutDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$OutDir\electron" | Out-Null
New-Item -ItemType Directory -Force -Path "$OutDir\app\src" | Out-Null

$electronDist = Join-Path $AppDir 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
  throw "Electron runtime not found at $electronDist -- did 'pnpm install' succeed?"
}
Copy-Item "$electronDist\*" -Destination "$OutDir\electron" -Recurse -Force
Copy-Item (Join-Path $AppDir 'package.json') -Destination "$OutDir\app\package.json" -Force
Copy-Item (Join-Path $AppDir 'src\*') -Destination "$OutDir\app\src" -Recurse -Force

Write-Host "Done. Gateway Setup app staged in $OutDir"
