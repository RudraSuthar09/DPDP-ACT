# AWS deployment — ap-south-1, ECS Fargate

Status: **ready to deploy, not deployed.** Nothing has been created on AWS.
Every behaviour described as "verified" below was exercised against real
PostgreSQL, Docker and Windows PowerShell locally — not against AWS.

Variables: `docs/environment-variables.md`. Production template:
`.env.production.example`. ECS templates: `deploy/aws/ecs/`.

## Decisions taken

| Decision        | Value                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Region          | `ap-south-1` (Mumbai)                                                                                          |
| Compute         | ECS on Fargate: services `dpdp-api`, `dpdp-frontend`, `dpdp-worker` (exactly one), one-off task `dpdp-migrate` |
| Database        | RDS for PostgreSQL in private subnets, TLS verified against the official Amazon RDS CA bundle                  |
| Import evidence | S3, SSE-KMS, write-once objects, Object Lock retention (configurable)                                          |

## 1. What runs where

| Component                 | Where                                  | Notes                                                                                              |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| API (`dist/main.js`)      | ECS service, ≥ 2 tasks, behind the ALB | Also serves the Consent SDK at `/consent-sdk/v1/*`.                                                |
| Frontend (Next.js)        | ECS service, ≥ 2 tasks, behind the ALB | Server-rendered; not a static site. One image per environment (`NEXT_PUBLIC_API_URL` is baked in). |
| Worker (`dist/worker.js`) | ECS service, **exactly 1**             | See §4.                                                                                            |
| Migrations                | One-off ECS task                       | `node-pg-migrate up`, then `dist/pgboss-install.js`. The only holder of the owner credential.      |
| PostgreSQL                | RDS, Multi-AZ, private subnets         | The only datastore. Jobs run on pg-boss inside it.                                                 |
| Import evidence           | S3                                     | See §5.                                                                                            |
| Gateway                   | **Not AWS**                            | Customer Windows machines; reaches `https://api.<domain>` only.                                    |

Supporting services (required): ECR, ALB + ACM, Route 53 (or your DNS),
Secrets Manager, CloudWatch Logs, KMS, VPC with public (ALB) and private
(tasks, RDS) subnets, NAT gateway or VPC endpoints. Optional later: CloudFront,
WAF, RDS Proxy, AWS Backup, Container Insights.

## 2. Database credentials — least privilege

| Role         | Used by                             | Can                                                                                                                       |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `dpdp_owner` | migration task only                 | Owns the schema.                                                                                                          |
| `dpdp_app`   | API, worker                         | RLS-enforced tenant access. Also holds the worker lock.                                                                   |
| `dpdp_jobs`  | API, worker (`PGBOSS_DATABASE_URL`) | Owns the `pgboss` schema and **nothing else**: no tenant table, no `app` schema, no CREATE on the database, no BYPASSRLS. |

So the running API and worker never hold the owner credential. Verified on
PostgreSQL 18 with a non-superuser admin (RDS-master-like): the role cannot
read or write a tenant table, pg-boss works fully on it, jobs queued before
the switch are picked up after it, and the real worker boots with no
`DATABASE_URL` at all.

**Setup order on a new database** (enforced — the SQL refuses the wrong order):

0. As the RDS master user: `docs/managed-postgres-setup.sql`. It grants
   `dpdp_owner` CREATE on the database, which pg-boss's first install needs
   (without it the migration task fails with "permission denied for
   database" — found in the 2026-11-04 rehearsal).
1. Migration task: `node-pg-migrate up` → `node dist/pgboss-install.js`
   (installs pg-boss's schema as the owner; afterwards a no-op, see below).
2. Once, as the RDS master user: `docs/pgboss-least-privilege.sql` (replace its
   placeholder password first; store it only in Secrets Manager as part of
   `PGBOSS_DATABASE_URL`). Then `REVOKE CREATE ON DATABASE <db> FROM dpdp_owner;`
   — no longer needed.
3. Deploy API and worker with `PGBOSS_DATABASE_URL`.

After step 2 the owner can no longer touch `pgboss` — by design. Subsequent
migration runs see that and skip the pg-boss step (verified: it exits 0 with
"Nothing to do"); `dpdp_jobs` performs pg-boss's own upgrades at startup.

> **Not applied to the current hosted database.** There, pg-boss already runs
> as the owner. Switching it is an ownership change with a checklist,
> verification and a tested rollback: `docs/pgboss-role-migration-runbook.md`.
> Needs your approval and a maintenance window.

## 3. Database TLS

`DATABASE_SSL_CA_FILE=/opt/dpdp/certs/rds-global-bundle.pem` on the API,
worker and migration task. The backend image contains the official bundle
(`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`, 114 CAs
including the three `ap-south-1` roots, valid to 2061/2121), pinned by
SHA-256 in `backend/Dockerfile`.

With it set, `backend/src/database/pg-tls.ts`:

- verifies the certificate chain against the bundle (`rejectUnauthorized`);
- verifies the certificate names the host **actually in the URL**. (node-postgres
  on its own checks an IP-addressed host against the name "localhost" — found
  and closed during testing);
- strips every TLS parameter from the URL first, because node-postgres lets a
  URL override the code's TLS settings — so a `sslmode=no-verify` left in a
  secret can never switch verification off.

The migration task's `node-pg-migrate` reads TLS from its URL, so that URL
carries `?sslmode=verify-full&sslrootcert=/opt/dpdp/certs/rds-global-bundle.pem`.

Verified against a real TLS PostgreSQL: right CA connects; rogue CA refused;
wrong hostname refused; `sslmode=no-verify` and `sslmode=disable` in the URL
with a rogue CA still refused; all 58 migrations applied through the
`verify-full` URL; pg-boss connections all TLS.

**Refreshing the bundle.** When AWS publishes a new bundle the image build
fails at the checksum, deliberately. Download it, check it, update the pin:

```bash
curl -fsS -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sha256sum global-bundle.pem          # put this in backend/Dockerfile's --checksum
```

## 4. Exactly one worker

1. **ECS** (`deploy/aws/ecs/service-worker.json`): `desiredCount 1`,
   `minimumHealthyPercent 0`, `maximumPercent 100` — a deploy stops the old
   worker before starting the new one. No autoscaling on this service.
2. **The worker itself** (`backend/src/worker-leadership.ts`): it takes a
   PostgreSQL advisory lock before starting pg-boss or any ticker. Anything
   that still starts a second worker (a manual `run-task`, a second service, a
   laptop on the same database) stands by and starts nothing. Verified with two
   real worker processes: the second stood by, then took over ~12 s after the
   first was killed; never two holders.

To avoid accidental duplicates: don't use `run-task` with the worker task
definition; don't add a scaling policy to `dpdp-worker`; give no other service
the `dist/worker.js` command (a test enforces this for the templates). Even if
one of these happens, the lock keeps the extra worker idle.

## 5. Import evidence in S3

`IMPORT_EVIDENCE_STORE=s3`. One object per import declaration,
`inventory-import-evidence/<tenant-uuid>/<sha256>.json`, containing the
declaration only (file name, header names, row count, hash — never a data
row). Each upload is conditional (`If-None-Match: *`, never overwrites),
checksummed (SHA-256), encrypted (SSE-KMS with the configured key, else
SSE-S3), and — with `IMPORT_EVIDENCE_RETENTION_DAYS` — locked (Object Lock,
`COMPLIANCE` by default). An upload failure fails the import; nothing is
recorded without its evidence.

Bucket (create once, `ap-south-1`):

- **Object Lock enabled at creation** (cannot be added later) — required for retention.
- Block Public Access on; default encryption SSE-KMS with the same key; bucket
  policy denying non-TLS (`aws:SecureTransport`) requests.
- Optionally versioning (implied by Object Lock) and a lifecycle rule to
  expire objects after the retention period.

API task role (least privilege):

```json
{ "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:PutObjectRetention"],
  "Resource": "arn:aws:s3:::<bucket>/inventory-import-evidence/*" }
{ "Effect": "Allow",
  "Action": ["kms:GenerateDataKey"],
  "Resource": "<kms-key-arn>" }
```

No read or delete permission: the application never reads evidence back.
Credentials come from the task role; no access keys anywhere.

Locally the default stays `local` (files under `backend/var`) — unchanged.

## 6. Service settings

| Setting                      | Value                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| API / frontend desired count | ≥ 2                                                                                                    |
| Worker desired count         | 1                                                                                                      |
| `stopTimeout`                | 30 s (Nest closes pg-boss and pools; the worker releases its lock last)                                |
| ALB health checks            | API `GET /health`, frontend `GET /`                                                                    |
| API `TRUST_PROXY`            | `1`                                                                                                    |
| Connections                  | `(API tasks + worker) × (DB_POOL_MAX + pg-boss's 10) + 1 (worker lock)` must fit RDS `max_connections` |
| Logs                         | CloudWatch, set a retention period; OTPs/addresses are redacted in production                          |

## 7. Deployment sequence

1. **Network:** VPC, subnets, NAT/endpoints, security groups (ALB → tasks 3000/3001; tasks → RDS 5432 only).
2. **KMS key, S3 bucket** (§5), **IAM** roles: execution role (ECR pull, read the `dpdp/prod/*` secrets), API/worker task roles (§5; worker needs none).
3. **RDS** (encrypted, Multi-AZ, backups ≥ 7 days, deletion protection). Run `docs/managed-postgres-setup.sql` (replace its placeholders).
4. **Secrets** in Secrets Manager (`dpdp/prod/*`, names as in the task templates). Copy `MFA_SECRET_ENC_KEY` and `SUBMISSION_STAGING_ENC_KEY` from the current environment **if data moves** — new keys make existing ciphertext unreadable.
5. **Images** to ECR, tagged with the commit SHA:
   ```bash
   docker build -f backend/Dockerfile -t <acct>.dkr.ecr.ap-south-1.amazonaws.com/dpdp-backend:<sha> .
   docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.<domain> \
     -t <acct>.dkr.ecr.ap-south-1.amazonaws.com/dpdp-frontend:<sha> .
   ```
   Build from a clean checkout (CI), not a developer machine: `.dockerignore`
   keeps local state (`.env` files, `.localdb`, `backend/var`, installer output)
   out of the build context, but a clean checkout is the guarantee. CI's
   _Production images_ job builds both images on every change (nothing pushed).
6. **Migrate:** snapshot, then run `dpdp-migrate`. On a database restored from the current hosted one, add `--no-check-order` (a known pair of migrations shares a timestamp).
7. **pg-boss role:** `docs/pgboss-least-privilege.sql` once (§2).
8. **Data** (only if moving from the current hosted database): follow `docs/rds-migration-rehearsal.md` — rehearse on a throwaway instance first, then the cutover in a write freeze. Dry-run locally; not yet rehearsed against the real source.
9. **Deploy** `dpdp-api`, then `dpdp-worker`, then `dpdp-frontend` (fill in the `<…>` placeholders in `deploy/aws/ecs/`).
10. **ALB + ACM + DNS**.
11. **Verify:** `/health` 200; sign-in; `/consent-sdk/v1/consent-sdk.min.js` 200; a hosted form opens; a test import writes one encrypted, locked object; the worker logs _Worker leadership acquired_; a test OTP arrives; a Gateway pairs against `https://api.<domain>`.
12. **Alarms and backups** before real traffic.

Rollback: redeploy previous image tags; for schema, the pre-migration snapshot.

## 8. Blockers

### Resolved

| Was                                                                                                | Now                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Import evidence on container disk (lost on every deploy)                                           | S3 store (§5); local unchanged                                                                                     |
| Installer never provisioned `SUBMISSION_STAGING_ENC_KEY` (fresh installs could not start)          | Operator-supplied, validated, via environment variables, added to existing installs; flow in `installer/README.md` |
| pg-boss held the owner credential at runtime                                                       | Own role `dpdp_jobs` supported, SQL written and verified (§2)                                                      |
| RDS TLS undecided                                                                                  | Verified against the pinned RDS bundle, hostname included (§3)                                                     |
| Single worker only by convention                                                                   | Enforced by ECS config and a database lock (§4)                                                                    |
| `.env.example` shipped a usable-looking `JWT_SECRET`                                               | Empty on purpose; rotation script and procedure (`docs/environment-variables.md`)                                  |
| Local `.env` used the published example `JWT_SECRET`                                               | Rotated 2026-11-04                                                                                                 |
| `installer/config/.env` had a different `MFA_SECRET_ENC_KEY` on the same database                  | Aligned to the key that decrypts 283/285 existing records (2026-11-04)                                             |
| `managed-postgres-setup.sql` hard-coded database `postgres`; no CREATE for pg-boss's first install | Uses the current database; grants CREATE (revoked after the pg-boss hand-over)                                     |

### Remaining

1. **Apply the pg-boss role change to the hosted database** — needs approval and a window (`docs/pgboss-role-migration-runbook.md`).
2. **Two MFA records the current key cannot decrypt** (found 2026-11-04, read-only check): one real owner account (needs the old installer key; re-encrypt or reset its MFA) and one test account (key lost). Fixing either changes hosted data — needs approval. `docs/rds-migration-rehearsal.md` §8.
3. **An installed-platform worker on an older image** (no single-worker lock) runs against the hosted database alongside the dev worker. Stop or update it.
4. **Distributing central keys to customer installations** is now secure in transit and validated, but remains a design choice: every installation holds the keys that decrypt central data. Long term, prefer installations that do not need them.
5. **Data move** from the hosted database to RDS: plan written and dry-run locally (`docs/rds-migration-rehearsal.md`); the real rehearsal needs approval (read-only access to the source, a throwaway RDS instance).
6. **Enterprise "server" storage** (`/enterprise-storage` bind mount) is an on-premises feature; leave it unconfigured in the cloud or decide on EFS.

## 9. Still needed from you

- AWS account, the two domain names, and DNS control.
- RDS sizing and backup window.
- Evidence retention period (days) and the KMS key policy owner.
- Postmark (server token + verified sender) and MSG91 (auth key + DLT-registered sender).
- Whether data moves from the hosted database, and when.
- Approval and a window for the hosted pg-boss role switch.
