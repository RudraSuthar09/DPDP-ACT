# Environment variables

Every variable the platform actually reads, grouped by the process that reads
it. This is the single reference; the two templates point here:

| File                      | For                  | Notes                                                                                 |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `.env.example`            | Local development    | Copy to `.env`. Safe defaults + published dev placeholders.                           |
| `.env.production.example` | Production reference | Empty secrets. Not copied to servers: secrets come from a secrets manager at runtime. |

Never commit a real `.env` (see `.gitignore`).

**Startup validation.** The backend API and worker check their environment
before connecting to anything (`backend/src/config/env.validation.ts`) and
list every problem at once, by name, never printing a value. With
`NODE_ENV=production` they also refuse the published dev placeholders, a
`JWT_SECRET` shorter than 32 characters, and malformed keys.

Legend: **R** required · **O** optional · 🔒 secret (secrets manager, never in
an image, a log or a build arg) · 🌐 public (baked into the browser bundle;
every visitor can read it).

---

## Backend API (`backend`, `node dist/main.js`)

| Variable                                   |                                 | Default                                | Notes                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | R                               | `production` in the image              | `production` switches on the strict checks above and redacts console notifications. `docker-compose.yml` sets `development` for local work.                                                                                                                                                                                        |
| `APP_DATABASE_URL`                         | R 🔒                            | —                                      | The least-privilege `dpdp_app` role. Every tenant query runs on it, so RLS is always enforced (Seam S1).                                                                                                                                                                                                                           |
| `DATABASE_URL`                             | R 🔒 (or `PGBOSS_DATABASE_URL`) | —                                      | The schema **owner**. Migrations always; and pg-boss at runtime **unless** `PGBOSS_DATABASE_URL` is set. _An earlier version of this page said "never used by the running app" — that was wrong._                                                                                                                                  |
| `PGBOSS_DATABASE_URL`                      | O 🔒 (prod: R)                  | falls back to `DATABASE_URL`           | pg-boss on its own role `dpdp_jobs`, which owns only the `pgboss` schema (`docs/pgboss-least-privilege.sql`). With it set, the API and worker never hold the owner credential. Production warns while it is unset.                                                                                                                 |
| `DATABASE_SSL_CA_FILE`                     | R in prod                       | unset                                  | Verify the database certificate **and hostname** against this PEM bundle — on AWS `/opt/dpdp/certs/rds-global-bundle.pem`, shipped in the image (pinned by SHA-256). While set, TLS parameters in the URLs are stripped, so no URL can turn verification off (`backend/src/database/pg-tls.ts`). An unreadable file stops startup. |
| `JWT_SECRET`                               | R 🔒                            | — (empty in `.env.example` on purpose) | Signs every session, invitation and **Gateway device token**, and their tenant claim. Anyone holding it can act as any tenant. Production: ≥ 32 random characters. Development warns loudly on a published example value. See [Rotating JWT_SECRET](#rotating-jwt_secret).                                                         |
| `MFA_SECRET_ENC_KEY`                       | R 🔒                            | —                                      | AES-256 key, exactly 32 bytes base64. See [shared data-at-rest keys](#shared-data-at-rest-keys).                                                                                                                                                                                                                                   |
| `SUBMISSION_STAGING_ENC_KEY`               | R 🔒                            | —                                      | AES-256 key, exactly 32 bytes base64. See [shared data-at-rest keys](#shared-data-at-rest-keys).                                                                                                                                                                                                                                   |
| `REQUEST_OTP_SECRET`                       | O 🔒                            | falls back to `JWT_SECRET`             | HMAC key for request-portal one-time codes at rest. Set separately in any real deployment.                                                                                                                                                                                                                                         |
| `WEB_ORIGIN`                               | R in prod                       | `http://localhost:3000`                | Dashboard origin(s) allowed by CORS, comma-separated, exact `scheme://host[:port]`. Also sent to enrolled Gateways as the origins their local listener accepts. Production warns if unset or plain-http.                                                                                                                           |
| `TRUST_PROXY`                              | R behind a LB                   | off                                    | Proxy hops in front of the API (`1` behind one load balancer). Without it every visitor shares one per-IP rate-limit bucket. Never `true` in production — that trusts any client-supplied `X-Forwarded-For`.                                                                                                                       |
| `API_PORT`                                 | O                               | `3001`                                 |                                                                                                                                                                                                                                                                                                                                    |
| `DB_POOL_MAX`                              | O                               | `10`                                   | Size of the `dpdp_app` pool, per process.                                                                                                                                                                                                                                                                                          |
| `MFA_ISSUER`                               | O                               | `DPDP Platform`                        | Name shown in authenticator apps.                                                                                                                                                                                                                                                                                                  |
| `ACCESS_TOKEN_TTL_SECONDS`                 | O                               | `15552000` (180 d)                     | No revocation list: this is the blast radius of a leaked token.                                                                                                                                                                                                                                                                    |
| `MFA_CHALLENGE_TTL_SECONDS`                | O                               | `300`                                  |                                                                                                                                                                                                                                                                                                                                    |
| `INVITE_TOKEN_TTL_SECONDS`                 | O                               | `604800` (7 d)                         |                                                                                                                                                                                                                                                                                                                                    |
| `PLATFORM_ADMIN_TOKEN_TTL_SECONDS`         | O                               | `43200` (12 h)                         |                                                                                                                                                                                                                                                                                                                                    |
| `GATEWAY_DEVICE_TOKEN_TTL_SECONDS`         | O                               | `2592000` (30 d)                       |                                                                                                                                                                                                                                                                                                                                    |
| `GATEWAY_ENROLLMENT_CODE_TTL_SECONDS`      | O                               | `900`                                  |                                                                                                                                                                                                                                                                                                                                    |
| `NOTIFY_TRANSPORT`                         | O                               | `console`                              | `console` or `http`. In production `console` logs only a redacted line and delivers nothing.                                                                                                                                                                                                                                       |
| `NOTIFY_HTTP_ENDPOINT`                     | O                               | —                                      | Required when `NOTIFY_TRANSPORT=http`.                                                                                                                                                                                                                                                                                             |
| `POSTMARK_API_KEY` / `POSTMARK_FROM_EMAIL` | O 🔒/—                          | —                                      | Real e-mail; used when both are set.                                                                                                                                                                                                                                                                                               |
| `MSG91_AUTH_KEY` / `MSG91_SENDER_ID`       | O 🔒/—                          | —                                      | Real SMS; used when both are set.                                                                                                                                                                                                                                                                                                  |
| `NOTIFY_DEV_ECHO_OTP`                      | O                               | `false`                                | Dev only: returns portal OTPs in the HTTP response. Ignored when `NODE_ENV=production`.                                                                                                                                                                                                                                            |
| `IMPORT_EVIDENCE_STORE`                    | O (prod: `s3`)                  | `local`                                | Where CSV/Excel import evidence goes. `local` = files under `backend/var` (lost on a container platform: production warns). `s3` = encrypted, write-once objects.                                                                                                                                                                  |
| `IMPORT_EVIDENCE_S3_BUCKET`                | R with `s3`                     | —                                      | Bucket name, validated.                                                                                                                                                                                                                                                                                                            |
| `IMPORT_EVIDENCE_S3_PREFIX`                | O                               | `inventory-import-evidence/`           | Plain path segments ending in `/`. Keys are `<prefix><tenant-uuid>/<sha256>.json` — no request text ever shapes a key.                                                                                                                                                                                                             |
| `IMPORT_EVIDENCE_S3_KMS_KEY_ID`            | O                               | —                                      | SSE-KMS with this key; unset = SSE-S3 (AES-256). Encryption is requested on every upload either way.                                                                                                                                                                                                                               |
| `IMPORT_EVIDENCE_RETENTION_DAYS`           | O                               | —                                      | Object Lock retention per object (1-3650 days, from the import time). The bucket must have Object Lock enabled at creation.                                                                                                                                                                                                        |
| `IMPORT_EVIDENCE_OBJECT_LOCK_MODE`         | O                               | `COMPLIANCE`                           | `COMPLIANCE` or `GOVERNANCE`; only with a retention period.                                                                                                                                                                                                                                                                        |
| `AWS_REGION`                               | R with `s3`                     | —                                      | Read by the AWS SDK, as are credentials (the ECS task role). Never put access keys in the environment.                                                                                                                                                                                                                             |

Every numeric setting must be a positive whole number — a typo used to become
`NaN` silently; it now stops startup.

## Worker (`backend` image, `node dist/worker.js`)

Same image, different command. It loads no identity module, so it needs **less** — though not as little as this page once said:

| Variable                                  |           | Notes                                                                                                                                                                                |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                | R         | As above.                                                                                                                                                                            |
| `APP_DATABASE_URL`                        | R 🔒      | As above. Also holds the worker's leadership lock.                                                                                                                                   |
| `PGBOSS_DATABASE_URL` (or `DATABASE_URL`) | R 🔒      | pg-boss.                                                                                                                                                                             |
| `MFA_SECRET_ENC_KEY`                      | R 🔒      | Its notification module decrypts **webhook signing secrets** with it. _This page previously said the worker needs neither encryption key; booting the real worker proved otherwise._ |
| `DATABASE_SSL_CA_FILE`                    | R in prod | As above.                                                                                                                                                                            |
| `DB_POOL_MAX`                             | O         | As above.                                                                                                                                                                            |
| `NOTIFY_*`, `POSTMARK_*`, `MSG91_*`       | O         | It sends deadline/escalation alerts.                                                                                                                                                 |

Do **not** give the worker `JWT_SECRET`, `REQUEST_OTP_SECRET`,
`SUBMISSION_STAGING_ENC_KEY` or any `IMPORT_EVIDENCE_*` — it never uses them.

### Exactly one worker

The WorkflowRunner is safe with several workers (each deadline is claimed in
one transaction), but the Enterprise storage sweep is not coordinated across
processes. So exactly one worker may be **active**, enforced twice:

1. **Deployment:** the ECS service runs one task, and deploys stop the old task
   before starting the new one (`deploy/aws/ecs/service-worker.json`:
   `desiredCount 1`, `maximumPercent 100`), checked by
   `backend/src/config/aws-deploy-templates.spec.ts`.
2. **In the process** (`backend/src/worker-leadership.ts`): before starting
   pg-boss or any ticker, the worker takes a PostgreSQL session advisory lock.
   A second worker — a manual `run-task`, a second service, a laptop pointed
   at the same database — logs _Another worker is already active. Standing
   by_ and does nothing until the first one's connection closes, then takes
   over (measured: about 12 s with the default 15 s poll). If the lock
   connection drops while active, the worker exits, so it can never run
   alongside a successor.

The lock needs a **session-level** connection: RDS direct is fine; a
transaction-mode pooler (PgBouncer/Supavisor transaction mode) is not.

## Frontend (`frontend`, Next.js)

| Variable                         |      | When                     | Notes                                                                                                                                                                                  |
| -------------------------------- | ---- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`            | R 🌐 | **build**                | The API's browser-reachable address (e.g. `https://api.example.com`). Baked into the bundle: changing it means a new image. Never an in-network name.                                  |
| `NEXT_PUBLIC_REQUIRE_ACTIVATION` | O 🌐 | build                    | `true` only for the customer installer's image (first-run activation gate).                                                                                                            |
| `NEXT_PUBLIC_GATEWAY_AGENT_URL`  | O 🌐 | build                    | Default Gateway address the browser tries first; the per-tenant enrolled endpoint normally wins.                                                                                       |
| `INTERNAL_API_URL`               | O    | **runtime**, server-only | Where the frontend's own server reaches the API for server-rendered public pages (`/forms/*`, `/portal/*`). Inside Docker: `http://backend:3001`. Falls back to `NEXT_PUBLIC_API_URL`. |
| `NODE_ENV`                       | R    | runtime                  | `production` in the image.                                                                                                                                                             |

The frontend container gets **no** backend secret — not even through Compose
(`docker-compose.yml` gives it no `env_file`). `turbo.json` lists the three
`NEXT_PUBLIC_*` values as global env so a cached build is never reused for a
different API address.

## Gateway / Agent (customer's machine — not part of the cloud deployment)

The Gateway runs on each customer's Windows computer as a service
(`gateway-installer/`), configured through its own `config.json` and the
Gateway Setup app; `agent/.env.example` covers running it from source. The
`agent` service in `docker-compose.yml` is a **local test harness** using the
same variables.

| Variable                               | Used by                                | Notes                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_BIND_HOST`                    | `agent/src/config.ts`                  | Default `127.0.0.1` (loopback). Never auto-`0.0.0.0`. Set explicitly (e.g. in Docker) for LAN/container reachability — the agent then logs a loud non-loopback warning.            |
| `GATEWAY_BIND_PORT`                    | `agent/src/config.ts`                  | Default `7071`.                                                                                                                                                                    |
| `GATEWAY_ALLOWED_ORIGINS`              | `agent/src/config.ts`                  | Comma-separated **exact** origins allowed to call the agent from a browser. No wildcards. Enrolled Gateways also accept the API's `WEB_ORIGIN` list, delivered over the heartbeat. |
| `GATEWAY_ALLOWED_HOSTS`                | `agent/src/config.ts`                  | Extra `Host` header values accepted by the local listener (DNS-rebinding defence).                                                                                                 |
| `GATEWAY_CONTROL_PLANE_URL`            | `agent/src/index.ts`, `enrollment.ts`  | The API's address. In production: the public `https://` API URL. In Docker: `http://backend:3001`. Unset = health-only listener.                                                   |
| `GATEWAY_NO_PROXY`                     | `agent/src/network-config.ts`          | Extra proxy exclusions **added** to `NO_PROXY`, never replacing it. Both compose files set it to `backend`. Check with `scripts/validate-compose-agent-proxy.ps1`.                 |
| `GATEWAY_ENROLLMENT_CODE`              | `agent/src/enrollment.ts`              | One-time bootstrap code. Only read when no credential is persisted yet. Supply transiently for the one run that enrolls; never write it to a file.                                 |
| `GATEWAY_STATE_DIR`                    | `agent/src/config.ts`, `enrollment.ts` | Where the device credential persists. Docker: a named volume.                                                                                                                      |
| `GATEWAY_CONFIG_PATH`                  | `agent/src/config-paths.ts`            | Path of the Windows service's `config.json`.                                                                                                                                       |
| `GATEWAY_DISPLAY_NAME`                 | `agent/src/config.ts`                  | Label shown to staff in the device list. Defaults to the hostname.                                                                                                                 |
| `GATEWAY_HEARTBEAT_INTERVAL_SECONDS`   | `agent/src/config.ts`                  | Default `60`, minimum `5`.                                                                                                                                                         |
| `GATEWAY_SOURCES`                      | `agent/src/connectors/registry.ts`     | JSON array of data sources for the data plane (dev/Docker; the Windows Gateway uses `sources.json`).                                                                               |
| `GATEWAY_STORAGE_ROOTS`                | `agent/src/storage/registry.ts`        | JSON `[{ storageRootId, rootPath }]` for the Storage Data-Plane; `rootPath` is the in-container path. Merged with the folders an administrator authorizes in Gateway Setup.        |
| `AGENT_LOCAL_STORAGE_ROOT`             | `agent/src/delivery/local-root.ts`     | The delivery poller's local Central-storage root (Docker test harness).                                                                                                            |
| `ELECTRON_STORAGE_CONFIG_PATH`         | `agent/src/delivery/local-root.ts`     | Takes precedence over the above when co-located with the desktop app.                                                                                                              |
| `AGENT_DELIVERY_POLL_INTERVAL_SECONDS` | `agent/src/delivery`                   | Default `10`.                                                                                                                                                                      |
| `NODE_EXTRA_CA_CERTS`                  | Node / `agent/src/tls-trust.ts`        | Corporate CA bundle for TLS-inspecting proxies.                                                                                                                                    |

### Docker-only (bind-mount sources; read by Compose, never by code)

`ENTERPRISE_STORAGE_HOST_DIR`, `GATEWAY_STORAGE_HOST_DIR`,
`AGENT_DELIVERY_HOST_DIR`, `API_PORT`, `WEB_PORT`, and — for the optional
`local-db` profile — `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`,
`POSTGRES_PORT`.

---

## Rotating JWT_SECRET

`.env.example` ships `JWT_SECRET` **empty**: a value printed in a public file
is not a secret, so there is nothing safe to copy. Generate your own; the API
will not start until you do. A local `.env` that still holds the old published
example value (`change_me_dev_jwt_secret`) makes the API log a loud warning at
every start — anyone with this repository could sign tokens it accepts.

**Locally** (never prints the value):

```bash
node scripts/rotate-jwt-secret.mjs --check   # unsafe? (exit 1 if so)
node scripts/rotate-jwt-secret.mjs           # replace it in ./.env
```

It replaces only the `JWT_SECRET` line (every other line and the line endings
are left as they are) with 64 random hex characters, written atomically.

**In production**, rotate the Secrets Manager value and force a new
deployment of the API service.

**What rotating breaks — plan for it:** every signed-in user is signed out;
pending invitations stop working (resend them); **every enrolled Gateway's
device token is rejected, so each Gateway must be paired again**; open MFA
challenges and platform-admin sessions end. No stored data is affected —
`JWT_SECRET` encrypts nothing.

## Shared data-at-rest keys

`MFA_SECRET_ENC_KEY` and `SUBMISSION_STAGING_ENC_KEY` are categorically
different from `JWT_SECRET`/`REQUEST_OTP_SECRET`. They encrypt data **at rest
in the shared central database**:

- `MFA_SECRET_ENC_KEY` (`identity/crypto/secret-cipher.ts`):
  `users.mfa_secret_ciphertext`, `tenant_consent_secrets.secret_ciphertext`
  (per-tenant subject-ref secrets, I2), webhook signing secrets.
- `SUBMISSION_STAGING_ENC_KEY` (`delivery/submission-delivery-crypto.ts`):
  consent-form values and files staged in `consent_form_submission_deliveries`
  until a tenant's Gateway collects them.

So **every runtime connected to the same database must hold the same value** —
a local `.env`, CI, the cloud deployment, and every customer installation
pointed at that database. A runtime with its own random value can encrypt but
never decrypt what another produced: an AES-GCM `Unsupported state or unable to
authenticate data` error in the logs means _wrong key_, not corruption. Real
rotation means re-encrypting the affected columns.

`installer/scripts/generate-env.ps1` takes both keys as explicit,
operator-supplied values for exactly this reason — never generated — through
`DPDP_*` environment variables rather than the command line, checks that each
is exactly 32 bytes, and adds `SUBMISSION_STAGING_ENC_KEY` to an existing
installation that predates it. The provisioning flow is in
`installer/README.md`, _Provisioning the shared keys_.

The previous `.env.example` shipped a dev value for both keys that decoded to
**35 bytes**, which both ciphers refuse — copying it produced a backend that
could not start. The current file ships a valid 32-byte dev value.

## Removed

| Variable                                | Why it was safe to remove                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_URL` | No Redis client is a dependency of any package and nothing imports one; jobs run on pg-boss in Postgres. Removed from `.env.example`, `turbo.json` and CI (which also started an unused Redis service). |
| `SUBJECT_REF_HMAC_PEPPER`               | Only mentioned in a comment explaining it is no longer used (`consent/subject-ref.ts`); the real per-tenant secret lives encrypted in `tenant_consent_secrets`.                                         |
| `POSTGRES_HOST`                         | Read by nothing — not code, not Compose, not scripts.                                                                                                                                                   |

An existing `.env` that still contains these lines keeps working; they are
simply ignored.
