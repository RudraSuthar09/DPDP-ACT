<#
  .SYNOPSIS
    Stages the DPDP Platform desktop shell into desktop\dist, ready for
    installer\DPDP-Setup.iss.

  .DESCRIPTION
    Same pattern as gateway-app\scripts\package.ps1 (and the desktop staging
    step in installer\scripts\package-images.ps1, without the Docker image
    builds this desktop shell no longer needs): the raw Electron runtime
    binary + this app's own dependency-free source. No electron-builder /
    electron-packager. desktop\src uses only Node/Electron builtins, so no
    node_modules ships with the app itself -- only the Electron runtime does.

    Produces:
      desktop\dist\electron\electron.exe (+ its runtime files)
      desktop\dist\app\package.json
      desktop\dist\app\src\*            (tests excluded)

    The installer launches "{app}\electron\electron.exe" "{app}\app".
    Nothing here reads or copies any .env, key or credential.
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$AppDir = Resolve-Path (Join-Path $PSScriptRoot '..')

Write-Host "Installing desktop dependencies (Electron runtime)..."
Push-Location $AppDir
try {
  # --frozen-lockfile: a release build must install exactly what
  # pnpm-lock.yaml pins (including the Electron version), never re-resolve.
  pnpm install --frozen-lockfile --filter @dpdp/desktop
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install for @dpdp/desktop failed (is pnpm-lock.yaml up to date?).' }
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
Get-ChildItem (Join-Path $AppDir 'src') -File |
  Where-Object { $_.Name -notlike '*.test.js' } |
  Copy-Item -Destination "$OutDir\app\src" -Force

# Every module main.js loads must be present (a missing one fails only at
# runtime on the customer's machine).
$required = @('main.js', 'trusted-origin.js', 'enterprise-storage.js', 'dialog-bridge.js',
  'storage-preload.js', 'storage-fs-ops.js', 'storage-path-safety.js',
  'splash.html', 'splash-preload.js')
foreach ($f in $required) {
  if (-not (Test-Path (Join-Path "$OutDir\app\src" $f))) { throw "Staged desktop app is missing src\$f" }
}
# Release audit: nothing secret-looking may be staged.
$bad = Get-ChildItem $OutDir -Recurse -Force -File |
  Where-Object { $_.Name -like '.env*' -or $_.Extension -in '.pem', '.key', '.pfx', '.p12' }
if ($bad) { throw "Refusing to stage secret-looking files: $($bad.FullName -join ', ')" }

Write-Host "Done. Desktop shell staged in $OutDir"
