-- =============================================================================
-- pg-boss on its own least-privilege role: dpdp_jobs
-- =============================================================================
--
-- WHAT THIS CHANGES. Today pg-boss (the job queue inside the API and worker)
-- connects with DATABASE_URL — the schema OWNER, which owns every tenant table.
-- pg-boss only ever needs its own `pgboss` schema. After this script:
--
--   dpdp_jobs   owns schema `pgboss` and every object in it, and NOTHING else:
--               no rights on `public` tables, no rights on `app`, not a
--               superuser, cannot create roles or databases, no BYPASSRLS.
--
-- The application then runs with PGBOSS_DATABASE_URL pointing at dpdp_jobs,
-- so neither the API nor the worker holds the owner credential at all. Only
-- the migration task keeps DATABASE_URL (the owner).
--
-- STATUS: NOT APPLIED ANYWHERE. Verified on a disposable local PostgreSQL —
-- both on a fresh database and on one where pg-boss had already created its
-- schema as the owner (see the deployment-readiness report). Applying it to a
-- shared database is a change of object ownership: review, then run it in a
-- maintenance window, then switch the app to PGBOSS_DATABASE_URL.
--
-- HOW TO RUN
--   * As the database's administrative user (RDS: the master user; it must be
--     a member of dpdp_owner — docs/managed-postgres-setup.sql grants that).
--   * Replace REPLACE_WITH_STRONG_SECRET_3 first; store that password ONLY in
--     the secrets manager, as part of PGBOSS_DATABASE_URL.
--   * Idempotent: safe to run again.
--   * ORDER MATTERS. Once ownership moves, dpdp_owner can no longer use the
--     pg-boss tables — so an API or worker still on DATABASE_URL would fail.
--     Do it as one change: (1) stop the worker and API, (2) run this script,
--     (3) set PGBOSS_DATABASE_URL on both, (4) start them again.
--
-- ROLLBACK: ALTER SCHEMA pgboss OWNER TO dpdp_owner, and the same loop below
-- with dpdp_owner as the target; unset PGBOSS_DATABASE_URL.
-- =============================================================================

-- 1. The role. LOGIN only; no inherited privileges.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpdp_jobs') THEN
    CREATE ROLE dpdp_jobs LOGIN PASSWORD 'REPLACE_WITH_STRONG_SECRET_3'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- The administrator must be able to act as dpdp_jobs to hand objects to it
-- (PostgreSQL requires membership in the NEW owner for ALTER ... OWNER).
GRANT dpdp_jobs TO current_user;

-- 2. It may connect to this database — nothing more at database level.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dpdp_jobs', current_database());
END
$$;

-- 3. The schema must already exist. pg-boss's very first install issues
--    CREATE SCHEMA, and PostgreSQL checks the database-level CREATE right
--    before it checks whether the schema exists — so dpdp_jobs (which
--    deliberately has no CREATE on the database) cannot do the first install
--    itself, and creating an empty schema here would only break the owner's
--    install. On a NEW database run, as the owner, first:
--        node dist/pgboss-install.js
--    Refusing here keeps that order from being got wrong.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    RAISE EXCEPTION 'The pgboss schema does not exist yet. Install it first as the owner: node dist/pgboss-install.js (see the header of this file).';
  END IF;
END
$$;
ALTER SCHEMA pgboss OWNER TO dpdp_jobs;

-- 4. Everything pg-boss already created (only if it has run as the owner
--    before): tables (incl. partitioned parents and their partitions),
--    sequences, the job_state type, and its functions. Indexes follow their
--    tables automatically.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'pgboss'
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
       -- a sequence OWNED BY a column moves with its table
       AND NOT (c.relkind = 'S' AND EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.objid = c.oid AND d.deptype = 'a' AND d.classid = 'pg_class'::regclass))
  LOOP
    EXECUTE format(
      'ALTER %s pgboss.%I OWNER TO dpdp_jobs',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      r.relname);
  END LOOP;

  FOR r IN
    SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'pgboss' AND t.typtype IN ('e', 'd', 'c')
       AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)
  LOOP
    EXECUTE format('ALTER TYPE pgboss.%I OWNER TO dpdp_jobs', r.typname);
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'pgboss'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO dpdp_jobs', r.sig);
  END LOOP;
END
$$;

-- 5. Deliberately NO grants on `public` or `app`: dpdp_jobs cannot read or
--    write a single tenant row. (PostgreSQL's default USAGE on schema public
--    lets it see that tables exist, not read them.)

-- Verify (expect: dpdp_jobs owns pgboss; has_table_privilege on a tenant
-- table is false):
--   SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'pgboss';
--   SELECT has_table_privilege('dpdp_jobs', 'public.consent_forms', 'SELECT');
