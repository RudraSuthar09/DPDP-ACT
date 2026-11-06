<#
  Validates that, in every full-stack Docker Compose variant, the agent's
  traffic to the internal backend can never be sent to an external proxy,
  while proxy settings that Docker or the customer supply are left intact.

  1. Renders the EFFECTIVE configuration with `docker compose config`
     (needs the Docker CLI only; the Docker engine does not have to run).
  2. Checks the agent service: GATEWAY_NO_PROXY includes "backend", and the
     Compose file itself sets none of HTTP_PROXY / HTTPS_PROXY / NO_PROXY /
     ALL_PROXY (in either case), so Docker's injected values or the
     customer's are never overridden.
  3. Feeds that effective environment, plus a SIMULATED Docker-injected proxy
     (what the Docker CLI adds when ~/.docker/config.json has "proxies"), to
     the BUILT agent's own resolver (agent/dist/network-config.js) and checks
     the routing decisions. Build the agent first (pnpm --filter @dpdp/agent build).

  Prints only the agent's proxy-related settings, never the rest of the
  rendered configuration (which can contain values from .env files).

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\validate-compose-agent-proxy.ps1
#>
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$ComposeFiles = @('docker-compose.yml', 'installer\runtime\docker-compose.runtime.yml')
$Resolver = Join-Path $Repo 'agent\dist\network-config.js'

$passed = 0; $failed = 0
function Check([string]$Name, [bool]$Ok) {
  if ($Ok) { $script:passed++; Write-Host "  ok    $Name" } else { $script:failed++; Write-Host "  FAIL  $Name" }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'The docker CLI is required (the engine need not be running).' }
if (-not (Test-Path $Resolver)) { throw "Build the agent first: $Resolver not found." }

foreach ($file in $ComposeFiles) {
  Write-Host "== $file"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $json = & docker compose -f (Join-Path $Repo $file) config --format json 2>$null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  Check 'docker compose config renders' ($code -eq 0)
  if ($code -ne 0) { continue }

  $agent = ($json | Out-String | ConvertFrom-Json).services.agent
  $envMap = @{}
  foreach ($p in $agent.environment.PSObject.Properties) { $envMap[$p.Name] = [string]$p.Value }

  $proxyKeys = @($envMap.Keys | Where-Object { $_ -match '^(?i)(https?|all|no)_proxy$' })
  Check 'Compose sets no HTTP(S)_PROXY / NO_PROXY / ALL_PROXY for the agent' ($proxyKeys.Count -eq 0)
  $noProxy = if ($envMap.ContainsKey('GATEWAY_NO_PROXY')) { $envMap['GATEWAY_NO_PROXY'] } else { '' }
  Check 'GATEWAY_NO_PROXY includes "backend"' ((($noProxy -split '[\s,]+') -contains 'backend'))
  Write-Host "        GATEWAY_NO_PROXY=$noProxy; GATEWAY_CONTROL_PLANE_URL=$($envMap['GATEWAY_CONTROL_PLANE_URL'])"

  # Effective env + simulated Docker-injected proxy -> the agent's own resolver.
  $probe = @{
    effective = $envMap
    injected = @{ HTTP_PROXY = 'http://corp-proxy.example:3128'; HTTPS_PROXY = 'http://corp-proxy.example:3128'; NO_PROXY = 'localhost,.corp.example' }
  } | ConvertTo-Json -Compress -Depth 4
  $js = @'
const { resolveProxySettings, selectProxy } = require(process.argv[1]);
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const route = (env, url) => (selectProxy(resolveProxySettings(undefined, env), url) ? 'proxy' : 'direct');
const withFix = { ...input.effective, ...input.injected };
const withoutFix = { ...withFix }; delete withoutFix.GATEWAY_NO_PROXY;
console.log(JSON.stringify({
  backend: route(withFix, input.effective.GATEWAY_CONTROL_PLANE_URL),
  backendWithoutFix: route(withoutFix, input.effective.GATEWAY_CONTROL_PLANE_URL),
  external: route(withFix, 'https://dpdp.example'),
  injectedExclusion: route(withFix, 'https://intranet.corp.example'),
  noProxyAtAll: route(input.effective, 'https://dpdp.example'),
}));
'@
  # Base64: Windows PowerShell 5.1 strips double quotes from native-command arguments.
  $probe64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($probe))
  $result = (& node -e $js $Resolver $probe64) | ConvertFrom-Json
  Check 'with a Docker-injected proxy, agent -> backend is DIRECT' ($result.backend -eq 'direct')
  Check '(control) without GATEWAY_NO_PROXY it would have gone to the proxy' ($result.backendWithoutFix -eq 'proxy')
  Check 'external destinations still follow the injected proxy' ($result.external -eq 'proxy')
  Check 'the injected NO_PROXY exclusions are preserved' ($result.injectedExclusion -eq 'direct')
  Check 'no proxy is forced when none is configured' ($result.noProxyAtAll -eq 'direct')
}

Write-Host ''
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
