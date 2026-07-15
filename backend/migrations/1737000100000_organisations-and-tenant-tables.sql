-- The Organisation (tenant root) plus two trivial tenant-scoped tables that
-- prove the Seam S1 pattern end to end. Every table:
--   * carries a `tenant_id`,
--   * defaults `tenant_id` to app.current_tenant() so app code never has to
--     pass it (and cannot forge it — RLS WITH CHECK verifies it anyway),
--   * is made RLS-enforced by the single helper app.apply_tenant_rls().
--
-- These are deliberately minimal (id, tenant_id, name, timestamps). Real module
-- tables land in later migrations; this migration exists to demonstrate — and
-- to let the cross-tenant isolation suite verify — that isolation is enforced by
-- the engine, not by application WHERE clauses.

-- Up Migration

-- The tenant. A row's tenant is itself: tenant_id = id. This keeps the uniform
-- "every table has tenant_id and the same policy" invariant true even for the
-- root, so app.apply_tenant_rls() works here identically to child tables.
CREATE TABLE organisations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant(),
  name       text NOT NULL,
  tier       text NOT NULL DEFAULT 'standard'
               CHECK (tier IN ('standard', 'premium', 'enterprise')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organisations_tenant_is_self CHECK (tenant_id = id)
);

COMMENT ON TABLE organisations IS
  'The tenant (Data Fiduciary workspace). tenant_id = id. Every other tenant '
  'table references tenant_id here. Sign-up mints a new id, sets the GUC to it, '
  'and inserts the row under that tenant context — no privileged path required.';

SELECT app.apply_tenant_rls('public.organisations');

-- Trivial tenant-scoped table #1.
CREATE TABLE inventory_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant()
               REFERENCES organisations (id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT app.apply_tenant_rls('public.inventory_categories');

-- Trivial tenant-scoped table #2 (a second table proves the helper generalises).
CREATE TABLE consent_purposes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant()
               REFERENCES organisations (id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

SELECT app.apply_tenant_rls('public.consent_purposes');

-- Down Migration

DROP TABLE IF EXISTS consent_purposes;
DROP TABLE IF EXISTS inventory_categories;
DROP TABLE IF EXISTS organisations;
