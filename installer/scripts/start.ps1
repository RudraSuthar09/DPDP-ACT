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

.PARAMETER SubmissionStagingEncKey
  The second central data-at-rest key, SUBMISSION_STAGING_ENC_KEY. Same rule
  as MfaSecretEncKey: the exact value the central backend already uses, never
  generated here. Also used to ADD the key to an existing config\.env that
  predates it (an installation created before this key existed cannot start
  without it).

  Prefer setting $env:DPDP_SUBMISSION_STAGING_ENC_KEY (and the other DPDP_*
  variables) in the elevated session instead of passing any of these as
  parameters: parameters are visible in this script's own command line.

.PARAMETER GatewayEnrollmentCode
  The Enterprise Gateway's one-time enrollment code (from DPDP's Data
  Sources page -- "Connect Enterprise Gateway"). Only needed the FIRST time
  the Gateway container enrolls; a Gateway that already has a persisted
  device credential (in the dpdp_gateway_state / gateway_state Docker
  volume) ignores this entirely. NEVER written to config\.env or any file --
  passed through as a transient process environment variable for this one
  `docker compose up` call only, exactly like the database URLs above are
  NOT (those persist in config\.env deliberately; this deliberately does not).
#>
param(
  [switch]$NoBrowser,
  [string]$AppDatabaseUrl,
  [string]$DatabaseUrl,
  [string]$MfaSecretEncKey,
  [string]$SubmissionStagingEncKey,
  [string]$GatewayEnrollmentCode
)

. "$PSScriptRoot\common.ps1"
$root = Get-InstallRoot
Assert-DockerAvailable
$composeArgs = Get-ComposeArgs $root

# Secrets reach generate-env.ps1 through ENVIRONMENT VARIABLES of the child
# process, never its command line: a command line is visible to every user
# on the machine in the process list (and to process-creation auditing),
# while a process's environment is not. Each is removed again right after.
# The DPDP_* variables may also simply be set by the operator beforehand
# (the recommended way: see installer\README.md, "Provisioning the shared keys").
$secretHandOff = @{
  DPDP_APP_DATABASE_URL           = $AppDatabaseUrl
  DPDP_DATABASE_URL               = $DatabaseUrl
  DPDP_MFA_SECRET_ENC_KEY         = $MfaSecretEncKey
  DPDP_SUBMISSION_STAGING_ENC_KEY = $SubmissionStagingEncKey
}
$setHere = @()
foreach ($name in $secretHandOff.Keys) {
  if ($secretHandOff[$name]) {
    Set-Item -Path "Env:\$name" -Value $secretHandOff[$name]
    $setHere += $name
  }
}
try {
  & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\generate-env.ps1" -ConfigDir (Join-Path $root 'config')
  $generateExit = $LASTEXITCODE
} finally {
  foreach ($name in $setHere) { Remove-Item -Path "Env:\$name" -ErrorAction SilentlyContinue }
}
if ($generateExit -ne 0) { Write-Error "Could not generate config\.env (exit $generateExit)"; exit 1 }

Write-Output 'Starting DPDP (backend, worker, frontend, agent) -- connecting to the central database...'

# Transient ONLY for this invocation -- never written to config\.env, never
# persisted. If this Gateway already has a persisted device credential (in
# its Docker volume), agent/src/enrollment.ts ignores this value entirely
# even when set, so leaving it set on a later re-run is harmless -- but we
# still clear it from THIS process's environment right after the compose
# call, so it cannot leak into some later, unrelated `docker compose`
# invocation run from the same shell session.
if ($GatewayEnrollmentCode) {
  $env:GATEWAY_ENROLLMENT_CODE = $GatewayEnrollmentCode
}
try {
  & docker @composeArgs up -d backend worker frontend agent
  if ($LASTEXITCODE -ne 0) { Write-Error "Could not start DPDP services (exit $LASTEXITCODE)"; exit 1 }
} finally {
  if ($GatewayEnrollmentCode) {
    Remove-Item Env:\GATEWAY_ENROLLMENT_CODE -ErrorAction SilentlyContinue
  }
}

Write-Output 'Waiting for services to become healthy...'
$healthResult = & powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\health-check.ps1"
Write-Output $healthResult

if (-not $NoBrowser) {
  Start-Process 'http://localhost:3000'
}
