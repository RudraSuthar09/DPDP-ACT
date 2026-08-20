<#
.SYNOPSIS
  Starts DPDP: connects to the existing CENTRAL database (no local Postgres,
  no customer-run migration), brings the stack up, waits for health, opens
  the browser. This is what DPDP-Platform-Setup.exe's [Run] section calls
  after install, and what the "Start DPDP" Start Menu shortcut calls
  thereafter.

.PARAMETER AppDatabaseUrl
  The central DPDP PostgreSQL connection string, least-privilege dpdp_app
  role (everything the app queries). Only used the FIRST time (to generate
  config\.env) -- see generate-env.ps1.

.PARAMETER DatabaseUrl
  The central DPDP PostgreSQL connection string, owner role. NOT used to run
  DPDP's own schema migrations (provider-only) -- required at boot by the
  pre-existing pg-boss job engine, which self-manages its own separate
  schema. Only used the FIRST time (to generate config\.env).

.PARAMETER MfaSecretEncKey
  The data-at-rest encryption key already in use for THIS central database
  (see backend/src/modules/identity/crypto/secret-cipher.ts). NOT a secret to
  invent here -- it must be the exact value already protecting
  users.mfa_secret_ciphertext, tenant_consent_secrets, and webhook secrets
  already stored in that database, or existing users' MFA breaks. Only used
  the FIRST time (to generate config\.env).

  For this testing phase there is no automated secret-distribution step;
  supply all three explicitly or pre-populate config\.env by hand before the
  first run.
#>
param(
  [switch]$NoBrowser,
  [string]$AppDatabaseUrl,
  [string]$DatabaseUrl,
  [string]$MfaSecretEncKey
)

. "$PSScriptRoot\common.ps1"
$root = Get-InstallRoot
Assert-DockerAvailable
$composeArgs = Get-ComposeArgs $root

$generateEnvArgs = @('-ConfigDir', (Join-Path $root 'config'))
if ($AppDatabaseUrl) { $generateEnvArgs += @('-AppDatabaseUrl', $AppDatabaseUrl) }
if ($DatabaseUrl) { $generateEnvArgs += @('-DatabaseUrl', $DatabaseUrl) }
if ($MfaSecretEncKey) { $generateEnvArgs += @('-MfaSecretEncKey', $MfaSecretEncKey) }
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\generate-env.ps1" @generateEnvArgs
if ($LASTEXITCODE -ne 0) { Write-Error "Could not generate config\.env (exit $LASTEXITCODE)"; exit 1 }

Write-Output 'Starting DPDP (backend, worker, frontend, agent) -- connecting to the central database...'
& docker @composeArgs up -d backend worker frontend agent
if ($LASTEXITCODE -ne 0) { Write-Error "Could not start DPDP services (exit $LASTEXITCODE)"; exit 1 }

Write-Output 'Waiting for services to become healthy...'
$healthResult = & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\health-check.ps1"
Write-Output $healthResult

if (-not $NoBrowser) {
  Start-Process 'http://localhost:3000'
}
