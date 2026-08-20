# Environment variables

Every variable actually read by the platform, in one place (locked
architecture §14/§22). Copy `.env.example` to `.env` and fill in — never
commit a real `.env` (see `.gitignore`).

No new environment variables were introduced by the installation/licensing/
capability foundation phase — that model is entirely database-driven (the
`installations`/`licenses` tables, read through `GET /capabilities`). This
list documents what already existed, including the Gateway/agent variables
that were previously code-only (read in `agent/src/config.ts` and
`frontend/src/app/(app)/data-sources/[id]/gateway/page.tsx`) but never
written down.

## Postgres (central control-plane database)

| Variable | Used by | Notes |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_HOST` / `POSTGRES_PORT` | `docker-compose.yml`'s optional `postgres` service, `scripts/local-db.mjs` | Individual pieces, mainly for the optional local-db Compose profile. |
| `DATABASE_URL` | `node-pg-migrate` (`pnpm migrate*`) | Owner/superuser connection. Migrations (DDL) only — bypasses RLS. Never used by the running app. |
| `APP_DATABASE_URL` | Backend API + worker (`TenantDatabaseService`) | Least-privilege `dpdp_app` role. RLS is always enforced against this connection (Seam S1). |

Today both point at a hosted Supabase Postgres instance in dev (see the real
`.env`). That is the existing, working setup and this phase does not change
it — Docker Compose's `postgres` service is an **opt-in** alternative (`docker
compose --profile local-db up postgres`), not a default. Using it means
pointing `DATABASE_URL`/`APP_DATABASE_URL`/`POSTGRES_HOST` at the `postgres`
service instead (e.g. `POSTGRES_HOST=postgres` when running `pnpm migrate:up`
from inside the Compose network, or `localhost` when running it from the host
against the published port) — this repo does not auto-switch that for you.

## API / Web

| Variable | Used by | Notes |
| --- | --- | --- |
| `API_PORT` | `backend/src/main.ts` | Default `3001`. |
| `WEB_PORT` | `frontend/package.json` dev/start scripts are actually hardcoded to `3000` today — `WEB_PORT` is otherwise unused. | Documented for completeness; not currently wired to the Next.js scripts. |
| `NEXT_PUBLIC_API_URL` | `frontend/src/lib/api.ts` | Baked into the browser bundle at **build** time (Next.js `NEXT_PUBLIC_*` convention) — must be the browser-reachable address, e.g. `http://localhost:3001`, never an in-Docker-network service name. |

## Gateway / Agent (previously code-only, now documented)

| Variable | Used by | Notes |
| --- | --- | --- |
| `GATEWAY_BIND_HOST` | `agent/src/config.ts` | Default `127.0.0.1` (loopback). Never auto-`0.0.0.0`. Set explicitly (e.g. in Docker) for LAN/container reachability — the agent then logs a loud non-loopback warning. |
| `GATEWAY_BIND_PORT` | `agent/src/config.ts` | Default `7071`. |
| `GATEWAY_ALLOWED_ORIGINS` | `agent/src/config.ts` | Comma-separated **exact** origins allowed to call the agent from a browser. No wildcards. |
| `GATEWAY_CONTROL_PLANE_URL` | `agent/src/index.ts` (`DataPlane`) | Where the agent reaches the central control plane, when a data source is configured. |
| `GATEWAY_TENANT_ID` / `GATEWAY_DEVICE_ID` / `GATEWAY_DEVICE_TOKEN` | `agent/src/index.ts` | The enrolled device's identity, set after enrollment. |
| `GATEWAY_SOURCES` | `agent/src/connectors/registry.ts` | JSON array of configured connector sources for the data plane. |
| `NEXT_PUBLIC_GATEWAY_AGENT_URL` | `frontend/src/app/(app)/data-sources/[id]/gateway/page.tsx` | Default agent address the browser tries first; the actual per-tenant Gateway endpoint (`gateway_devices.endpoint`) is what's normally used instead. |

## Secrets (rotate before any real deployment)

None of these are new; none are read by Docker build steps or written into
any image layer — every service consumes them at **runtime**, via
`env_file: .env` in `docker-compose.yml`, never baked into a Dockerfile. They
are not all the same *kind* of secret, though — see the split below.

### Installation-local secrets — safe to regenerate per environment

`JWT_SECRET`, `REQUEST_OTP_SECRET`, `SUBJECT_REF_HMAC_PEPPER` (the last is
currently unused dead config — see `backend/src/modules/consent/subject-ref.ts`'s
comment; the real per-tenant subject-ref secret lives encrypted in
`tenant_consent_secrets`, protected by `MFA_SECRET_ENC_KEY` below, not by this
pepper). These sign or hash short-lived, ephemeral material — session tokens
and one-time codes — never a value that stays decrypted-or-bust in the
database across processes. A fresh value per install/environment is correct:
at most it invalidates in-flight tokens/codes at the moment it changes,
never historical data. See `.env.example`'s own comments for exactly what
each protects.

### `MFA_SECRET_ENC_KEY` — a data-at-rest key SCOPED TO THE CENTRAL DATABASE, not to any one installation

This is categorically different from the three above and must not be
generated fresh per installation/environment. It is the key
`AesGcmSecretCipher` (`backend/src/modules/identity/crypto/secret-cipher.ts`)
uses to encrypt/decrypt, at rest, in the **central** PostgreSQL:

- `users.mfa_secret_ciphertext` (TOTP/MFA secrets)
- `tenant_consent_secrets.secret_ciphertext` (per-tenant subject-ref
  pseudonymization secrets, I2)
- webhook signing secrets (`notify` module)

Because the ciphertext lives in the shared central database rather than with
any one process, **every runtime that connects to that central database and
needs to decrypt any of the above must hold the exact same key** — a
developer's local `.env`, CI, and every installed customer runtime pointed
at the same central database all share one value (see the single fixed key
in `.env.example`). A runtime that generates its own random value can
encrypt new data fine, but can never decrypt anything a different key
already produced there — this is what an AES-GCM auth-tag mismatch
(`Unsupported state or unable to authenticate data`) means when it shows up
in backend logs: wrong key, not corruption. Rotating this key for real means
re-encrypting every affected column, not just picking a new value.

`installer/scripts/generate-env.ps1` reflects this: it requires
`-MfaSecretEncKey` as an explicit, caller-supplied value (same as the two
database connection strings) and never generates one itself.

## Notifications (unchanged, listed for completeness)

`NOTIFY_TRANSPORT`, `NOTIFY_HTTP_ENDPOINT`, `POSTMARK_API_KEY`,
`POSTMARK_FROM_EMAIL`, `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `NOTIFY_DEV_ECHO_OTP`
— see `.env.example`.

## A note on Redis

`.env.example` documents `REDIS_HOST`/`REDIS_PORT`/`REDIS_URL`, and `turbo.json`
lists `REDIS_URL` as a global env var, but the backend actually uses
**pg-boss** (Postgres-backed jobs) for the S3 `WorkflowRunner`, not Redis/
BullMQ — there is no `bullmq`/`ioredis` dependency anywhere in `backend/`.
This is a pre-existing documentation/code mismatch, not something introduced
or fixed by this phase; `docker-compose.yml` accordingly does not include a
Redis service.
