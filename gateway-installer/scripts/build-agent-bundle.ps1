<#
  .SYNOPSIS
    Builds the staging tree for the DPDP Gateway installer and, with
    -Compile, the installer itself. No admin rights needed.

  .DESCRIPTION
    Produces gateway-installer\build\staging (gitignored):
      agent\                 production-only agent (pnpm deploy --prod), pruned
                             of sources, tests, configs and caches
      runtime\node.exe       pinned, SHA-256-verified Node.js
      DPDPGatewayAgent.exe   pinned, SHA-256-verified WinSW (renamed)
      DPDPGatewayAgent.xml   service descriptor
      gateway-app\           Electron runtime + the Gateway Setup app, pruned of tests
      MANIFEST.sha256        SHA-256 of every staged file (audit trail)

    Integrity (this script) is not authenticity: the hashes prove the
    downloads match what was reviewed and pinned here, not who published
    the final installer. Publisher authenticity needs Authenticode signing,
    which is blocked until a real certificate exists (see README).

    Release checks that FAIL the build:
      - agent, gateway-app and installer versions disagree;
      - a pinned download does not match its hash;
      - the staging tree contains a .env file, a private key/certificate, or
        any Gateway runtime state (device credential, sources, pending
        hand-off files, config.json written by a dev run).

  .PARAMETER Compile
    Also run Inno Setup (ISCC.exe) to produce gateway-installer\dist\DPDPGatewaySetup-<version>.exe.
  .PARAMETER IsccPath
    Path to ISCC.exe; searched in the usual install locations if omitted.
  .PARAMETER SkipDownloads
    Require the cached downloads (build\cache) instead of fetching; still verified.
#>
param(
  [string]$OutDir = ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\staging'))),
  [switch]$SkipDownloads,
  [switch]$Compile,
  [string]$IsccPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- Pinned third-party artifacts (change deliberately, after review) -------
$NodeVersion = '22.17.0'
$NodeZipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$NodeZipSha256 = '721ab118a3aac8584348b132767eadf51379e0616f0db802cc1e66d7f0d98f85'   # from nodejs.org SHASUMS256.txt

$WinswVersion = '2.12.0'
$WinswUrl = "https://github.com/winsw/winsw/releases/download/v$WinswVersion/WinSW-x64.exe"
$WinswSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$InstallerDir = Join-Path $RepoRoot 'gateway-installer'
$CacheDir = Join-Path $InstallerDir 'build\cache'
$GatewayAppDir = Join-Path $RepoRoot 'gateway-app'

function Get-PackageVersion([string]$PackageJson) {
  return (Get-Content -Raw $PackageJson | ConvertFrom-Json).version
}

function Get-VerifiedDownload([string]$Url, [string]$Sha256, [string]$FileName, [string]$Label) {
  if (-not $Url.StartsWith('https://')) { throw "$Label must be downloaded over HTTPS." }
  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $target = Join-Path $CacheDir $FileName
  $ok = (Test-Path $target) -and ((Get-FileHash -Path $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256)
  if (-not $ok) {
    if ($SkipDownloads) { throw "$Label is not in $CacheDir (or does not match its pinned hash) and -SkipDownloads was given." }
    Write-Host "Downloading $Label from $Url ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $tmp = "$target.part"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    $actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
      Remove-Item $tmp -Force
      throw "$Label checksum mismatch: expected $Sha256, got $actual. Refusing to use it."
    }
    Move-Item -Force $tmp $target
  }
  Write-Host "$Label verified (sha256 $Sha256)."
  return $target
}

function Remove-Matching([string]$Root, [string[]]$Patterns) {
  foreach ($pattern in $Patterns) {
    Get-ChildItem -LiteralPath $Root -Recurse -Force -Filter $pattern -ErrorAction SilentlyContinue |
      Where-Object { -not $_.PSIsContainer -and $_.FullName -notmatch '\\node_modules\\' } |
      Remove-Item -Force
  }
}

Write-Host '=== DPDP Gateway installer build ==='

# --- 0. One version everywhere ------------------------------------------------
$AgentVersion = Get-PackageVersion (Join-Path $RepoRoot 'agent\package.json')
$AppVersion = Get-PackageVersion (Join-Path $GatewayAppDir 'package.json')
$AgentVersionTs = (Select-String -Path (Join-Path $RepoRoot 'agent\src\version.ts') -Pattern "AGENT_VERSION\s*=\s*'([^']+)'").Matches[0].Groups[1].Value
if ($AgentVersion -ne $AppVersion -or $AgentVersion -ne $AgentVersionTs) {
  throw "Version mismatch: agent/package.json=$AgentVersion, agent/src/version.ts=$AgentVersionTs, gateway-app/package.json=$AppVersion. Align them before building a release."
}
Write-Host "Version: $AgentVersion"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'runtime') | Out-Null

# --- 1. Agent: build, deploy production deps, prune ---------------------------
Push-Location $RepoRoot
try {
  pnpm --filter @dpdp/shared build
  if ($LASTEXITCODE -ne 0) { throw 'Building @dpdp/shared failed.' }
  pnpm --filter @dpdp/agent build
  if ($LASTEXITCODE -ne 0) { throw 'Building @dpdp/agent failed.' }
  $AgentStage = Join-Path $OutDir 'agent'
  pnpm --filter @dpdp/agent deploy --prod $AgentStage
  if ($LASTEXITCODE -ne 0) { throw 'pnpm deploy for @dpdp/agent failed.' }
} finally {
  Pop-Location
}

# Known pnpm-on-Windows quirk: without symlink privilege its .bin-shim
# fallback can create a stray directory chain inside the SOURCE package
# (agent\gateway-installer\...). Remove it so the source tree stays clean.
$stray = Join-Path $RepoRoot 'agent\gateway-installer'
if (Test-Path $stray) { cmd /c "rmdir /s /q `"$stray`"" | Out-Null }

# Ship only what runs: compiled JS + production node_modules + package.json.
foreach ($name in @('src', '.turbo', 'Dockerfile', '.env.example', 'eslint.config.mjs', 'jest.config.js', 'tsconfig.json', 'README.md', 'coverage')) {
  $p = Join-Path $AgentStage $name
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Remove-Matching (Join-Path $AgentStage 'dist') @('*.spec.js', '*.spec.d.ts', '*.spec.js.map', '*.d.ts', '*.js.map', '*.d.ts.map')

# --- 2. Pinned runtime + service wrapper ----------------------------------------
$nodeZip = Get-VerifiedDownload $NodeZipUrl $NodeZipSha256 "node-v$NodeVersion-win-x64.zip" "Node.js v$NodeVersion"
$extract = Join-Path $CacheDir "node-v$NodeVersion-extract"
if (-not (Test-Path (Join-Path $extract "node-v$NodeVersion-win-x64\node.exe"))) {
  if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
  Expand-Archive -Path $nodeZip -DestinationPath $extract
}
Copy-Item (Join-Path $extract "node-v$NodeVersion-win-x64\node.exe") (Join-Path $OutDir 'runtime\node.exe') -Force

$winsw = Get-VerifiedDownload $WinswUrl $WinswSha256 "WinSW-$WinswVersion-x64.exe" "WinSW v$WinswVersion"
Copy-Item $winsw (Join-Path $OutDir 'DPDPGatewayAgent.exe') -Force
Copy-Item (Join-Path $InstallerDir 'service\DPDPGatewayAgent.xml') (Join-Path $OutDir 'DPDPGatewayAgent.xml') -Force

# --- 3. Gateway Setup app -------------------------------------------------------
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GatewayAppDir 'scripts\package.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Packaging gateway-app failed.' }
Copy-Item (Join-Path $GatewayAppDir 'dist') (Join-Path $OutDir 'gateway-app') -Recurse -Force
Remove-Matching (Join-Path $OutDir 'gateway-app\app') @('*.test.js')

# --- 4. Release audit: nothing secret or stateful ships --------------------------
$forbidden = @(Get-ChildItem -LiteralPath $OutDir -Recurse -Force -File | Where-Object {
    $n = $_.Name.ToLowerInvariant()
    ($n -eq '.env') -or ($n -like '.env.*') -or ($n -like '*.pem') -or ($n -like '*.key') -or ($n -like '*.pfx') -or ($n -like '*.p12') -or
    (($_.FullName -notmatch '\\node_modules\\') -and ($n -in @('device-credential.json', 'sources.json', 'pending-sources.json', 'pending-enrollment.json', 'pending-deenroll.json', 'agent.lock', 'config.json')))
  })
if ($forbidden.Count -gt 0) {
  throw "Release audit failed -- these must not ship:`n$($forbidden.FullName -join "`n")"
}
$leftovers = @(Get-ChildItem -LiteralPath $OutDir -Recurse -Force -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' -and ($_.Name -like '*.spec.*' -or $_.Name -like '*.test.*') })
if ($leftovers.Count -gt 0) { throw "Release audit failed -- test files staged:`n$($leftovers.FullName -join "`n")" }
Write-Host 'Release audit passed (no .env, keys, certificates, Gateway state or test files staged).'

# --- 5. Manifest -------------------------------------------------------------------
$manifest = Join-Path $OutDir 'MANIFEST.sha256'
$lines = Get-ChildItem -LiteralPath $OutDir -Recurse -Force -File | Where-Object { $_.FullName -ne $manifest } | Sort-Object FullName | ForEach-Object {
  "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.FullName.Substring($OutDir.Length + 1))"
}
$header = @("# DPDP Gateway $AgentVersion staging manifest", "# node $NodeVersion ($NodeZipSha256 zip), WinSW $WinswVersion", "# electron: see gateway-app/node_modules/electron/package.json (pinned by pnpm-lock.yaml)")
[System.IO.File]::WriteAllLines($manifest, [string[]]($header + $lines), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Manifest: $($lines.Count) files -> $manifest"

# --- 6. Optional: compile the installer ----------------------------------------------
if ($Compile) {
  if (-not $IsccPath) {
    $IsccPath = @(
      "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
      "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
      "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $IsccPath) { throw 'ISCC.exe (Inno Setup 6) not found. Pass -IsccPath.' }
  & $IsccPath "/DMyAppVersion=$AgentVersion" (Join-Path $InstallerDir 'setup.iss')
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
  $exe = Join-Path $InstallerDir "dist\DPDPGatewaySetup-$AgentVersion.exe"
  Write-Host "Installer: $exe"
  Write-Host "SHA-256:   $((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant())"
  Write-Host 'UNSIGNED -- see gateway-installer/README.md (code signing is a release blocker).'
}

Write-Host '=== Done ==='
