<#
  Validates the WinSW service descriptor (DPDPGatewayAgent.xml). No admin.

  Until Phase 6 its comments contained "--", which the XML specification
  forbids; WinSW refused to load it and `DPDPGatewayAgent.exe install` failed
  with exit -1 ("An XML comment cannot contain '--'..."), so the service was
  never registered. Nothing had ever parsed the file.

  Checks:
    1. The source parses with a strict XML parser (System.Xml).
    2. No comment contains "--" or ends with "-".
    3. The service configuration (every element and attribute, comments
       ignored) is exactly what the service needs, and unchanged from the
       last commit unless -AllowConfigChange is given.
    4. The PACKAGED copy (staging, as built by build-agent-bundle.ps1 and
       installed by setup.iss) is byte-identical to the source and parses.
    5. The pinned WinSW binary itself loads the packaged copy
       (`DPDPGatewayAgent.exe status`, which needs no admin and installs nothing).

    powershell -NoProfile -ExecutionPolicy Bypass -File gateway-installer\tests\validate-service-xml.ps1
#>
param(
  [string]$StagingDir = (Join-Path $PSScriptRoot '..\build\staging'),
  [switch]$AllowConfigChange
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\service\DPDPGatewayAgent.xml')).Path
$passed = 0; $failed = 0
function Check([string]$Name, [scriptblock]$Test) {
  try {
    if (& $Test) { $script:passed++; Write-Host "  ok    $Name" } else { $script:failed++; Write-Host "  FAIL  $Name" }
  } catch { $script:failed++; Write-Host "  FAIL  $Name -- $($_.Exception.Message)" }
}

function Read-StrictXml([string]$Path) {
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $reader = [System.Xml.XmlReader]::Create($Path, $settings)
  try { $doc = New-Object System.Xml.XmlDocument; $doc.Load($reader); return $doc } finally { $reader.Close() }
}

# Canonical, comment-free view of the configuration: element paths, attributes, text.
function Get-ConfigShape([System.Xml.XmlNode]$Node, [string]$Prefix = '') {
  $out = @()
  foreach ($child in $Node.ChildNodes) {
    if ($child.NodeType -ne [System.Xml.XmlNodeType]::Element) { continue }
    # get_Name(): the PowerShell XML adapter maps .Name to a child <name> element.
    $p = "$Prefix/$($child.get_Name())"
    foreach ($a in $child.Attributes) { $out += "$p@$($a.get_Name())=$($a.get_Value())" }
    $text = ($child.ChildNodes | Where-Object { $_.NodeType -eq [System.Xml.XmlNodeType]::Text } | ForEach-Object { $_.Value.Trim() }) -join ''
    if ($text) { $out += "$p=$text" }
    $out += Get-ConfigShape $child $p
  }
  return $out
}

Write-Host 'DPDPGatewayAgent.xml (source):'
$doc = $null
Check 'parses with a strict XML parser' { $script:doc = Read-StrictXml $Source; $true }

$comments = @()
if ($doc) { $comments = @($doc.SelectNodes('//comment()') | ForEach-Object { $_.Value }) }
Check "no XML comment contains '--' or ends with '-' ($($comments.Count) comments)" {
  # Also scan the raw text, in case the parser above was bypassed.
  $raw = [IO.File]::ReadAllText($Source)
  $bodies = [regex]::Matches($raw, '<!--([\s\S]*?)-->') | ForEach-Object { $_.Groups[1].Value }
  @($bodies | Where-Object { $_.Contains('--') -or $_.EndsWith('-') }).Count -eq 0 -and $comments.Count -gt 0
}

$shape = @()
if ($doc) { $shape = @(Get-ConfigShape $doc) }
$expected = @(
  '/service/id=DPDPGatewayAgent',
  '/service/name=DPDP Gateway Agent',
  '/service/executable=%BASE%\runtime\node.exe',
  '/service/arguments="%BASE%\agent\dist\index.js"',
  '/service/workingdirectory=%BASE%',
  '/service/log@mode=roll-by-size',
  '/service/log/logpath=%ProgramData%\DPDP Gateway\state\logs',
  '/service/onfailure@action=restart',
  '/service/startmode=Automatic',
  '/service/stopparentprocessfirst=true'
)
Check 'contains the required service settings' { @($expected | Where-Object { $shape -notcontains $_ }).Count -eq 0 }
Check 'declares no service account and no environment variables (set by install-service.ps1 / config.json instead)' {
  @($shape | Where-Object { $_ -match '^/service/(serviceaccount|env)' }).Count -eq 0
}

if (-not $AllowConfigChange) {
  Check 'service configuration is unchanged from the last commit (only comments may differ)' {
    $prev = & git -C (Split-Path $Source) show "HEAD:gateway-installer/service/DPDPGatewayAgent.xml" 2>$null | Out-String
    if (-not $prev) { return $true }  # file not committed yet: nothing to compare against
    # The committed version may itself be invalid XML (that was the bug), so
    # strip comments textually before parsing it.
    $prevDoc = New-Object System.Xml.XmlDocument
    $prevDoc.LoadXml(([regex]::Replace($prev, '<!--[\s\S]*?-->', '')))
    (@(Get-ConfigShape $prevDoc) -join "`n") -eq ($shape -join "`n")
  }
}

Write-Host 'DPDPGatewayAgent.xml (packaged, staging):'
$staged = Join-Path $StagingDir 'DPDPGatewayAgent.xml'
$winsw = Join-Path $StagingDir 'DPDPGatewayAgent.exe'
if (-not (Test-Path -LiteralPath $staged)) {
  Write-Host "  skip  no staging at $StagingDir (run build-agent-bundle.ps1 first)"
} else {
  Check 'packaged copy is byte-identical to the source' { (Get-FileHash -LiteralPath $staged).Hash -eq (Get-FileHash -LiteralPath $Source).Hash }
  Check 'packaged copy parses with a strict XML parser' { [void](Read-StrictXml $staged); $true }
  if (Test-Path -LiteralPath $winsw) {
    Check 'the pinned WinSW loads the packaged copy (status, no admin, installs nothing)' {
      $probe = Join-Path ([IO.Path]::GetTempPath()) ('dpdp-winsw-' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $probe | Out-Null
      try {
        Copy-Item -LiteralPath $winsw -Destination (Join-Path $probe 'DPDPGatewayAgent.exe')
        Copy-Item -LiteralPath $staged -Destination (Join-Path $probe 'DPDPGatewayAgent.xml')
        $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $out = & (Join-Path $probe 'DPDPGatewayAgent.exe') status 2>&1 | Out-String
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($code -ne 0) { throw "WinSW exit $code`: $($out.Trim())" }
        $out.Trim() -match '^(NonExistent|Stopped|Started|Active|Inactive|Running)'
      } finally {
        Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
  } else {
    Write-Host '  skip  WinSW binary not staged'
  }
}

Write-Host ''
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
