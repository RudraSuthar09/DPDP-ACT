<#
  .SYNOPSIS
    Non-elevated validation of elevated-helper.ps1. Repeatable; no admin
    rights; touches only a temp directory.

  .DESCRIPTION
    Copies the helper -- with ONLY its "#Requires -RunAsAdministrator" line
    removed -- into a fake install directory whose agent\ and runtime\ are
    junctions to the real built agent and the current node.exe, then drives
    it with real request files. Points the agent at temp config/state dirs
    via GATEWAY_CONFIG_PATH / GATEWAY_STATE_DIR.

    Covers: request-file name/size/link validation; scrub-and-delete of the
    request; UTF-8 stdin hand-off to cli-pair.js (non-ASCII password); the
    real cli-pair.js writes; the result file; secrets never in the result.

    NOT covered (needs an elevated session + installed service, see
    gateway-installer/README.md acceptance checklist): the elevation
    requirement itself and Restart-Service. Here the restart step fails
    with "service is not installed" -- which this script ASSERTS, proving the
    helper reports failures instead of hiding them.

    Prerequisite: pnpm --filter @dpdp/agent build
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Helper = Join-Path $RepoRoot 'gateway-installer\service\elevated-helper.ps1'
$AgentDir = Join-Path $RepoRoot 'agent'
$NodeDir = Split-Path -Parent (Get-Command node).Source
if (-not (Test-Path (Join-Path $AgentDir 'dist\cli-pair.js'))) { throw 'Build the agent first: pnpm --filter @dpdp/agent build' }

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("dpdp-helper-validate-" + [guid]::NewGuid().ToString('N'))
$Install = Join-Path $Work 'install'
$Caller = Join-Path $Work 'caller-temp'
$Cfg = Join-Path $Work 'config'
$State = Join-Path $Work 'state'
New-Item -ItemType Directory -Path $Install, $Caller, $Cfg, $State | Out-Null
cmd /c mklink /J "$Install\agent" "$AgentDir" | Out-Null
cmd /c mklink /J "$Install\runtime" "$NodeDir" | Out-Null
(Get-Content -Raw $Helper) -replace '(?m)^#Requires -RunAsAdministrator\r?\n', '' | Set-Content -Encoding UTF8 (Join-Path $Install 'elevated-helper.ps1')

$env:GATEWAY_CONFIG_PATH = Join-Path $Cfg 'config.json'
$env:GATEWAY_STATE_DIR = $State

$script:Passed = 0
$script:Failed = 0
function Assert([bool]$Condition, [string]$Name) {
  if ($Condition) { $script:Passed++; Write-Host "  ok    $Name" } else { $script:Failed++; Write-Host "  FAIL  $Name" -ForegroundColor Red }
}

function New-Request([string]$Json) {
  $id = ([guid]::NewGuid().ToString('N'))
  $path = Join-Path $Caller "dpdp-gw-request-$id.json"
  [System.IO.File]::WriteAllText($path, $Json, (New-Object System.Text.UTF8Encoding($false)))
  return @{ Request = $path; Result = (Join-Path $Caller "dpdp-gw-result-$id.json") }
}

function Invoke-Helper([string]$Action, [string]$RequestPath) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install 'elevated-helper.ps1') -Action $Action -RequestFile $RequestPath | Out-Null
  return $LASTEXITCODE
}

function Read-Result([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  $text = [System.IO.File]::ReadAllText($Path)
  Remove-Item $Path -Force
  return @{ Raw = $text; Json = ($text | ConvertFrom-Json) }
}

try {
  Write-Host "elevated-helper.ps1 non-elevated validation (work dir: $Work)"

  # 1. pair: code + URL travel via stdin; cli-pair writes; restart is reported as failed.
  $code = 'Abc123_-xyzXYZ0987654321abcdefghijklmnopqrs'
  $r = New-Request (ConvertTo-Json @{ enrollmentCode = $code; controlPlaneUrl = 'https://acme.example.com/x'; displayName = 'Finance PC' } -Compress)
  $exit = Invoke-Helper 'pair' $r.Request
  $res = Read-Result $r.Result
  Assert (-not (Test-Path $r.Request)) 'pair: the request file was deleted after reading'
  Assert ($exit -eq 1) 'pair: non-zero exit because the (absent) service cannot restart'
  Assert ($null -ne $res -and $res.Json.ok -eq $false -and $res.Json.error -match 'not installed') 'pair: result file explains the restart failure'
  Assert (-not ($res.Raw -match [regex]::Escape($code))) 'pair: the enrolment code never appears in the result'
  $pending = Get-Content -Raw (Join-Path $State 'pending-enrollment.json') | ConvertFrom-Json
  Assert ($pending.enrollmentCode -eq $code -and $pending.displayName -eq 'Finance PC') 'pair: cli-pair.js wrote pending-enrollment.json via stdin'
  $cfgJson = Get-Content -Raw $env:GATEWAY_CONFIG_PATH | ConvertFrom-Json
  Assert ($cfgJson.controlPlaneUrl -eq 'https://acme.example.com') 'pair: config.json holds only the normalized workspace origin'

  # 2. add-source: a non-ASCII password survives the UTF-8 stdin hand-off intact.
  # Built from code points: PowerShell 5.1 reads a BOM-less script as ANSI, so
  # a literal here would be mojibake on both sides of the comparison.
  $password = 'p' + [char]0x00E4 + 'ssw' + [char]0x00F6 + 'rd-' + [char]0x65E5 + [char]0x672C + '-"q''s'
  $source = @{ sourceId = 'crm'; kind = 'postgresql'; connection = @{ host = 'db.internal'; port = 5432; user = 'ro'; password = $password; database = 'crm' } }
  $r = New-Request (ConvertTo-Json $source -Compress -Depth 5)
  $exit = Invoke-Helper 'add-source' $r.Request
  $res = Read-Result $r.Result
  $queued = [System.IO.File]::ReadAllText((Join-Path $State 'pending-sources.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert ($queued.upserts[0].connection.password -eq $password) 'add-source: non-ASCII password reached cli-pair.js byte-for-byte'
  Assert (-not ($res.Raw.Contains('ssw'))) 'add-source: the password never appears in the result'
  Assert (-not (Test-Path (Join-Path $State 'sources.json'))) 'add-source: sources.json untouched (the service merges + encrypts it)'

  # 3. invalid input from cli-pair is surfaced, without echoing the input.
  $r = New-Request '{"enrollmentCode":"bad code; calc","controlPlaneUrl":"https://acme.example.com"}'
  $exit = Invoke-Helper 'pair' $r.Request
  $res = Read-Result $r.Result
  Assert ($exit -eq 1 -and $res.Json.error -match 'malformed' -and -not $res.Raw.Contains('calc')) 'pair: invalid code rejected with a generic message'

  # 4. production HTTP is refused by the agent itself.
  $r = New-Request (ConvertTo-Json @{ enrollmentCode = $code; controlPlaneUrl = 'http://acme.example.com' } -Compress)
  $exit = Invoke-Helper 'pair' $r.Request
  $res = Read-Result $r.Result
  Assert ($exit -eq 1 -and $res.Json.error -match 'https') 'pair: http:// production URL refused by cli-pair.js'

  # 5. request-file validation (name, links, size).
  $bad = Join-Path $Caller 'notes.json'
  Set-Content -Path $bad -Value '{}'
  $exit = Invoke-Helper 'restart' $bad
  Assert ($exit -eq 1 -and (Test-Path $bad)) 'rejects a request file with the wrong name, and does not delete it'

  $big = New-Request ('{"x":"' + ('a' * 70000) + '"}')
  $exit = Invoke-Helper 'restart' $big.Request
  Assert ($exit -eq 1) 'rejects an oversized request file'
  Remove-Item $big.Request -Force -ErrorAction SilentlyContinue

  $target = Join-Path $Work 'elsewhere'
  New-Item -ItemType Directory -Path $target | Out-Null
  $linkName = Join-Path $Caller ('dpdp-gw-request-' + ([guid]::NewGuid().ToString('N')) + '.json')
  cmd /c mklink /J "$linkName" "$target" | Out-Null
  $exit = Invoke-Helper 'restart' $linkName
  Assert ($exit -eq 1 -and (Test-Path $target)) 'rejects a request path that is a junction'

  # 6. unknown actions never reach the script body.
  $ErrorActionPreference = 'Continue'  # the child's expected parameter error goes to stderr
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Install 'elevated-helper.ps1') -Action 'shell' -RequestFile $bad 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Assert ($code -ne 0) 'rejects an action outside the ValidateSet'

  # 7. remove: writes the de-enrol request for the service.
  $r = New-Request '{}'
  Invoke-Helper 'remove' $r.Request | Out-Null
  Assert (Test-Path (Join-Path $State 'pending-deenroll.json')) 'remove: queued a de-enrol request for the service'
  Assert (-not (Test-Path (Join-Path $State 'pending-enrollment.json'))) 'remove: dropped the unredeemed pairing code'
} finally {
  Remove-Item Env:\GATEWAY_CONFIG_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:\GATEWAY_STATE_DIR -ErrorAction SilentlyContinue
  foreach ($j in @("$Install\agent", "$Install\runtime")) { if (Test-Path $j) { cmd /c rmdir "$j" | Out-Null } }
  Get-ChildItem $Caller -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object { cmd /c rmdir "$($_.FullName)" | Out-Null }
  Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`n$script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
