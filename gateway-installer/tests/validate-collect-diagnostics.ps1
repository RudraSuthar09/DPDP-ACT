<#
  Validates service\collect-diagnostics.ps1 WITHOUT elevation and WITHOUT an
  installed service: builds a fake install directory and a fake
  %ProgramData%\DPDP Gateway tree in a temp folder, plants secrets in every
  place a real install keeps them, runs the collector, and asserts that the
  output (folder and zip) contains NONE of the planted secrets or internal
  host names while still containing the expected evidence.

  This is a SIMULATED layout. It does not prove ACL output, service state or
  event-log content on an installed Gateway; the acceptance checklist in
  gateway-installer\README.md covers that on a real machine.

    powershell -NoProfile -ExecutionPolicy Bypass -File gateway-installer\tests\validate-collect-diagnostics.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Collector = Join-Path $PSScriptRoot '..\service\collect-diagnostics.ps1'
$Fixtures = Join-Path $PSScriptRoot '..\..\agent\src\__fixtures__\tls'
$Root = Join-Path ([IO.Path]::GetTempPath()) ('dpdp-diag-test-' + [Guid]::NewGuid().ToString('N'))
$Install = Join-Path $Root 'install'
$Data = Join-Path $Root 'data'
$Out = Join-Path $Root 'out'

$passed = 0; $failed = 0
function Check([string]$Name, [scriptblock]$Test) {
  try {
    if (& $Test) { $script:passed++; Write-Host "  ok    $Name" } else { $script:failed++; Write-Host "  FAIL  $Name" }
  } catch { $script:failed++; Write-Host "  FAIL  $Name -- $($_.Exception.Message)" }
}

# Secrets and internal details that must never appear in the output.
$jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZW5hbnRfaWQiOiJ0In0.c2lnbmF0dXJlLXNlY3JldA'
$secrets = @(
  'DB-Pa55word-planted',
  'Pr0xy-Pa55-planted',
  'enrol-code-planted-123456',
  $jwt,
  'c3ZjOlByMHh5LVBhNTUtcGxhbnRlZA==',
  'corp-proxy.internal',
  'secret-intranet.corp',
  'db-host.internal'
)

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $Install 'agent\dist'), (Join-Path $Data 'config'), (Join-Path $Data 'state\logs') | Out-Null

  # Fake install with a manifest; one file is then tampered with.
  Set-Content -LiteralPath (Join-Path $Install 'agent\package.json') -Value '{"name":"@dpdp/agent","version":"0.1.0"}' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $Install 'agent\dist\index.js') -Value 'console.log(1)' -Encoding ASCII
  $lines = foreach ($rel in @('agent\package.json', 'agent\dist\index.js')) {
    "$((Get-FileHash -LiteralPath (Join-Path $Install $rel) -Algorithm SHA256).Hash.ToLowerInvariant())  $rel"
  }
  Set-Content -LiteralPath (Join-Path $Install 'MANIFEST.sha256') -Value $lines -Encoding ASCII
  Add-Content -LiteralPath (Join-Path $Install 'agent\dist\index.js') -Value '// tampered'
  Set-Content -LiteralPath (Join-Path $Install 'install-service.log') -Value "Transcript... password=DB-Pa55word-planted done" -Encoding ASCII

  # config.json with proxy and CA (port must be one nothing listens on).
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0); $l.Start(); $freePort = $l.LocalEndpoint.Port; $l.Stop()
  Copy-Item (Join-Path $Fixtures 'test-ca.pem') (Join-Path $Data 'config\corp-ca.pem')
  @{
    controlPlaneUrl = 'https://workspace.dpdp.example'
    bindPort = $freePort
    proxy = @{ url = 'http://corp-proxy.internal:3128'; noProxy = @('secret-intranet.corp', '10.0.0.0/8') }
    tls = @{ extraCaCertsFile = 'corp-ca.pem'; useWindowsCertificateStore = $true }
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Data 'config\config.json') -Encoding ASCII

  # State files exactly where a real install keeps secrets.
  Set-Content -LiteralPath (Join-Path $Data 'state\sources.json') -Encoding ASCII -Value '[{"sourceId":"s1","kind":"postgresql","connection":{"host":"db-host.internal","port":5432,"user":"u","password":"DB-Pa55word-planted","database":"d"}}]'
  Set-Content -LiteralPath (Join-Path $Data 'state\proxy-credentials.json') -Encoding ASCII -Value '{"username":"svc","password":"Pr0xy-Pa55-planted"}'
  Set-Content -LiteralPath (Join-Path $Data 'state\device-credential.json') -Encoding ASCII -Value "{`"deviceToken`":`"$jwt`"}"
  Set-Content -LiteralPath (Join-Path $Data 'state\pending-enrollment.json') -Encoding ASCII -Value '{"enrollmentCode":"enrol-code-planted-123456"}'
  Set-Content -LiteralPath (Join-Path $Data 'state\logs\DPDPGatewayAgent.out.log') -Encoding ASCII -Value @(
    "2026-10-15T10:00:00Z INFO token $jwt",
    '2026-10-15T10:00:01Z INFO password=DB-Pa55word-planted',
    '2026-10-15T10:00:02Z INFO Proxy-Authorization: Basic c3ZjOlByMHh5LVBhNTUtcGxhbnRlZA==',
    '2026-10-15T10:00:03Z INFO HTTPS_PROXY=http://svc:Pr0xy-Pa55-planted@127.0.0.1:3128',
    '2026-10-15T10:00:04Z INFO enrollmentCode: enrol-code-planted-123456',
    '2026-10-15T10:00:05Z INFO outbound proxy: from config.json; verification always on'
  )

  $svcName = 'DPDPGatewayAgentTest' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Collector -InstallDir $Install -DataRoot $Data -ServiceName $svcName -OutputDir $Out | Out-Null
  $exit = $LASTEXITCODE

  Write-Host 'collect-diagnostics.ps1 (simulated layout, not elevated):'
  Check 'exits 0' { $exit -eq 0 }
  Check 'produces a folder and a zip' { (Test-Path (Join-Path $Out 'report.txt')) -and (Test-Path "$Out.zip") }

  $all = (Get-ChildItem -LiteralPath $Out -Recurse -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
  $zipDir = Join-Path $Root 'unzipped'
  Expand-Archive -LiteralPath "$Out.zip" -DestinationPath $zipDir
  $zipped = (Get-ChildItem -LiteralPath $zipDir -Recurse -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"

  foreach ($s in $secrets) {
    $shown = if ($s.Length -gt 12) { $s.Substring(0, 6) + '...' } else { $s }
    Check "never contains planted value '$shown' (folder and zip)" { (-not $all.Contains($s)) -and (-not $zipped.Contains($s)) }
  }

  $report = Get-Content -LiteralPath (Join-Path $Out 'report.txt') -Raw
  $summary = Get-Content -LiteralPath (Join-Path $Out 'summary.json') -Raw | ConvertFrom-Json
  Check 'reports the service as not installed' { -not $summary.serviceInstalled }
  Check 'detects the tampered installed file via MANIFEST.sha256' { $summary.manifestMismatches -eq 1 -and $report -match 'changed: agent\\dist\\index\.js' }
  Check 'reports the agent version' { $summary.agentVersion -eq '0.1.0' }
  Check 'shows proxy scheme and port but not the host' { $report -match 'url: http://<host redacted>:3128' -and $report -match 'noProxy entries: 2' }
  Check 'summarises the CA bundle (thumbprint, CA flag, validity)' { $report -match 'thumbprint [0-9A-F]{40}; CA: True' }
  Check 'shows the TLS options without the CA path' { $report -match 'extraCaCertsFile: <set>; useWindowsCertificateStore: True' }
  Check 'lists state files by name with formats, not contents' { $report -match 'sources\.json\s+\d+ bytes.*legacy plaintext format \(v1\), 1 source' -and $report -match 'proxy-credentials\.json.*PLAIN form' -and $report -match 'device-credential\.json' }
  Check 'keeps non-secret log lines' { $all -match 'outbound proxy: from config\.json; verification always on' }
  Check 'warns when the status endpoint is unreachable' { $report -match 'local status endpoint did not answer' }
} finally {
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$Out.zip" -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
