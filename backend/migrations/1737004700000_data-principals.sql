-- Fixes a real runtime bug: `GET /storage/mappings?moduleKey=data_principal&
-- entityId=<64-char subject_ref>` fails with "invalid input syntax for type
-- uuid" because storage_mappings.entity_id is (correctly) uuid, and nothing
-- has ever backed the 'data_principal' moduleKey with a real UUID identity —
-- frontend/src/lib/central-storage.ts's resolveCustomerFolder was passing
-- subject_ref (the existing, correct, EXTERNAL/deterministic HMAC identifier,
-- SubjectRefHasher, I2) straight through as if it were already an INTERNAL
-- UUID. Those are two different things and must stay two different things.
--
-- This migration adds the missing piece: a small, tenant-scoped customer/
-- data-principal REGISTRY. subject_ref is unchanged (still computed the same
-- way, still never reversible by the platform) — it is now the durable KEY
-- this table resolves to a stable internal customer_id (this table's own
-- `id`), which is what storage_mappings.entity_id (moduleKey='data_principal')
-- actually uses from now on. Same identity every time the same subject_ref
-- resolves (INSERT ... ON CONFLICT DO UPDATE ... RETURNING id) — the SAME
-- customer submitting twice always gets the SAME customer_id, and two
-- different customers (different subject_ref, even with the same display
-- name) always get different ones.
--
-- Deliberately generic (not consent-specific): any future module
-- (Grievance/DSR/Breach/Data Inventory) resolves the SAME customer_id from
-- the SAME subject_ref through this one table — never a second, competing
-- identity mechanism per module (see backend/src/modules/data-principal/).

-- Up Migration

CREATE TABLE data_principals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant()
                REFERENCES organisations (id),

  -- The SAME per-tenant HMAC-SHA256 hex digest SubjectRefHasher already
  -- produces everywhere else (consent_events.subject_ref,
  -- consent_form_submissions.subject_ref, retention_records.subject_ref) —
  -- never a raw customer value, never reversible by the platform (I2). This
  -- table does not compute it; it only remembers "we've seen this ref
  -- before, here is its stable internal id."
  subject_ref text NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT data_principals_tenant_subject_uq UNIQUE (tenant_id, subject_ref)
);

COMMENT ON TABLE data_principals IS
  'The internal customer/data-principal identity registry: resolves the '
  'existing external subject_ref (SubjectRefHasher, I2) to a stable internal '
  'UUID (this table''s id) — the identity storage_mappings.entity_id uses '
  'for moduleKey=''data_principal''. Never a name, email, or any other raw '
  'value; subject_ref itself is already an irreversible HMAC. One row per '
  '(tenant, subject_ref) — resolved via upsert, never duplicated.';

SELECT app.apply_tenant_rls('public.data_principals');

CREATE INDEX data_principals_tenant_subject_idx ON data_principals (tenant_id, subject_ref);

CREATE TRIGGER data_principals_touch_updated_at
  BEFORE UPDATE ON data_principals
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS data_principals;
