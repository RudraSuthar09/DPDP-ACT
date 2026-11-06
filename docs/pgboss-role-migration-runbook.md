# Runbook: move pg-boss to its own role (`dpdp_jobs`)

Applies `docs/pgboss-least-privilege.sql` to an **existing** database where
pg-boss already runs as the schema owner — today, the hosted (Supabase) dev
database. On a brand-new RDS database the order is different and simpler: see
`docs/aws-deployment.md` §2.

**Status: not applied. Requires explicit approval before step 4.**

What changes: ownership of the `pgboss` schema and every object in it moves to
a new login role `dpdp_jobs`. Tenant tables, data and the `public`/`app` schemas
are not touched. The API and worker then reach pg-boss with
`PGBOSS_DATABASE_URL` instead of the owner credential.

Expected downtime: background jobs and the API are stopped for the duration of
steps 3–7, typically under 10 minutes. Public pages (hosted forms, the portal)
are unavailable while the API is stopped.

---

## 0. Before the window

- [ ] Approval recorded (who, when).
- [ ] A maintenance window agreed; anyone testing on the shared database told.
- [ ] **Inventory every process that uses this database.** All of them must be
      stopped in step 3. On the development machine today that is:
  - the dev stack: `docker compose` project `dpdp-act` (`dpdp-backend`, `dpdp-worker`);
  - the **installed** platform: compose project `dpdp`
    (`%APPDATA%\DPDP Platform\runtime\docker-compose.runtime.yml`) — its
    `dpdp-worker-1` was running on 2026-11-04 on an older image **without**
    the single-worker lock, i.e. as a second worker on the same database;
  - any `pnpm dev:api` / `node dist/worker.js` started by hand.
- [ ] Generate the `dpdp_jobs` password (32+ random characters) and store it
      **only** in the secrets store / the local `.env`, never in the SQL file
      on disk or in a command line. Paste it into the SQL in the SQL editor,
      run, and discard the edited copy.
- [ ] Decide the connection path for `dpdp_jobs`. pg-boss needs a **session**
      connection: Supabase direct connection or the pooler in _session_ mode
      (port 5432) — not the transaction pooler (6543). Through the Supabase
      pooler the user name is `dpdp_jobs.<project-ref>`.

## 1. Pre-flight (read-only; run in the SQL editor as the admin user)

```sql
SELECT current_user, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user;
SELECT nspowner::regrole AS pgboss_owner FROM pg_namespace WHERE nspname = 'pgboss';
SELECT relowner::regrole AS owner, relkind, count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'pgboss' GROUP BY 1, 2;
SELECT pg_has_role(current_user, (SELECT nspowner FROM pg_namespace WHERE nspname = 'pgboss'), 'MEMBER')
  AS admin_is_member_of_current_owner;
SELECT version FROM pgboss.version;
SELECT state, count(*) FROM pgboss.job GROUP BY 1;
SELECT usename, application_name, count(*) FROM pg_stat_activity
  WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 3 DESC;
```

Go / no-go:

- [ ] `pgboss_owner` is a single role (expected `dpdp_owner`), and every
      object in `pgboss` has that same owner.
- [ ] `admin_is_member_of_current_owner` is `true`. (`ALTER … OWNER` needs
      membership in both the old and the new owner; the script grants the
      new one itself.)
- [ ] No `active` jobs you care about (they will be retried after restart, but
      a quiet moment is better).
- [ ] Record the output — it is the "before" picture for rollback.

## 2. Backup

- [ ] Confirm the provider's backup is recent (Supabase dashboard → Database
      → Backups; note the timestamp) — or take one.
- [ ] Logical copy of just the pg-boss schema, as a quick restore point
      (command below). Credentials from a `pgpass` file or `PGPASSWORD` set
      in the shell session — never in the command.

```bash
pg_dump --schema=pgboss --format=custom --file=pgboss-before-role-move.dump "host=… port=5432 dbname=postgres user=…"
```

## 3. Stop everything that uses pg-boss

- [ ] Installed platform: `docker compose -p dpdp stop` (or its `stop.ps1`).
- [ ] Dev stack: `docker compose stop worker backend frontend`.
- [ ] Re-run the last pre-flight query: no `dpdp-*` application connections
      remain (other than your SQL session).

## 4. Apply (approval required)

- [ ] In the SQL editor, paste `docs/pgboss-least-privilege.sql`, replace
      `REPLACE_WITH_STRONG_SECRET_3` with the generated password, run it once.
      It is idempotent; it refuses if the `pgboss` schema is missing.

## 5. Verify the database side

```sql
SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'pgboss';            -- dpdp_jobs
SELECT DISTINCT relowner::regrole FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'pgboss';                                                    -- only dpdp_jobs
SELECT has_table_privilege('dpdp_jobs', 'public.consent_forms', 'SELECT');      -- false
SELECT has_table_privilege('dpdp_jobs', 'public.users', 'SELECT');              -- false
SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'dpdp_jobs'; -- all false
```

## 6. Configure

- [ ] Add `PGBOSS_DATABASE_URL` (user `dpdp_jobs`, session connection,
      `sslmode` as for the other URLs) to:
  - the dev `.env` (both `backend` and `worker` read it);
  - the installed platform's `config\.env`, if that installation stays in use;
  - on AWS: secret `dpdp/prod/pgboss-database-url` (already referenced by the
    API and worker task definitions).
- [ ] Leave `DATABASE_URL` in place for migrations only.

## 7. Start and verify the application

- [ ] `docker compose up -d backend worker frontend`.
- [ ] Worker log: `Worker leadership acquired` and `pg-boss started (schema=pgboss …)`; no `permission denied`.
- [ ] With `NODE_ENV=production` only: the startup warning "pg-boss is using
      DATABASE_URL, the schema OWNER credential" no longer appears.
- [ ] `/health` returns 200.
- [ ] Functional: trigger something that queues a job (e.g. create a data
      principal request or a consent event with a webhook configured) and
      watch it complete; jobs queued **before** the switch are also processed.
- [ ] `SELECT usename, application_name FROM pg_stat_activity` shows
      pg-boss connections as `dpdp_jobs`.
- [ ] Only then restart the installed platform, **after** updating its image
      (an older image has neither `PGBOSS_DATABASE_URL` support nor the
      single-worker lock).

## 8. Rollback

Any failure in steps 4–7: stop the API and worker again, then as the admin:

```sql
GRANT dpdp_owner TO current_user;
ALTER SCHEMA pgboss OWNER TO dpdp_owner;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'pgboss' AND c.relkind IN ('r','p','S','v','m')
              AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d
                       WHERE d.objid = c.oid AND d.deptype = 'a' AND d.classid = 'pg_class'::regclass))
  LOOP
    EXECUTE format('ALTER %s pgboss.%I OWNER TO dpdp_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.relname);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'pgboss' AND t.typtype IN ('e','d','c')
              AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
  LOOP EXECUTE format('ALTER TYPE pgboss.%I OWNER TO dpdp_owner', r.typname); END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'pgboss'
  LOOP EXECUTE format('ALTER ROUTINE %s OWNER TO dpdp_owner', r.sig); END LOOP;
END $$;
```

Then remove `PGBOSS_DATABASE_URL` everywhere and start the services; they fall
back to `DATABASE_URL`. The role can stay (it owns nothing) or be dropped with
`DROP ROLE dpdp_jobs;`. Last resort: restore `pgboss-before-role-move.dump`
or the provider backup.

## 9. Record

- [ ] Date, operator, before/after query output, any jobs that failed.
- [ ] Update `docs/pgboss-least-privilege.sql`'s STATUS line.
