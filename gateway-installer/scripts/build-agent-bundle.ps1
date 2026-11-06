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
# Test-only helpers and TEST-ONLY TLS keys/certificates (src\__fixtures__).
$fixtures = Join-Path $AgentStage 'dist\__fixtures__'
if (Test-Path $fixtures) { Remove-Item -Recurse -Force $fixtures }

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
# The service scripts are staged too (setup.iss installs these copies), so
# MANIFEST.sha256 covers them: they run elevated, and collect-diagnostics.ps1
# verifies installed files against the manifest.
foreach ($script in @('install-service.ps1', 'uninstall-service.ps1', 'elevated-helper.ps1', 'collect-diagnostics.ps1')) {
  Copy-Item (Join-Path $InstallerDir "service\$script") (Join-Path $OutDir $script) -Force
}

# --- 3. Gateway Setup app -------------------------------------------------------
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $GatewayAppDir 'scripts\package.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Packaging gateway-app failed.' }
Copy-Item (Join-Path $GatewayAppDir 'dist') (Join-Path $OutDir 'gateway-app') -Recurse -Force
Remove-Matching (Join-Path $OutDir 'gateway-app\app') @('*.test.js')

# --- 4. Release audit: nothing secret or stateful ships --------------------------
# pnpm lays out node_modules with directory JUNCTIONS. Inno Setup FOLLOWS them
# (it installs their contents as real folders), but Get-ChildItem -Recurse
# does NOT. Until Phase 5 that let one junction -- the workspace's own
# @dpdp/agent entry, pointing back at the SOURCE agent folder (src, test
# fixtures, dev node_modules) -- be packed into the installer while being
# invisible to this audit and to MANIFEST.sha256. So: links pointing outside
# staging are removed (the link only, never its target), and every check
# below walks the tree exactly the way Inno Setup installs it.
$stagingRoot = [System.IO.Path]::GetFullPath($OutDir).TrimEnd('\')
function Test-InsideStaging([string]$Path) {
  return ($Path -eq $stagingRoot) -or $Path.StartsWith("$stagingRoot\", [StringComparison]::OrdinalIgnoreCase)
}
$dirStack = New-Object System.Collections.Stack
$dirStack.Push($stagingRoot)
while ($dirStack.Count -gt 0) {
  foreach ($d in Get-ChildItem -LiteralPath $dirStack.Pop() -Force -Directory) {
    if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $target = [string]($d.Target | Select-Object -First 1)
      if (-not $target -or -not (Test-InsideStaging ([System.IO.Path]::GetFullPath($target)))) {
        # Directory.Delete(path, $false) on a junction/symlink removes the LINK only.
        [System.IO.Directory]::Delete($d.FullName, $false)
        Write-Host "Removed link pointing outside staging: $($d.FullName.Substring($stagingRoot.Length + 1))"
      }
    } else {
      $dirStack.Push($d.FullName)
    }
  }
}

# Every file as Inno Setup will install it: Rel = install path, Full = real file.
function Get-InstallTree {
  $files = New-Object System.Collections.Generic.List[object]
  $work = New-Object System.Collections.Stack
  $work.Push(@($stagingRoot, '', @($stagingRoot.ToLowerInvariant())))
  while ($work.Count -gt 0) {
    $dir, $rel, $chain = $work.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
      $itemRel = if ($rel) { "$rel\$($item.Name)" } else { $item.Name }
      $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      if ($item.PSIsContainer) {
        $real = $item.FullName
        if ($isLink) {
          $real = [System.IO.Path]::GetFullPath([string]($item.Target | Select-Object -First 1))
          if (-not (Test-InsideStaging $real)) { throw "Release audit failed -- link points outside staging: $itemRel" }
        }
        if ($chain -contains $real.ToLowerInvariant()) { throw "Release audit failed -- link cycle in staging: $itemRel" }
        $work.Push(@($real, $itemRel, ($chain + $real.ToLowerInvariant())))
      } else {
        if ($isLink) { throw "Release audit failed -- file link in staging: $itemRel" }
        $files.Add([pscustomobject]@{ Rel = $itemRel; Full = $item.FullName; Name = $item.Name })
      }
    }
  }
  return $files
}
$installTree = Get-InstallTree
Write-Host "Install tree: $($installTree.Count) files (internal pnpm links followed, as Inno Setup does)."

$stateNames = @('device-credential.json', 'sources.json', 'pending-sources.json', 'pending-enrollment.json', 'pending-deenroll.json', 'proxy-credentials.json', 'agent.lock', 'config.json')
$forbidden = @($installTree | Where-Object {
    $n = $_.Name.ToLowerInvariant()
    ($n -eq '.env') -or ($n -like '.env.*') -or ($n -like '*.pem') -or ($n -like '*.key') -or ($n -like '*.pfx') -or ($n -like '*.p12') -or
    (($_.Rel -notmatch '\\node_modules\\') -and ($n -in $stateNames))
  })
if ($forbidden.Count -gt 0) {
  throw "Release audit failed -- these must not ship:`n$($forbidden.Rel -join "`n")"
}
$leftovers = @($installTree | Where-Object {
    $_.Rel -match '\\__fixtures__\\' -or $_.Rel -match '\\@dpdp\\agent\\src\\' -or (
      $_.Rel -notmatch '\\node_modules\\' -and ($_.Name -like '*.spec.*' -or $_.Name -like '*.test.*' -or $_.Name -like 'mock-*'))
  })
if ($leftovers.Count -gt 0) { throw "Release audit failed -- test files, fixtures, mocks or agent sources staged:`n$($leftovers.Rel -join "`n")" }

# Development-only dependencies of the agent must not ship (pnpm deploy --prod).
$devDeps = @((Get-Content -Raw (Join-Path $RepoRoot 'agent\package.json') | ConvertFrom-Json).devDependencies.PSObject.Properties.Name)
$devShipped = @($devDeps | Where-Object { Test-Path -LiteralPath (Join-Path $AgentStage "node_modules\$_") })
if ($devShipped.Count -gt 0) { throw "Release audit failed -- development dependencies staged: $($devShipped -join ', ')" }

# The code this release is supposed to contain is actually there.
$required = @(
  'agent\dist\index.js', 'agent\dist\cli-pair.js', 'agent\dist\transport.js', 'agent\dist\network-config.js',
  'agent\dist\tls-trust.js', 'agent\dist\source-tls.js', 'agent\dist\connectors\db\db-client.js',
  # Automatic folder registration: the approval queue the elevated helper
  # writes and the service exchanges for DPDP record ids.
  'agent\dist\pending-authorizations.js', 'agent\dist\startup-tasks.js',
  'agent\node_modules\undici\package.json', 'runtime\node.exe', 'DPDPGatewayAgent.exe', 'DPDPGatewayAgent.xml',
  'gateway-app\app\src\main.js', 'gateway-app\app\src\request-file.js', 'gateway-app\app\src\index.html',
  'gateway-app\electron\electron.exe'
)
# The release must actually CONTAIN this workflow, not just the files: a build
# from a stale tree would otherwise produce a wizard that still asks for ids.
$contentChecks = @(
  @{ Path = 'agent\dist\cli-pair.js'; Needle = 'authorize-folder'; What = 'the agent CLI accepts folder approvals' },
  @{ Path = 'agent\dist\pending-authorizations.js'; Needle = 'pending-authorizations.json'; What = 'the approval queue' },
  @{ Path = 'agent\dist\enrollment.js'; Needle = '/gateway/folders'; What = 'the folder-registration control-plane call' },
  @{ Path = 'gateway-app\app\src\index.html'; Needle = 'btn-sources-approve'; What = 'the wizard''s "Allow this folder" action' },
  @{ Path = 'gateway-app\app\src\preload.js'; Needle = 'authorizeFolder'; What = 'the wizard''s folder-approval bridge' },
  @{ Path = 'gateway-app\app\src\main.js'; Needle = 'openDirectory'; What = 'the native folder picker' },
  # The elevated helper must never flash a console window at a customer, and
  # must be told it will not be prompted (it would hang invisibly otherwise).
  @{ Path = 'gateway-app\app\src\elevated-command.js'; Needle = '-WindowStyle Hidden'; What = 'the hidden elevated console' },
  @{ Path = 'gateway-app\app\src\elevated-command.js'; Needle = '-NonInteractive'; What = 'the non-interactive helper invocation' },
  # Approving a folder must report its real outcome.
  @{ Path = 'gateway-app\app\src\renderer.js'; Needle = 'Folder allowed'; What = 'the folder-approval confirmation' },
  @{ Path = 'gateway-app\app\src\index.html'; Needle = 'id="sources-notice"'; What = 'the confirmation element' }
)
# Elevation itself must still be requested: a build that quietly dropped
# -Verb RunAs would run the helper unelevated and fail at every write.
$elevatedCmd = Join-Path $OutDir 'gateway-app\app\src\elevated-command.js'
if (-not (Select-String -LiteralPath $elevatedCmd -SimpleMatch '-Verb RunAs' -Quiet)) {
  throw 'Release audit failed -- the elevated helper no longer requests UAC elevation (-Verb RunAs).'
}
foreach ($check in $contentChecks) {
  $full = Join-Path $OutDir $check.Path
  if (-not (Test-Path -LiteralPath $full) -or -not (Select-String -LiteralPath $full -SimpleMatch $check.Needle -Quiet)) {
    throw "Release audit failed -- $($check.What) is missing from $($check.Path). Build from a tree that contains it."
  }
}
# And it must NOT still ask for a storage location id.
$wizardHtml = Join-Path $OutDir 'gateway-app\app\src\index.html'
if (Select-String -LiteralPath $wizardHtml -SimpleMatch 'id="source-storage-id"' -Quiet) {
  throw 'Release audit failed -- the wizard still asks for a Storage location ID.'
}
# Nothing from the central platform belongs in a Gateway installer.
$leaked = @($installTree | Where-Object { $_.Rel -match '\\(backend|frontend)\\' -or $_.Rel -match '\\@dpdp\\(backend|frontend)\\' })
if ($leaked.Count -gt 0) { throw "Release audit failed -- backend/frontend files staged:`n$($leaked.Rel -join "`n")" }
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $OutDir $_)) })
if ($missing.Count -gt 0) { throw "Release audit failed -- expected files missing: $($missing -join ', ')" }

# The staged WinSW descriptor must be valid XML that WinSW itself can load
# (a "--" inside an XML comment once made every service install fail).
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallerDir 'tests\validate-service-xml.ps1') -StagingDir $OutDir -AllowConfigChange
if ($LASTEXITCODE -ne 0) { throw 'Release audit failed -- DPDPGatewayAgent.xml is not a valid WinSW configuration (see above).' }
Write-Host 'Release audit passed (no .env, keys, certificates, Gateway state, tests, fixtures, mocks or dev dependencies staged; required files present).'

# --- 5. Manifest -------------------------------------------------------------------
# One entry per file AS INSTALLED (paths relative to {app}), including files
# reached through pnpm's internal links, which Inno Setup installs as copies.
$manifest = Join-Path $OutDir 'MANIFEST.sha256'
$manifestRel = 'MANIFEST.sha256'
$entries = @($installTree | Where-Object { $_.Rel -ne $manifestRel } | Sort-Object Rel)
$lines = $entries | ForEach-Object { "$((Get-FileHash -LiteralPath $_.Full -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Rel)" }
$header = @("# DPDP Gateway $AgentVersion install manifest (paths relative to the install directory)", "# node $NodeVersion ($NodeZipSha256 zip), WinSW $WinswVersion", "# electron: see gateway-app/node_modules/electron/package.json (pinned by pnpm-lock.yaml)")
[System.IO.File]::WriteAllLines($manifest, [string[]]($header + $lines), (New-Object System.Text.UTF8Encoding($false)))
if (@($lines).Count -ne $entries.Count -or @(Get-InstallTree).Count -ne ($entries.Count + 1)) {
  throw 'Manifest check failed: the manifest does not have exactly one entry per installed file.'
}
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
