-- ===========================================================================
-- ONE-TIME provisioning for MANAGED Postgres (Supabase / RDS / Cloud SQL).
--
-- Run ONCE as the database owner/admin. On Supabase: the SQL Editor, which runs
-- as the `postgres` role.
--
-- Why this file exists: on managed Postgres the database is owned by the
-- provider's admin role, so the migration role (dpdp_owner) cannot create
-- schemas, create roles, or issue database-level grants — and it SHOULD NOT be
-- given those powers just to make a migration pass. These are one-time
-- provisioning concerns, not schema-migration concerns. Everything below is the
-- complete set of things the migrations legitimately cannot do for themselves;
-- after this, `pnpm migrate:up` runs cleanly as dpdp_owner with no elevated
-- privileges and without weakening RLS.
--
-- On local Docker/CI none of this is needed: the migration role owns the
-- database and the bootstrap migration does it all itself.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles
--    dpdp_owner : owns the schema objects and runs migrations (DDL only).
--    dpdp_app   : the runtime role the API/worker connect as.
--
--    BOTH are NOSUPERUSER + NOBYPASSRLS. That is not cosmetic: Postgres silently
--    bypasses RLS for superusers, BYPASSRLS roles, and (absent FORCE) the table
--    owner. dpdp_app must be none of those or invariant I3 evaporates.
--    Replace the passwords with strong, unique secrets before running.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dpdp_owner') then
    create role dpdp_owner login password 'REPLACE_WITH_STRONG_SECRET_1'
      nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'dpdp_app') then
    create role dpdp_app login password 'REPLACE_WITH_STRONG_SECRET_2'
      nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

-- Let the admin assign ownership to dpdp_owner (needed for AUTHORIZATION below).
-- No-op if the admin is already a member.
grant dpdp_owner to current_user;

-- ---------------------------------------------------------------------------
-- 2. Database-level grants (only the database owner can make these)
--    NOTE: CONNECT is granted to PUBLIC by default, so this is usually already
--    satisfied — it is here to be explicit and to survive a hardened database
--    where CONNECT has been revoked from PUBLIC.
-- ---------------------------------------------------------------------------
--    The CURRENT database, whatever it is named (Supabase: `postgres`; on RDS
--    usually the database created with the instance, e.g. `dpdp`).
--
--    CREATE on the database for dpdp_owner: needed ONCE, by pg-boss's first
--    install (`node dist/pgboss-install.js` in the migration task). pg-boss
--    issues `CREATE SCHEMA IF NOT EXISTS pgboss`, and PostgreSQL checks this
--    right before checking whether the schema exists — so pre-creating the
--    schema here would not help. (The hosted Supabase database got the same
--    grant from backend/demo/provision-pgboss.js.) Without it the migration
--    task fails with "permission denied for database". After pg-boss is
--    installed and docs/pgboss-least-privilege.sql has handed it to
--    dpdp_jobs, revoke it again:
--      REVOKE CREATE ON DATABASE <db> FROM dpdp_owner;
do $$
begin
  execute format('grant connect on database %I to dpdp_owner, dpdp_app', current_database());
  execute format('grant create on database %I to dpdp_owner', current_database());
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The `app` schema, owned by dpdp_owner.
--    Creating it here (rather than granting CREATE on the whole database to
--    dpdp_owner) is the tighter option: the migration role gets exactly one
--    schema it owns, and no ability to create others.
--    The bootstrap migration detects it already exists and skips creation.
-- ---------------------------------------------------------------------------
create schema if not exists app authorization dpdp_owner;

-- ---------------------------------------------------------------------------
-- 4. The `public` schema is owned by the provider's admin role, so it must
--    grant access to our roles:
--      dpdp_owner needs CREATE to create the tenant tables (migration #2).
--      dpdp_app   needs USAGE to read/write them at runtime.
--    The tables themselves are owned by dpdp_owner, and per-table grants to
--    dpdp_app are issued by app.apply_tenant_rls() inside the migrations.
-- ---------------------------------------------------------------------------
grant usage, create on schema public to dpdp_owner;
grant usage on schema public to dpdp_app;

-- ---------------------------------------------------------------------------
-- 5. Verify. dpdp_app MUST report rolsuper = f AND rolbypassrls = f — if either
--    is true, RLS is void and the cross-tenant isolation suite will (correctly)
--    fail loudly rather than give you a false green.
-- ---------------------------------------------------------------------------
select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
from pg_roles
where rolname in ('postgres', 'dpdp_owner', 'dpdp_app')
order by rolname;

-- Confirm schema ownership: `app` should be owned by dpdp_owner.
select nspname as schema, pg_get_userbyid(nspowner) as owner
from pg_namespace
where nspname in ('app', 'public');
