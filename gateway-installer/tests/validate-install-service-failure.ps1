<#
  Validates install-service.ps1's FAILURE reporting without admin and without
  registering anything:
    - a copy of the script with ONLY "#Requires -RunAsAdministrator" removed
      and the service name changed to a test name (so a real
      DPDPGatewayAgent service is never touched);
    - run against a temporary install directory.

  Case 1 reproduces the real Phase 6 failure: the pinned WinSW binary with the
  previously committed (invalid) DPDPGatewayAgent.xml. WinSW rejects the
  configuration BEFORE it registers anything. The script must exit non-zero
  and leave WinSW's actual message in install-service.error.txt, which the
  installer shows to the customer (setup.iss).
  Case 2: a missing installed file is reported the same way.

    powershell -NoProfile -ExecutionPolicy Bypass -File gateway-installer\tests\validate-install-service-failure.ps1
#>
param([string]$StagingDir = (Join-Path $PSScriptRoot '..\build\staging'))
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Source = Join-Path $PSScriptRoot '..\service\install-service.ps1'
$TestServiceName = 'DPDPGatewayAgentFailureTest'
$passed = 0; $failed = 0
function Check([string]$Name, [scriptblock]$Test) {
  try {
    if (& $Test) { $script:passed++; Write-Host "  ok    $Name" } else { $script:failed++; Write-Host "  FAIL  $Name" }
  } catch { $script:failed++; Write-Host "  FAIL  $Name -- $($_.Exception.Message)" }
}

$winsw = Join-Path $StagingDir 'DPDPGatewayAgent.exe'
if (-not (Test-Path -LiteralPath $winsw)) { throw "Build first: $winsw not found." }
if (Get-Service -Name $TestServiceName -ErrorAction SilentlyContinue) { throw "A service named $TestServiceName exists; refusing to run." }

$root = Join-Path ([IO.Path]::GetTempPath()) ('dpdp-installfail-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $script = Join-Path $root 'install-service-test.ps1'
  $text = [IO.File]::ReadAllText((Resolve-Path $Source).Path)
  $text = $text.Replace('#Requires -RunAsAdministrator', '# (#Requires removed for this non-elevated test)')
  $text = $text.Replace("`$ServiceName = 'DPDPGatewayAgent'", "`$ServiceName = '$TestServiceName'")
  if (-not $text.Contains($TestServiceName)) { throw 'Could not retarget the service name.' }
  [IO.File]::WriteAllText($script, $text, (New-Object Text.UTF8Encoding $true))

  function New-InstallDir([string]$Name, [string]$XmlText, [switch]$OmitNode) {
    $d = Join-Path $root $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $d 'runtime'), (Join-Path $d 'agent\dist') | Out-Null
    Copy-Item -LiteralPath $winsw -Destination (Join-Path $d 'DPDPGatewayAgent.exe')
    [IO.File]::WriteAllText((Join-Path $d 'DPDPGatewayAgent.xml'), $XmlText)
    if (-not $OmitNode) { Set-Content -LiteralPath (Join-Path $d 'runtime\node.exe') -Value 'x' }
    Set-Content -LiteralPath (Join-Path $d 'agent\dist\index.js') -Value 'x'
    Set-Content -LiteralPath (Join-Path $d 'elevated-helper.ps1') -Value 'x'
    return $d
  }
  function Invoke-Install([string]$Dir) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -InstallDir $Dir | Out-Null
    return $LASTEXITCODE
  }

  $brokenXml = & git -C $PSScriptRoot show 'f906914:gateway-installer/service/DPDPGatewayAgent.xml' 2>$null | Out-String
  if (-not $brokenXml -or -not $brokenXml.Contains(') -- do not confuse')) { throw 'Could not load the previously committed (invalid) XML from git.' }

  Write-Host 'install-service.ps1 failure reporting (non-elevated, test service name, nothing registered):'
  $d1 = New-InstallDir 'broken-xml' $brokenXml
  $code1 = Invoke-Install $d1
  $err1 = Join-Path $d1 'install-service.error.txt'
  Check 'invalid WinSW XML: the script exits non-zero' { $code1 -ne 0 }
  Check "invalid WinSW XML: install-service.error.txt carries WinSW's real error" {
    (Test-Path $err1) -and ((Get-Content -Raw $err1) -match "XML comment cannot contain '--'") -and ((Get-Content -Raw $err1) -match 'install')
  }
  Check 'invalid WinSW XML: the full transcript log is written too' { (Get-Content -Raw (Join-Path $d1 'install-service.log')) -match 'INSTALL FAILED' }
  Check 'nothing was registered' { -not (Get-Service -Name $TestServiceName -ErrorAction SilentlyContinue) }

  $d2 = New-InstallDir 'missing-file' $brokenXml -OmitNode
  $code2 = Invoke-Install $d2
  Check 'missing installed file: exits non-zero and names the file' {
    $code2 -ne 0 -and ((Get-Content -Raw (Join-Path $d2 'install-service.error.txt')) -match 'Missing installed file: .*node\.exe')
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
