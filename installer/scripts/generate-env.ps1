<#
.SYNOPSIS
  Generates <InstallRoot>\config\.env for the installed DPDP runtime.

  IMPORTANT (architecture correction): this script does NOT create, generate,
  or point at any local Postgres database. There is exactly one DPDP database
  -- the existing central control-plane PostgreSQL -- and the installed
  runtime connects to it the way every developer's own local `pnpm dev:api`
  already does, via TWO roles against that SAME central database (confirmed
  by testing, not a design choice -- see .NOTES):
    - APP_DATABASE_URL: the least-privilege, RLS-enforced `dpdp_app` role.
      Everything the running application queries goes through this.
    - DATABASE_URL: the owner role. NOT used to run DPDP's own schema
      migrations (that stays provider-only, never something a customer
      installation does) -- it is required at every boot by the pre-existing
      pg-boss job-queue engine (backend/src/modules/workflow/pgboss.service.ts),
      which self-manages its OWN separate `pgboss` schema and needs DDL
      rights to do so. This is existing, unmodified backend behavior, not
      something introduced here.

  Neither value is fabricated -- both must be supplied by the caller.

  For this one-PC testing phase, per explicit instruction: no production
  secret-distribution mechanism is being built here. The caller (a human
  running the installer/start script for this test) supplies
  -AppDatabaseUrl/-DatabaseUrl, or pre-populates config\.env by hand before
  the first "Start DPDP" run -- either is "the existing configuration
  mechanism".

  A THIRD value is required for the same reason, and is equally not fabricated
  here: MFA_SECRET_ENC_KEY. Unlike JWT_SECRET/REQUEST_OTP_SECRET (genuinely
  installation-local -- see below), this key is a DATA-AT-REST key SCOPED TO
  THE CENTRAL DATABASE, not to any one installation. It is what
  AesGcmSecretCipher (backend/src/modules/identity/crypto/secret-cipher.ts)
  uses to decrypt users.mfa_secret_ciphertext, tenant_consent_secrets, and
  webhook secrets -- all of which already exist in the central database for
  any tenant that predates this installation. A freshly-random key here
  cannot decrypt data encrypted under a different key: every existing user's
  MFA breaks. The caller must supply the SAME value already in use for that
  central database (see docs/environment-variables.md).

.NOTES
  Never shipped inside the installer binary, never committed anywhere.
#>
param(
  [Parameter(Mandatory = $true)][string]$ConfigDir,
  [string]$AppDatabaseUrl,
  [string]$DatabaseUrl,
  [string]$MfaSecretEncKey,
  [string]$SubmissionStagingEncKey
)

# Each secret may come from its parameter OR from a DPDP_* environment
# variable. The environment is the recommended route (start.ps1 uses it):
# a parameter is visible in the process list, an environment variable is not.
if (-not $AppDatabaseUrl) { $AppDatabaseUrl = $env:DPDP_APP_DATABASE_URL }
if (-not $DatabaseUrl) { $DatabaseUrl = $env:DPDP_DATABASE_URL }
if (-not $MfaSecretEncKey) { $MfaSecretEncKey = $env:DPDP_MFA_SECRET_ENC_KEY }
if (-not $SubmissionStagingEncKey) { $SubmissionStagingEncKey = $env:DPDP_SUBMISSION_STAGING_ENC_KEY }

# The same check the backend makes at startup (env.validation.ts and both
# ciphers): the value must decode from base64 to exactly 32 bytes. Done here
# too so a bad key is reported at install time, with the variable named,
# instead of as a crash loop later. Accepts base64url as the backend does.
function Test-Aes256Key([string]$Value) {
  if (-not $Value) { return $false }
  $b64 = $Value.Trim().Replace('-', '+').Replace('_', '/')
  while ($b64.Length % 4 -ne 0) { $b64 += '=' }
  try { return ([Convert]::FromBase64String($b64).Length -eq 32) } catch { return $false }
}

# RNGCryptoServiceProvider, not RandomNumberGenerator::Fill() -- the latter is
# a static method only present on .NET 5+ (PowerShell 7). This must run under
# Windows PowerShell 5.1 (.NET Framework), which the installer invokes via
# plain "powershell.exe".
$ErrorActionPreference = 'Stop'
$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider

function New-RandomToken([int]$Bytes = 24) {
  # Hex, not base64 -- a fixed, deterministic 2*Bytes-character length with
  # no risk of the +/=/ characters base64 can produce (stripping those made
  # the string a random, occasionally-too-short length -- a real bug caught
  # by testing: Substring(0,32) threw whenever a token happened to contain
  # enough of them).
  $buf = New-Object byte[] $Bytes
  $rng.GetBytes($buf)
  return ([System.BitConverter]::ToString($buf) -replace '-', '').ToLowerInvariant()
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$envPath = Join-Path $ConfigDir '.env'

if (Test-Path $envPath) {
  # Never overwrite an existing install's secrets/config. One exception, and
  # only ADDITIVE: an installation created before SUBMISSION_STAGING_ENC_KEY
  # existed cannot start without it, so if the operator supplied the key it is
  # appended -- every existing line is left exactly as it is.
  $existing = Get-Content -Path $envPath -Raw
  if ($existing -notmatch '(?m)^\s*SUBMISSION_STAGING_ENC_KEY\s*=\s*\S') {
    if (-not $SubmissionStagingEncKey) {
      Write-Warning ("config\.env has no SUBMISSION_STAGING_ENC_KEY, so the backend will not start. Set " +
        "`$env:DPDP_SUBMISSION_STAGING_ENC_KEY to the central database's existing key (see installer\README.md, " +
        "'Provisioning the shared keys') and run Start DPDP again.")
      return
    }
    if (-not (Test-Aes256Key $SubmissionStagingEncKey)) {
      Write-Error "SUBMISSION_STAGING_ENC_KEY must decode from base64 to exactly 32 bytes. config\.env was not changed."
      exit 1
    }
    $addition = "`r`n# Added by the installer: the central database's existing data-at-rest key`r`n" +
      "# (consent-form staging). NOT generated here -- see installer\README.md.`r`n" +
      "SUBMISSION_STAGING_ENC_KEY=$SubmissionStagingEncKey`r`n"
    Add-Content -Path $envPath -Value $addition -Encoding ASCII -NoNewline
    Write-Output "Added SUBMISSION_STAGING_ENC_KEY to the existing config\.env (nothing else changed)."
    return
  }
  Write-Output "config\.env already exists -- leaving it untouched (not overwriting an existing install's secrets/config)."
  return
}

if (-not $AppDatabaseUrl -or -not $DatabaseUrl -or -not $MfaSecretEncKey -or -not $SubmissionStagingEncKey) {
  Write-Error @"
APP_DATABASE_URL, DATABASE_URL, MFA_SECRET_ENC_KEY and/or
SUBMISSION_STAGING_ENC_KEY were not provided, and config\.env does not
exist yet.

This installed runtime connects to the EXISTING CENTRAL DPDP PostgreSQL --
it does not create or use a local database. Three values against/for that
SAME central database are required (confirmed by testing):

  - APP_DATABASE_URL: the least-privilege dpdp_app role, everything the app
    queries.
  - DATABASE_URL: the owner role, required at boot by the pre-existing
    pg-boss job engine to self-manage its own separate schema -- NOT used to
    run DPDP's own migrations, which stays provider-only.
  - MFA_SECRET_ENC_KEY: NOT a fresh secret to generate. This is a data-at-rest
    encryption key SCOPED TO THE CENTRAL DATABASE -- it must be the exact
    same value already used to encrypt users.mfa_secret_ciphertext,
    tenant_consent_secrets, and webhook secrets already stored there. A
    different value here cannot decrypt existing data and will break MFA for
    every pre-existing user. See docs/environment-variables.md.

  - SUBMISSION_STAGING_ENC_KEY: the same kind of key, for consent-form values
    staged in the central database. Also NOT generated here.

Set them in the elevated session as environment variables (NOT as command
line parameters, which other users on this computer can see), then start:

  `$env:DPDP_APP_DATABASE_URL           = '<dpdp_app connection string>'
  `$env:DPDP_DATABASE_URL               = '<pg-boss/owner connection string>'
  `$env:DPDP_MFA_SECRET_ENC_KEY         = '<central MFA_SECRET_ENC_KEY>'
  `$env:DPDP_SUBMISSION_STAGING_ENC_KEY = '<central SUBMISSION_STAGING_ENC_KEY>'
  .\scripts\start.ps1

See installer\README.md, 'Provisioning the shared keys'.
"@
  exit 1
}

foreach ($k in @(@('MFA_SECRET_ENC_KEY', $MfaSecretEncKey), @('SUBMISSION_STAGING_ENC_KEY', $SubmissionStagingEncKey))) {
  if (-not (Test-Aes256Key $k[1])) {
    Write-Error "$($k[0]) must decode from base64 to exactly 32 bytes. config\.env was not created."
    exit 1
  }
}

$jwtSecret = New-RandomToken 32
$hmacPepper = New-RandomToken 24
$otpSecret = New-RandomToken 24

$envContent = @"
# Generated by the DPDP installer at install time. Never committed, never
# shipped inside the installer binary. Do not edit by hand unless you know
# what you're changing -- see docs/environment-variables.md in the source repo.
#
# APP_DATABASE_URL and DATABASE_URL both point at the EXISTING CENTRAL DPDP
# PostgreSQL -- the same database every DPDP tenant's platform data lives
# in, tenant-isolated via the existing RLS architecture. This installed
# runtime does not run its own database. DATABASE_URL here is NOT used to
# run DPDP's own schema migrations (provider-only, never something a
# customer installation does) -- it is required at boot by the pre-existing
# pg-boss job engine, which self-manages its own separate `pgboss` schema.
NODE_ENV=production

APP_DATABASE_URL=$AppDatabaseUrl
DATABASE_URL=$DatabaseUrl

API_PORT=3001
WEB_PORT=3000
NEXT_PUBLIC_API_URL=http://localhost:3001

GATEWAY_BIND_PORT=7071
GATEWAY_ALLOWED_ORIGINS=http://localhost:3000

SUBJECT_REF_HMAC_PEPPER=$hmacPepper
JWT_SECRET=$jwtSecret
# NOT freshly generated (unlike JWT_SECRET above/REQUEST_OTP_SECRET below).
# This is the central database's existing data-at-rest key, supplied by the
# caller -- see the -MfaSecretEncKey requirement above and
# docs/environment-variables.md.
MFA_SECRET_ENC_KEY=$MfaSecretEncKey
# Same kind of key: the central database's existing consent-form staging key.
# Supplied by the operator, never generated -- see installer\README.md.
SUBMISSION_STAGING_ENC_KEY=$SubmissionStagingEncKey
MFA_ISSUER=DPDP Platform
ACCESS_TOKEN_TTL_SECONDS=15552000
MFA_CHALLENGE_TTL_SECONDS=300

NOTIFY_TRANSPORT=console
NOTIFY_DEV_ECHO_OTP=false
REQUEST_OTP_SECRET=$otpSecret
"@

# Plain ASCII, no BOM -- content is pure ASCII (see the non-ASCII sweep in
# this directory) and Windows PowerShell 5.1's Set-Content has no "UTF8
# without BOM" option (its "UTF8" always writes one, which a naive .env
# parser could choke on for the very first key).
Set-Content -Path $envPath -Value $envContent -Encoding ASCII
Write-Output "Generated config\.env (central database connection + local-instance secrets)."
