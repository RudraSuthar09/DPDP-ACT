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

-- Up Migration

CREATE SCHEMA IF NOT EXISTS app;

COMMENT ON SCHEMA app IS
  'Internal helpers for tenant isolation and audit. Not a tenant-facing schema.';

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

-- The least-privilege runtime role the application connects as. Idempotent: if
-- the role already exists (e.g. pre-provisioned in production with a real,
-- rotated secret from Vault), we leave it untouched and only (re)apply grants.
-- The hardcoded password is for LOCAL/CI only — production creates this role
-- out-of-band and this block is skipped.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpdp_app') THEN
    CREATE ROLE dpdp_app LOGIN PASSWORD 'dpdp_app_local_dev_only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO dpdp_app;
GRANT USAGE ON SCHEMA public TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.current_tenant() TO dpdp_app;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dpdp_app', current_database());
END
$$;

-- Reusable helper: turn any table into a tenant-scoped, RLS-enforced table with
-- the ONE standard isolation policy and the standard grants. Every tenant table
-- calls this, so the rule is applied identically everywhere and cannot be
-- forgotten or subtly varied per table. Note: no DELETE grant — nothing is
-- hard-deleted (I4); "deletion" is a soft-delete UPDATE.
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
DROP SCHEMA IF EXISTS app;
-- dpdp_app is intentionally NOT dropped: it may be a shared/managed cluster role
-- and dropping it can fail if it owns objects or is in use elsewhere.
