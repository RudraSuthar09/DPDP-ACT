-- License hardening (locked architecture §9/§10 follow-up). Two additive,
-- purely constraint-level changes -- no table redesign, no new tables, no
-- rename of tenant_id/organisations. Both were verified against the live
-- central database before being written: neither currently rejects any
-- existing row (checked via the authoritative DDL-level probe -- CREATE INDEX/
-- ADD CONSTRAINT physically scan the table heap and are NOT filtered by RLS,
-- unlike a plain SELECT under the least-privilege dpdp_owner role, which is
-- itself FORCE-RLS'd and would give a false "no conflicts" if trusted blindly).
--
-- 1. ONE ACTIVE LICENSE PER TENANT (hardening). The application already only
--    ever reads "the" active license (LicensingRepository.findActiveForTenant,
--    ORDER BY activated_at DESC LIMIT 1) and only ever activates a `pending`
--    license (LicensingRepository.activate, WHERE status = 'pending' -- this
--    migration does not touch that method or weaken its race-safety). This
--    partial unique index makes the invariant the app already relies on a
--    fact about the database, the same way `apply_tenant_rls` makes tenant
--    isolation a fact rather than a convention.
--
-- 2. LICENSE/INSTALLATION TENANT CONSISTENCY (hardening). licenses.tenant_id
--    and licenses.installation_id -> installations.id already exist, but
--    nothing structurally guaranteed licenses.tenant_id = installations.tenant_id
--    for the referenced row. A composite FK against a composite UNIQUE (id,
--    tenant_id) on installations is the standard Postgres pattern for this --
--    smaller and safer than introducing a trigger or redesigning either table.
--    installation_id stays nullable (a `pending` license has none yet); MATCH
--    SIMPLE (the default) means the composite FK is simply not checked while
--    installation_id IS NULL, exactly like the plain FK it replaces.

-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. One active license per tenant.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX licenses_one_active_per_tenant
  ON licenses (tenant_id)
  WHERE status = 'active';

COMMENT ON INDEX licenses_one_active_per_tenant IS
  'Hardening: a tenant may have at most one ACTIVE license at a time (older/'
  'revoked/expired-status licenses are unaffected -- only status = ''active'' '
  'rows are constrained). Matches the invariant LicensingRepository already '
  'assumed; now enforced by the engine, not just by which row the app happens '
  'to pick.';

-- ---------------------------------------------------------------------------
-- 2. License/installation tenant consistency.
-- ---------------------------------------------------------------------------

-- The referenced side of a composite FK must be backed by a UNIQUE (or PK)
-- constraint on exactly those columns. installations.id is already the PK
-- (and therefore already unique on its own); this adds tenant_id alongside it
-- without changing the PK or removing the existing single-column uniqueness.
ALTER TABLE installations
  ADD CONSTRAINT installations_id_tenant_id_unique UNIQUE (id, tenant_id);

-- Replace the single-column FK (installation_id -> installations.id) with a
-- composite one that also pins tenant_id. Strictly stronger than what it
-- replaces: every (installation_id) value it previously accepted is still
-- accepted, with the added requirement that the referenced installation's
-- tenant_id matches the license's own tenant_id.
ALTER TABLE licenses
  DROP CONSTRAINT licenses_installation_id_fkey;

ALTER TABLE licenses
  ADD CONSTRAINT licenses_installation_tenant_consistency
    FOREIGN KEY (installation_id, tenant_id) REFERENCES installations (id, tenant_id);

COMMENT ON CONSTRAINT licenses_installation_tenant_consistency ON licenses IS
  'Hardening: a license can only reference an installation belonging to the '
  'SAME tenant (composite FK against installations (id, tenant_id)). Replaces '
  'the plain installation_id -> installations.id FK, which did not assert '
  'tenant consistency. NULL installation_id (a pending license) is still '
  'allowed -- MATCH SIMPLE does not check a composite FK while any column is '
  'NULL, same as before.';

-- Down Migration

ALTER TABLE licenses
  DROP CONSTRAINT IF EXISTS licenses_installation_tenant_consistency;

ALTER TABLE licenses
  ADD CONSTRAINT licenses_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES installations (id);

ALTER TABLE installations
  DROP CONSTRAINT IF EXISTS installations_id_tenant_id_unique;

DROP INDEX IF EXISTS licenses_one_active_per_tenant;
