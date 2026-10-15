<#
  DPDP Gateway -- acceptance / support evidence collector.

  READ-ONLY. Collects what an administrator (or DPDP support) needs to
  investigate an installed Gateway, into a folder and a .zip:
    - service registration (account, start type, recovery, SID type) and state
    - directory ACLs for the install, config and state directories
    - config.json, REDACTED (proxy host, NO_PROXY entries, CA file path removed)
    - CA bundle summary (count, CA flag, validity dates, thumbprints -- public data)
    - state directory: file NAMES, sizes and formats only -- never contents
    - the local /health status (labels and counts; no secrets by design)
    - the last lines of the service logs, REDACTED
    - Service Control Manager events for the Gateway service
    - integrity of installed files against MANIFEST.sha256

  It never decrypts anything, never prints a credential file, does not change
  the service or any permission, and does not make network calls other than to
  the Gateway's own loopback /health endpoint. It deliberately does NOT test
  internet connectivity itself: a test from this (administrator) session would
  not use the service's proxy, CA or identity and could mislead. The service's
  own status ("network.lastErrorCode", "enrollmentError") is the evidence.

  Run from an elevated PowerShell (the state directory and logs are readable
  only by Administrators and the service):
    powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\DPDP Gateway\collect-diagnostics.ps1"
  Review the output before sending it to anyone.
#>
[CmdletBinding()]
param(
  [string]$OutputDir,
  [string]$InstallDir = $PSScriptRoot,
  [string]$DataRoot = (Join-Path $env:ProgramData 'DPDP Gateway'),
  [string]$ServiceName = 'DPDPGatewayAgent',
  [int]$LogLines = 300,
  [switch]$SkipManifestCheck,
  [switch]$NoZip
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ConfigDir = Join-Path $DataRoot 'config'
$StateDir = Join-Path $DataRoot 'state'
$LogsDir = Join-Path $StateDir 'logs'
if (-not $OutputDir) {
  $OutputDir = Join-Path ([Environment]::GetFolderPath('Desktop')) ('DPDP-Gateway-Diagnostics-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$Report = Join-Path $OutputDir 'report.txt'
$script:Lines = New-Object System.Collections.Generic.List[string]

function Add-Line([string]$Text = '') { $script:Lines.Add($Text) }
function Add-Section([string]$Title) { Add-Line ''; Add-Line ('=' * 72); Add-Line $Title; Add-Line ('=' * 72) }

# Same intent as agent/src/logger.ts redactSecrets, plus JWT-shaped values.
function Protect-Text([string]$Text) {
  if ($null -eq $Text) { return $Text }
  $t = $Text
  $t = [regex]::Replace($t, 'eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*', '[REDACTED-JWT]')
  $t = [regex]::Replace($t, '(?i)((?:proxy-)?authorization)["'']?\s*[:=]\s*["'']?(?:(?:basic|bearer|negotiate|ntlm|digest)\s+)?[^"''\s,}]+', '$1: [REDACTED]')
  $t = [regex]::Replace($t, '(?i)(device[-_]?token|enrollment[-_]?code|enrolment[-_]?code|password|secret|x-gateway-[a-z-]*token)["'']?\s*[:=]\s*["'']?[^"''\s&,}]+', '$1=[REDACTED]')
  $t = [regex]::Replace($t, '(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@"'']+@', '$1[REDACTED]@')
  return $t
}

function Invoke-Capture([string]$File, [string[]]$Arguments) {
  # Native tools: capture output and exit code; never throw on stderr text.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
    return @{ Code = $LASTEXITCODE; Output = ($out -join "`r`n") }
  } catch {
    return @{ Code = -1; Output = "failed to run ${File}: $($_.Exception.Message)" }
  } finally {
    $ErrorActionPreference = $prev
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$summary = [ordered]@{
  collectedAt = (Get-Date).ToUniversalTime().ToString('o')
  elevated = $isAdmin
  serviceInstalled = $false
  serviceAccount = $null
  serviceState = $null
  agentVersion = $null
  statusReachable = $false
  enrolled = $null
  credentialProtection = $null
  enrollmentError = $null
  heartbeat = $null
  lastHeartbeatAt = $null
  networkProxy = $null
  networkLastErrorCode = $null
  manifestMismatches = $null
  warnings = @()
}
function Add-Warning([string]$Text) { $summary.warnings += $Text; Add-Line "WARNING: $Text" }

Add-Line 'DPDP Gateway diagnostics (read-only; secrets redacted -- review before sharing)'
Add-Line "Collected (UTC): $($summary.collectedAt)"
Add-Line "Elevated: $isAdmin"
Add-Line "Windows: $([Environment]::OSVersion.VersionString); PowerShell $($PSVersionTable.PSVersion)"
if (-not $isAdmin) { Add-Warning 'Not elevated: the state directory, logs and some ACLs cannot be read. Re-run from an elevated PowerShell.' }

# --- 1. Installation ------------------------------------------------------------
Add-Section '1. Installation'
Add-Line "Install directory: $InstallDir"
$pkg = Join-Path $InstallDir 'agent\package.json'
if (Test-Path -LiteralPath $pkg) {
  try { $summary.agentVersion = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version } catch { }
  Add-Line "Agent version: $($summary.agentVersion)"
} else {
  Add-Warning 'agent\package.json not found under the install directory.'
}
$manifest = Join-Path $InstallDir 'MANIFEST.sha256'
if ($SkipManifestCheck) {
  Add-Line 'Manifest check: skipped (-SkipManifestCheck).'
} elseif (Test-Path -LiteralPath $manifest) {
  $bad = New-Object System.Collections.Generic.List[string]
  $total = 0
  foreach ($line in Get-Content -LiteralPath $manifest) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { continue }
    $total++
    $file = Join-Path $InstallDir $Matches[2]
    if (-not (Test-Path -LiteralPath $file)) { $bad.Add("missing: $($Matches[2])"); continue }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches[1]) { $bad.Add("changed: $($Matches[2])") }
  }
  $summary.manifestMismatches = $bad.Count
  Add-Line "Manifest check: $total files listed, $($bad.Count) missing or changed."
  $bad | Select-Object -First 50 | ForEach-Object { Add-Line "  $_" }
} else {
  Add-Warning 'MANIFEST.sha256 not found; installed-file integrity not checked.'
}

# --- 2. Service -----------------------------------------------------------------
Add-Section '2. Windows Service'
$qc = Invoke-Capture "$env:SystemRoot\System32\sc.exe" @('qc', $ServiceName)
if ($qc.Code -ne 0) {
  Add-Warning "Service '$ServiceName' is not installed (sc qc exit code $($qc.Code))."
} else {
  $summary.serviceInstalled = $true
  Add-Line $qc.Output
  if ($qc.Output -match 'SERVICE_START_NAME\s*:\s*(.+)') { $summary.serviceAccount = $Matches[1].Trim() }
  if ($summary.serviceAccount -ne "NT SERVICE\$ServiceName") {
    Add-Warning "Service account is '$($summary.serviceAccount)', expected 'NT SERVICE\$ServiceName'."
  }
  foreach ($scArgs in @(@('query', $ServiceName), @('qfailure', $ServiceName), @('qsidtype', $ServiceName), @('showsid', $ServiceName))) {
    Add-Line ''
    Add-Line "> sc.exe $($scArgs -join ' ')"
    Add-Line (Invoke-Capture "$env:SystemRoot\System32\sc.exe" $scArgs).Output
  }
  try {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    $summary.serviceState = $svc.State
    Add-Line ''
    Add-Line "State: $($svc.State); StartMode: $($svc.StartMode); ProcessId: $($svc.ProcessId)"
  } catch { Add-Line "Win32_Service query failed: $($_.Exception.Message)" }
}

# --- 3. ACLs --------------------------------------------------------------------
Add-Section '3. Directory permissions (icacls)'
Add-Line 'Expected: install dir and config dir writable ONLY by SYSTEM and Administrators;'
Add-Line 'state dir: SYSTEM/Administrators full, the service SID modify, NO access for Users.'
foreach ($dir in @($InstallDir, $DataRoot, $ConfigDir, $StateDir, $LogsDir)) {
  Add-Line ''
  Add-Line "> icacls `"$dir`""
  if (Test-Path -LiteralPath $dir) { Add-Line (Invoke-Capture "$env:SystemRoot\System32\icacls.exe" @($dir)).Output } else { Add-Line '(does not exist)' }
}

# --- 4. Configuration (redacted) ------------------------------------------------
Add-Section '4. config.json (redacted)'
$configFile = Join-Path $ConfigDir 'config.json'
$bindPort = 7071
if (Test-Path -LiteralPath $configFile) {
  try {
    $cfg = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $shown = [ordered]@{}
    foreach ($p in $cfg.PSObject.Properties) {
      switch ($p.Name) {
        'proxy' {
          if ($p.Value -is [string]) { $shown.proxy = $p.Value }
          else {
            $scheme = '?'; $port = '?'
            try { $u = [Uri]$p.Value.url; $scheme = $u.Scheme; $port = $u.Port } catch { }
            $hasUserInfo = ([string]$p.Value.url) -match '://[^/@]+@'
            $noProxyCount = 0
            if ($p.Value.PSObject.Properties['noProxy']) { $noProxyCount = @($p.Value.noProxy).Count }
            $shown.proxy = "url: ${scheme}://<host redacted>:$port (user info present: $hasUserInfo); noProxy entries: $noProxyCount"
            if ($hasUserInfo) { Add-Warning 'config.json proxy.url contains user info; the Gateway refuses this (use proxy-credentials.json).' }
          }
        }
        'tls' {
          $t = $p.Value
          $extra = $null
          if ($t.PSObject.Properties['extraCaCertsFile']) { $extra = '<set>' }
          $store = $false
          if ($t.PSObject.Properties['useWindowsCertificateStore']) { $store = $t.useWindowsCertificateStore }
          $shown.tls = "extraCaCertsFile: $extra; useWindowsCertificateStore: $store"
        }
        'bindPort' { $bindPort = [int]$p.Value; $shown.bindPort = $p.Value }
        default { $shown[$p.Name] = Protect-Text ([string]($p.Value | ConvertTo-Json -Compress -Depth 4)) }
      }
    }
    $shown.GetEnumerator() | ForEach-Object { Add-Line ("{0}: {1}" -f $_.Key, $_.Value) }

    if ($cfg.PSObject.Properties['tls'] -and $cfg.tls.PSObject.Properties['extraCaCertsFile']) {
      Add-Line ''
      Add-Line 'CA bundle (public certificate data only):'
      $caPath = [string]$cfg.tls.extraCaCertsFile
      if (-not [IO.Path]::IsPathRooted($caPath)) { $caPath = Join-Path $ConfigDir $caPath }
      if (Test-Path -LiteralPath $caPath) {
        $pem = Get-Content -LiteralPath $caPath -Raw
        if ($pem -match 'PRIVATE KEY') { Add-Warning 'The CA bundle contains a PRIVATE KEY; remove it (the Gateway refuses this file).' }
        $blocks = [regex]::Matches($pem, '-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----')
        Add-Line "  certificates: $($blocks.Count)"
        foreach ($b in $blocks) {
          try {
            $body = ($b.Value -replace '-----(BEGIN|END) CERTIFICATE-----', '') -replace '\s', ''
            $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (,[Convert]::FromBase64String($body))
            $isCa = $false
            foreach ($ext in $c.Extensions) { if ($ext -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]) { $isCa = $ext.CertificateAuthority } }
            Add-Line ("  - thumbprint {0}; CA: {1}; valid {2:yyyy-MM-dd} to {3:yyyy-MM-dd}" -f $c.Thumbprint, $isCa, $c.NotBefore, $c.NotAfter)
            if ($c.NotAfter -lt (Get-Date)) { Add-Warning "CA certificate $($c.Thumbprint) has expired." }
          } catch { Add-Line "  - (unparseable certificate)" }
        }
      } else {
        Add-Warning 'tls.extraCaCertsFile is set but the file was not found.'
      }
    }
  } catch {
    Add-Warning "config.json could not be parsed: $($_.Exception.Message)"
  }
} else {
  Add-Line '(no config.json)'
}

# --- 5. State directory (names, sizes, formats; NEVER contents) ------------------
Add-Section '5. State directory (file names and formats only)'
if (Test-Path -LiteralPath $StateDir) {
  try {
    Get-ChildItem -LiteralPath $StateDir -File -Force | Sort-Object Name | ForEach-Object {
      $note = ''
      if ($_.Name -in @('sources.json', 'proxy-credentials.json')) {
        try {
          $j = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
          if ($j -is [array]) { $note = "legacy plaintext format (v1), $($j.Count) source(s) -- the service migrates it on start" }
          elseif ($j.PSObject.Properties['format']) {
            $note = "format $($j.format) v$($j.version)"
            if ($j.PSObject.Properties['sources']) { $note += ", $(@($j.sources).Count) source(s)" }
          } else { $note = 'PLAIN form (not yet protected by the service -- restart the service)' }
        } catch { $note = 'not valid JSON' }
        Remove-Variable j -ErrorAction SilentlyContinue
      }
      Add-Line ("{0,-28} {1,10} bytes  {2:yyyy-MM-dd HH:mm}  {3}" -f $_.Name, $_.Length, $_.LastWriteTime, $note)
    }
  } catch {
    Add-Warning "State directory not readable: $($_.Exception.Message)"
  }
} else {
  Add-Line '(state directory does not exist)'
}

# --- 6. Live status ------------------------------------------------------------
Add-Section '6. Live status (GET http://127.0.0.1:<port>/health, local caller)'
try {
  $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$bindPort/health")
  $req.Proxy = $null          # loopback: never through a proxy
  $req.Timeout = 5000
  $resp = $req.GetResponse()
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  $body = $reader.ReadToEnd()
  $reader.Close(); $resp.Close()
  $summary.statusReachable = $true
  $status = $body | ConvertFrom-Json
  Set-Content -LiteralPath (Join-Path $OutputDir 'status.json') -Value (Protect-Text $body) -Encoding UTF8
  Add-Line (Protect-Text $body)
  if ($status.PSObject.Properties['gateway']) {
    $g = $status.gateway
    $summary.enrolled = $g.enrolled
    $summary.credentialProtection = $g.credentialProtection
    $summary.enrollmentError = $g.enrollmentError
    $summary.heartbeat = $g.heartbeat
    $summary.lastHeartbeatAt = $g.lastHeartbeatAt
    if ($g.PSObject.Properties['network']) {
      $summary.networkProxy = $g.network.proxy
      $summary.networkLastErrorCode = $g.network.lastErrorCode
    }
    if ($g.credentialProtection -ne 'dpapi') { Add-Warning "credentialProtection is '$($g.credentialProtection)', expected 'dpapi'." }
  }
} catch {
  Add-Warning "The Gateway's local status endpoint did not answer on port ${bindPort}: $($_.Exception.Message)"
}

# --- 7. Logs (redacted tail) --------------------------------------------------------
Add-Section "7. Service logs (last $LogLines lines each, redacted)"
$logOut = Join-Path $OutputDir 'logs-redacted'
New-Item -ItemType Directory -Force -Path $logOut | Out-Null
$logSources = @()
if (Test-Path -LiteralPath $LogsDir) {
  try { $logSources += @(Get-ChildItem -LiteralPath $LogsDir -File -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 6) } catch { Add-Warning "Logs not readable: $($_.Exception.Message)" }
}
$installLog = Join-Path $InstallDir 'install-service.log'
if (Test-Path -LiteralPath $installLog) { $logSources += Get-Item -LiteralPath $installLog }
foreach ($log in $logSources) {
  $tail = Get-Content -LiteralPath $log.FullName -Tail $LogLines -ErrorAction SilentlyContinue
  $redacted = @($tail | ForEach-Object { Protect-Text $_ })
  Set-Content -LiteralPath (Join-Path $logOut ($log.Name + '.txt')) -Value $redacted -Encoding UTF8
  Add-Line "$($log.Name): $($redacted.Count) line(s) -> logs-redacted\$($log.Name).txt"
}
if ($logSources.Count -eq 0) { Add-Line '(no logs found)' }

# --- 8. Service Control Manager events -------------------------------------------
Add-Section '8. Service Control Manager events (last 30 mentioning the service)'
try {
  $events = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager' } -MaxEvents 500 -ErrorAction Stop |
    Where-Object { $_.Message -match [regex]::Escape($ServiceName) -or $_.Message -match 'DPDP Gateway' } | Select-Object -First 30
  if ($events) { $events | ForEach-Object { Add-Line ("{0:u}  id {1}  {2}" -f $_.TimeCreated.ToUniversalTime(), $_.Id, (Protect-Text ($_.Message -replace '\s+', ' '))) } }
  else { Add-Line '(none)' }
} catch {
  Add-Line "(could not read the System event log: $($_.Exception.Message))"
}

# --- Output ------------------------------------------------------------------------
Add-Section 'Summary'
$summaryJson = $summary | ConvertTo-Json -Depth 4
Add-Line $summaryJson
Set-Content -LiteralPath (Join-Path $OutputDir 'summary.json') -Value $summaryJson -Encoding UTF8
Set-Content -LiteralPath $Report -Value $script:Lines -Encoding UTF8

if (-not $NoZip) {
  $zip = "$OutputDir.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -Path (Join-Path $OutputDir '*') -DestinationPath $zip
  Write-Host "Diagnostics written to $zip"
} else {
  Write-Host "Diagnostics written to $OutputDir"
}
Write-Host 'Secrets are redacted on a best-effort basis. Review the files before sharing them.'
exit 0
