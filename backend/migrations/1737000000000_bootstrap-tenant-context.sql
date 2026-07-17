-- Bootstrap migration — Seam S1 (tenant context). Establishes the primitives
-- every future table's Row-Level Security policy depends on. NO business tables
-- here; those arrive in later migrations, each RLS-enabled from birth.
--
-- The pattern:
--   * The app connects as a least-privilege role (dpdp_app) that is NOT the
--     table owner and is NOSUPERUSER NOBYPASSRLS, so RLS is ALWAYS enforced
--     against it. (A superuser or the table owner would silently bypass RLS —
--     which is exactly why the app must never connect as either.)
--   * On every unit of work the app opens a transaction and sets the
--     `app.current_tenant` GUC (from the JWT tenant claim) as the first
--     statement. Every RLS policy filters on app.current_tenant().
--   * A forgotten WHERE clause, a SQL injection, or an unset GUC still returns
--     zero cross-tenant rows (I3) — the GUC is NULL, and `tenant_id = NULL` is
--     never true, so the table fails closed.
--
-- PORTABILITY (local Docker/CI vs managed Postgres):
--   On local Docker/CI the migration role owns the database, so it can create
--   the schema, the role, and database-level grants itself. On MANAGED Postgres
--   (Supabase/RDS/Cloud SQL) the database is owned by the provider's admin role
--   and the migration role (dpdp_owner) legitimately cannot do those things.
--   Rather than escalate the migration role, every cluster/database-level step
--   below is GATED on an explicit privilege check and skipped with a NOTICE when
--   it must be provisioned out-of-band. See docs/managed-postgres-setup.sql.

-- Up Migration

-- 1. The `app` schema --------------------------------------------------------
-- CREATE SCHEMA requires CREATE on the *database*. Note that PostgreSQL performs
-- that privilege check BEFORE the IF NOT EXISTS short-circuit, so a bare
-- `CREATE SCHEMA IF NOT EXISTS app` errors on managed Postgres even when the
-- schema already exists. Hence the gate.
DO $$
BEGIN
  IF has_database_privilege(current_user, current_database(), 'CREATE') THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS app';
  ELSIF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    RAISE NOTICE
      'Schema "app" exists; % has no CREATE on database % — skipping creation (expected on managed Postgres).',
      current_user, current_database();
  ELSE
    RAISE EXCEPTION
      'Schema "app" is missing and role % cannot CREATE on database %. Provision it once as the database owner: CREATE SCHEMA app AUTHORIZATION %; -- see docs/managed-postgres-setup.sql',
      current_user, current_database(), current_user;
  END IF;

  -- COMMENT requires ownership of the schema; skip quietly if we don't own it.
  IF EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'app' AND nspowner = current_user::regrole
  ) THEN
    EXECUTE 'COMMENT ON SCHEMA app IS ''Internal helpers for tenant isolation and audit. Not a tenant-facing schema.''';
  END IF;
END
$$;

-- 2. The tenant GUC reader ---------------------------------------------------
-- Returns the tenant bound to the current DB session, or NULL if unset.
-- The `true` arg to current_setting means "missing_ok": no error if unset.
CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid;
$$;

COMMENT ON FUNCTION app.current_tenant() IS
  'Tenant id for the current session (from the app.current_tenant GUC). Every '
  'RLS policy filters on this. See Seam S1 and invariant I3.';

-- 3. The least-privilege runtime role ---------------------------------------
-- Idempotent: if dpdp_app already exists (pre-provisioned on managed Postgres
-- with a real, rotated secret from Vault) we leave it untouched. The hardcoded
-- password is for LOCAL/CI only and is never applied to an existing role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpdp_app') THEN
    RAISE NOTICE 'Role dpdp_app already exists — left untouched (credentials managed out-of-band).';
  ELSIF (SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE $ddl$
      CREATE ROLE dpdp_app LOGIN PASSWORD 'dpdp_app_local_dev_only'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
    $ddl$;
    RAISE NOTICE 'Created role dpdp_app with the LOCAL/CI dev password. NEVER use this on a managed database.';
  ELSE
    RAISE EXCEPTION
      'Role dpdp_app does not exist and role % cannot create roles. Provision it once as the database admin — see docs/managed-postgres-setup.sql',
      current_user;
  END IF;
END
$$;

-- 4. Grants we own outright (schema `app` belongs to the migration role) -----
GRANT USAGE ON SCHEMA app TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.current_tenant() TO dpdp_app;

-- 5. Grants owned by the DATABASE owner --------------------------------------
-- Attempting these without grant option is a silent no-op (PostgreSQL emits
-- "no privileges were granted" rather than an error), which is worse than
-- useless: it looks like it worked. Gate them and say so out loud instead.
DO $$
BEGIN
  IF has_database_privilege(current_user, current_database(), 'CONNECT WITH GRANT OPTION') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO dpdp_app', current_database());
  ELSE
    RAISE NOTICE
      'Skipping GRANT CONNECT ON DATABASE % — % holds no grant option. Provision out-of-band (docs/managed-postgres-setup.sql).',
      current_database(), current_user;
  END IF;

  IF has_schema_privilege(current_user, 'public', 'USAGE WITH GRANT OPTION') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO dpdp_app';
  ELSE
    RAISE NOTICE
      'Skipping GRANT USAGE ON SCHEMA public — % holds no grant option. Provision out-of-band (docs/managed-postgres-setup.sql).',
      current_user;
  END IF;
END
$$;

-- 6. The reusable RLS helper -------------------------------------------------
-- Turn any table into a tenant-scoped, RLS-enforced table with the ONE standard
-- isolation policy and the standard grants. Every tenant table calls this, so
-- the rule is applied identically everywhere and cannot be forgotten or subtly
-- varied per table. Note: no DELETE grant — nothing is hard-deleted (I4);
-- "deletion" is a soft-delete UPDATE.
CREATE OR REPLACE FUNCTION app.apply_tenant_rls(target regclass) RETURNS void
  LANGUAGE plpgsql
AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  -- FORCE so even the table owner is subject to the policy (defense in depth
  -- against ever running app queries as the owner).
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s '
    'USING (tenant_id = app.current_tenant()) '
    'WITH CHECK (tenant_id = app.current_tenant())',
    target
  );
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO dpdp_app', target);
END
$fn$;

COMMENT ON FUNCTION app.apply_tenant_rls(regclass) IS
  'Enables + forces RLS, installs the standard tenant_isolation policy, and '
  'grants SELECT/INSERT/UPDATE to dpdp_app on a table. Every tenant-scoped '
  'table MUST call this. See Seam S1 / invariant I3.';

-- Down Migration

DROP FUNCTION IF EXISTS app.apply_tenant_rls(regclass);
DROP FUNCTION IF EXISTS app.current_tenant();

-- Only drop the schema if this role could recreate it on the way back up.
-- On managed Postgres it was provisioned out-of-band, so leave it alone.
DO $$
BEGIN
  IF has_database_privilege(current_user, current_database(), 'CREATE') THEN
    EXECUTE 'DROP SCHEMA IF EXISTS app';
  ELSE
    RAISE NOTICE
      'Leaving schema "app" in place — it was provisioned out-of-band and % could not recreate it.',
      current_user;
  END IF;
END
$$;
-- dpdp_app is intentionally NOT dropped: it may be a shared/managed cluster role
-- and dropping it can fail if it owns objects or is in use elsewhere.
