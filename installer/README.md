# DPDP Platform — Windows installer

One installer, `DPDP-Platform-Setup.exe`. SaaS vs Enterprise is decided by
the license key entered on first run — there is no separate SaaS/Enterprise
installer and never should be (`InstallationService`/`LicensingService`/
`CapabilityService`, unchanged from the rest of the platform).

## Prerequisite (v1 — documented, not bundled)

**Docker Desktop for Windows must already be installed and running.**
Bundling/silently-installing Docker Desktop itself is out of scope for this
version — the installer checks for it and fails with a clear message +
download link if it's missing, rather than pretending to work without it.
Get it from <https://www.docker.com/products/docker-desktop/>.

## What the installer actually does

It does **not** build anything from source. It ships three pre-built Docker
image tarballs and `docker load`s them, so the customer never needs pnpm,
Node, git, or this repository. See `scripts/package-images.ps1` — that's the
step *we* run before cutting a release, not something the customer does.

**There is no local database.** This installer does not create, start, or
depend on any local Postgres. There is exactly one DPDP database — the
existing central control-plane PostgreSQL, shared across every tenant via
the existing RLS architecture — and the installed `backend`/`worker`
containers connect to it outbound via `APP_DATABASE_URL`, exactly the way
every developer's own local `pnpm dev:api` already does. Database
migrations are a provider-side operation against the central database,
never something a customer installation runs.

Install flow: check Docker → `docker load` the three images → (optionally,
via the standard "Launch DPDP Platform" finish-page checkbox) start the
desktop shell. **The desktop shell (`desktop/`, a thin Electron shell — see
below) is the primary way DPDP is opened**: double-clicking it starts the
existing runtime if it isn't already running (generates `config\.env` with
fresh local-instance secrets — JWT signing, MFA encryption, etc, never a
database credential, see below — brings up backend/worker/frontend/agent,
polls health) and then opens a native window loading the existing frontend.
No browser is involved in normal use.

## Desktop shell

`desktop/` is an Electron app that is deliberately *only* a presentation/
startup shell — `desktop/src/main.js` contains no authentication, licensing,
tenancy, or Gateway logic. It: (1) checks the existing health endpoints,
(2) if not healthy, runs the existing `scripts\start.ps1` exactly the way a
human would, (3) waits for health, (4) opens a `BrowserWindow` loading the
existing frontend at `http://localhost:3000` — the exact same frontend, same
origin, same security posture as opening it in a browser tab, just inside a
titled, iconned, native window instead. Closing the window quits the shell
but never touches the Docker runtime or the central database (containers
keep running in the background via `restart: unless-stopped`; reopening the
shortcut reconnects instantly since the health check short-circuits the
start step).

Shipped as the raw Electron runtime binary (`desktop/node_modules/electron/dist/`)
plus the app's own tiny, dependency-free source — not via `electron-packager`,
which fights pnpm's strict `node_modules` isolation on transitive deps
(`@electron/get`, `debug`, ...). `electron.exe "<app-dir>" --install-root="<path>"`
is the same thing packager would produce, without that tooling.

**Central database connection, for this testing phase:** there is no
automated secret-distribution step yet (explicitly out of scope). This is a
temporary/manual provisioning mechanism for the current testing phase only —
a real release needs an actual secret-distribution story. Three values
against/for the SAME central database are required (confirmed by testing,
not a design choice):

- `APP_DATABASE_URL` — points at the central DPDP PostgreSQL, least-privilege
  `dpdp_app` role. Everything the app queries goes through this.
- `DATABASE_URL` — points at the SAME central PostgreSQL, owner role. NOT
  used to run DPDP's own migrations, which stays provider-only; required at
  boot by the pre-existing pg-boss job engine to self-manage its own
  separate schema.
- `MFA_SECRET_ENC_KEY` — **also scoped to that same central database**, but
  unlike the two connection strings above it is not a "where to connect"
  value, it is a **data-at-rest encryption key**. It decrypts
  `users.mfa_secret_ciphertext`, `tenant_consent_secrets`, and webhook
  secrets that already exist in that central database for any tenant that
  predates this installation (see
  `backend/src/modules/identity/crypto/secret-cipher.ts`). **A fresh
  installation connecting to an existing central database must receive the
  exact existing `MFA_SECRET_ENC_KEY` already in use for that database — the
  installer must never generate a new one.** Generating a new value here
  silently breaks MFA (and consent subject-ref pseudonymization, and
  webhook signing) for every pre-existing user, because AES-GCM ciphertext
  encrypted under one key can never be decrypted under another. Only a truly
  first-ever central database (nothing encrypted yet) may use a freshly
  generated value.

Supply all three the first time you start DPDP:
```powershell
scripts\start.ps1 -AppDatabaseUrl "postgresql://dpdp_app:<password>@<central-host>:5432/<db>" `
                   -DatabaseUrl "postgresql://<owner-role>:<password>@<central-host>:5432/<db>" `
                   -MfaSecretEncKey "<the central database's existing MFA_SECRET_ENC_KEY>"
```
or pre-populate `config\.env` by hand (see `docs/environment-variables.md`
in the source repo) before the first run. After that, `config\.env` is left
untouched by subsequent runs.

## Building a release

```powershell
# 1. Build + export the images (from the repo root or anywhere; resolves its own paths)
installer\scripts\package-images.ps1

# 2. Compile the installer (requires Inno Setup 6 — winget install JRSoftware.InnoSetup)
iscc installer\DPDP-Platform-Setup.iss
```

Output: `installer\dist\DPDP-Platform-Setup.exe`.

## Local directory layout (once installed)

```
%LOCALAPPDATA%\DPDP Platform\  (per-user install — no admin/UAC required, see the .iss for why)
  runtime\      docker-compose.runtime.yml (no build: sections — pre-built images only)
  scripts\      start / stop / restart / health-check / uninstall-cleanup / generate-env / common
  dist\images\  the bundled .tar files (kept, so a future re-run of start.ps1 works offline too)
  desktop\
    electron\   the raw Electron runtime binary
    app\        desktop/package.json + src/ (main.js, splash.html, splash-preload.js)
  config\.env   generated at first run — never committed, never shipped
  logs\         reserved for future use
```

## Service management

- Desktop shortcut / Start Menu → **DPDP Platform** — the primary entry point; starts the runtime if needed and opens the app window.
- Start Menu → **Stop DPDP** / **Restart DPDP** / **Open DPDP in Browser (troubleshooting)** / **Uninstall DPDP**.
- Under the hood, start/stop/restart are exactly `docker compose -p dpdp -f runtime\docker-compose.runtime.yml <up -d|stop|restart|down>` — nothing the customer needs to type themselves.

## What v1 deliberately does not do

- No Windows Service / boot-time auto-start (containers use `restart: unless-stopped`, so they come back if Docker Desktop restarts, but nothing launches before a user logs in and Docker Desktop itself starts).
- No code signing — Windows SmartScreen will likely warn on the unsigned `.exe`. A real release needs a purchased Authenticode certificate.
- No auto-update/rollback (the directory layout above is deliberately shaped so a versioned-install scheme can be added later without a redesign).
- macOS/Linux installers.
