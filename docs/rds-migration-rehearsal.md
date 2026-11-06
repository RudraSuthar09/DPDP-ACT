# Plan: rehearse moving the hosted database to RDS

Moves the current hosted (Supabase) development database into RDS for
PostgreSQL in `ap-south-1`, keeping **every row, every ciphertext, the audit
hash chain, RLS, ownership, grants and the migration history** exactly as they
are. This document is the plan for a **rehearsal**: a copy into a throwaway RDS
instance while the source keeps running. The real cutover (§7) repeats it with
writes frozen.

**Status: planned, not performed.** Nothing has connected to the hosted
database for this plan, and no AWS resource exists. Steps marked
**[approval]** touch the hosted database (read-only) or create AWS resources.

## 1. What a local dry run already proved

On 2026-11-04 the whole procedure ran end to end on a disposable local
PostgreSQL 16 with the real 58 migrations, real triggers and forced RLS, and
seeded data whose ciphertext was produced by the backend's own
`AesGcmSecretCipher`. The restoring admin was a **non-superuser without
BYPASSRLS** — the position of the RDS master user. Results:

| Check                                                               | Result                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pg_dump` by a role without BYPASSRLS (the owner, or a plain admin) | **Fails** on the first forced-RLS table — so the source dump needs a BYPASSRLS role (§3)                                                                                                                                                   |
| Restore with ownership, as the non-superuser admin                  | Succeeds. RLS (79 tables), policies (81) and all triggers are in the dump's _post-data_ section, so rows load before any RLS, constraint or trigger exists: no RLS refusal, no trigger rewriting audit hashes, no duplicate directory rows |
| Before/after fingerprint (§5)                                       | Identical: migration history (58), row counts, ciphertext checksums, audit-chain checksum and 0 broken links, portal slugs, 79 forced-RLS tables, 81 policies, ownership, `dpdp_app` grants                                                |
| Effective privileges of every role on every table                   | Identical (the only catalog difference is an explicit owner-only ACL on the `consent_events` partitions that `pg_dump` omits because it equals the default)                                                                                |
| Functions (owner, SECURITY DEFINER, `search_path`)                  | Identical                                                                                                                                                                                                                                  |
| Ciphertext decrypts on the target, read as `dpdp_app` through RLS   | 6/6 MFA secrets, 3/3 consent secrets                                                                                                                                                                                                       |
| Tenant isolation on the target                                      | No tenant set → 0 rows; each tenant sees only its own                                                                                                                                                                                      |
| Audit chain after the move                                          | A new entry appends at the next `seq`; `UPDATE` on `audit_log` still refused                                                                                                                                                               |
| `node-pg-migrate up` on the target                                  | "No migrations to run"                                                                                                                                                                                                                     |
| pg-boss                                                             | Queued jobs carried over; works as owner; `docs/pgboss-least-privilege.sql` then works on the restored copy                                                                                                                                |

What the dry run could **not** prove — the reasons for the real rehearsal:
Supabase's actual roles and grants, the source's PostgreSQL version, the RDS
master user's real attributes, data volume and timing, network path.

## 2. Pre-flight

### 2a. Source (hosted) — read-only **[approval]**

Run in the Supabase SQL editor (it runs as `postgres`). Read-only queries:

```sql
SHOW server_version;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;   -- need bypassrls = true
SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) FROM pg_class c
  WHERE c.relnamespace IN ('public'::regnamespace, 'app'::regnamespace, 'pgboss'::regnamespace);
SELECT count(*), max(name) FROM public.pgmigrations;                                     -- expect 58
-- Grants to roles that will not exist on RDS (anon, authenticated, service_role, …):
SELECT DISTINCT grantee FROM information_schema.role_table_grants
  WHERE table_schema IN ('public', 'app', 'pgboss')
    AND grantee NOT IN ('dpdp_owner', 'dpdp_app', 'dpdp_jobs', 'postgres', 'PUBLIC');
-- Objects in our schemas not owned by our roles (Supabase-created extras):
SELECT c.oid::regclass, c.relowner::regrole FROM pg_class c
  WHERE c.relnamespace IN ('public'::regnamespace, 'app'::regnamespace, 'pgboss'::regnamespace)
    AND c.relowner::regrole::text NOT IN ('dpdp_owner', 'dpdp_jobs');
SELECT extname, extnamespace::regnamespace FROM pg_extension;                           -- the app needs none
```

Go / no-go:

- [ ] `rolbypassrls = true` for the dumping role. If false: a role that has
      it is needed (ask Supabase support), or the dump must be taken with
      forced RLS temporarily lifted under a write freeze — a hosted change,
      **separate approval**. **Never** use `pg_dump --enable-row-security`:
      with no tenant set it silently dumps zero rows of every tenant table.
- [ ] Any grantee listed in the grants query has a plan: either create a
      `NOLOGIN` role of the same name on the rehearsal instance before restoring
      (then `REVOKE` and drop it after), or confirm it can be ignored.
- [ ] Any object not owned by our roles is understood (expected: none).
- [ ] Note the size: it sets the instance size and the time budget.

### 2b. Target (rehearsal RDS) **[approval: creates AWS resources]**

- [ ] RDS for PostgreSQL, `ap-south-1`, **same or newer major** than the
      source, private subnets, encrypted, a parameter group with
      `rds.force_ssl = 1`. Throwaway: no Multi-AZ needed, deletion protection off.
- [ ] A jump host in the same VPC (EC2 or an ECS one-off task with
      `postgresql-client` of the **target's** major version, which must be
      ≥ the source's).
- [ ] As the master user: `docs/managed-postgres-setup.sql` (fresh
      passwords; it uses whatever the database is called). Then:
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;` — note
      it; it decides how §5 counts rows.

## 3. Dump (read-only on the source) **[approval]**

From the jump host. Credentials from a `~/.pgpass` file (mode 600) or
`PGPASSWORD` exported in that shell — never on the command line. Use the
Supabase **direct** connection or the session pooler (port 5432), and verify
TLS (`sslmode=verify-full` with Supabase's CA).

```bash
pg_dump --format=custom --schema=public --schema=app --schema=pgboss \
  --file=dpdp-$(date +%Y%m%d-%H%M).dump "host=<source-host> port=5432 dbname=postgres user=<bypassrls-role> sslmode=verify-full sslrootcert=<supabase-ca.crt>"
sha256sum dpdp-*.dump > dpdp.dump.sha256
```

The dump contains every ciphertext and the audit log: treat it as secret
material. Keep it on the jump host's encrypted volume, never in the repo, and
delete it with the rehearsal instance.

## 4. Restore (as the RDS master user)

```bash
pg_restore --list dpdp-*.dump | grep -vE ' SCHEMA - (public|app) ' > restore.list   # both already exist
pg_restore --exit-on-error --use-list=restore.list --dbname="host=<rds-endpoint> dbname=<db> user=<master> sslmode=verify-full sslrootcert=/path/rds-global-bundle.pem" dpdp-*.dump
```

- With ownership (**no** `--no-owner`, **no** `--no-privileges`): objects
  must stay owned by `dpdp_owner`, or RLS stops applying to the right roles
  and migrations can no longer alter them.
- If it stops on a role that does not exist, that is a §2a grantee: create
  it `NOLOGIN`, drop the database, and restart the restore.

## 5. Verify

Record each result next to the source's.

1. **Fingerprint** — run the same read-only script on both sides and `diff`:
   migration count and last name; row counts; checksums of users'
   ciphertext, consent secrets, the audit chain; audit links that fail
   re-verification (must be 0); forced-RLS table count; policy count;
   ownership; `dpdp_app` grants; disabled triggers (must be 0). The dry run's
   script is the template; on RDS run it as a BYPASSRLS role, or — if the
   master has none — per tenant as `dpdp_owner`, taking the tenant list from
   `app.org_directory` (not RLS-protected) and setting `app.current_tenant`
   before each count.
2. **Every table's row count**, same method, both sides, `diff`.
3. **Decryption** with the production keys, read as `dpdp_app` through RLS.
   Expected from the 2026-11-04 read-only check of the hosted data: 283 of
   285 ciphertexts decrypt with the root `.env` `MFA_SECRET_ENC_KEY`
   (210 MFA, 53 consent, 20 webhook); exactly **two known exceptions**:
   user `c8f402f3…` (needs the old installer key) and `b87a1950…` (test
   account, key lost). Any other failure is a stop.
4. **Application**: run `dpdp-migrate` against the copy → "No migrations to
   run" (if it reports an ordering complaint caused by the two migrations
   sharing timestamp `1737002400000`, rerun with `--no-check-order`); start
   an API and the worker against it; sign in; open a hosted form; check
   `GET /audit/verify` reports the chain intact; queue a job.
5. **pg-boss role**: apply `docs/pgboss-least-privilege.sql` to the copy
   and repeat the queue check as `dpdp_jobs`.
6. **Timing**: dump duration, restore duration, verification duration. Their
   sum plus margin is the cutover's write-freeze window.

## 6. Tear down

Delete the rehearsal instance and its snapshots, the jump host volume and the
dump. Record results, timings and any deviations in this document.

## 7. The real cutover (after a successful rehearsal)

Same steps, plus:

- [ ] Announce and start a **write freeze**: stop every process on the
      source — dev stack, the installed platform's containers, anything by
      hand (see `docs/pgboss-role-migration-runbook.md` §0 for the list).
- [ ] Final dump → restore into the production RDS (Multi-AZ, deletion
      protection, backups) → full §5 verification.
- [ ] Secrets in Secrets Manager: **copy** `MFA_SECRET_ENC_KEY` and
      `SUBMISSION_STAGING_ENC_KEY` from the current root `.env` (new values
      would make existing ciphertext unreadable). `JWT_SECRET` and
      `REQUEST_OTP_SECRET` may be new (everyone signs in again; pending
      one-time codes expire; Gateways re-pair).
- [ ] Start ECS services; smoke tests from `docs/aws-deployment.md` §7.
- [ ] Rollback: the source was never modified — point the services back at
      it. Keep it read-only and untouched for an agreed period before
      decommissioning.

### Data that does not live in the database

- **Import evidence** written so far is in container-local
  `backend/var/inventory-import-evidence/` of whichever stack received the
  import. Its location is recorded inside hash-chained audit entries
  (`evidencePath`), which must not be edited. Copy the files to the
  evidence bucket under the same `<tenant>/<sha256>.json` names (the hash
  in the audit entry identifies the object) and keep an archive of the
  originals.
- **Enterprise server storage** and Gateway host folders stay where they are.

## 8. Known issues to settle before the cutover

- The two outlier MFA records (§5.3): re-encrypt `c8f402f3…` under the
  current key or reset that user's MFA; reset or remove the test account
  `b87a1950…`. Both are changes to hosted data — **separate approval**.
- The installed platform on the development machine runs an **older worker
  image without the single-worker lock** against the hosted database; stop
  or update it before either the pg-boss role change or the cutover.
