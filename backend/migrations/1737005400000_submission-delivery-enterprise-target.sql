-- Enterprise per-field consent delivery: route a delivery-queue row to the
-- storage location it is for.
--
-- A consent-form field whose Additional Storage mapping points at a folder
-- under a Gateway-provider storage root ('gateway', i.e. a folder the
-- Gateway administrator explicitly authorized for writing) gets an
-- Enterprise COPY of its submitted value. That copy rides the EXISTING
-- delivery queue — the same encrypted payload, the same claim/ack/fail
-- lifecycle, the same nulling of the payload on delivery — in its own row,
-- one per destination storage root, so each destination succeeds, retries,
-- or fails independently of Central DPDP Storage and of each other.
--
-- WHY A COLUMN (the only schema change): the claim must hand a row only to a
-- device that can perform it (a Central write, or a write into one
-- particular authorized location). That target is not secret — it is a
-- storage_roots id, the same kind of reference storage_mappings already
-- holds in clear — and putting it inside the ciphertext would mean
-- decrypting rows just to decide who may claim them. NULL = the existing
-- Central DPDP Storage delivery, so every existing row keeps its meaning.
--
-- WHAT THIS DOES NOT CHANGE: no field value is added in clear anywhere; the
-- payload stays AES-256-GCM ciphertext, nulled on ack (see 1737005000000).

-- Up Migration

ALTER TABLE consent_form_submission_deliveries
  ADD COLUMN target_storage_root_id uuid REFERENCES storage_roots (id);

COMMENT ON COLUMN consent_form_submission_deliveries.target_storage_root_id IS
  'NULL = the Central DPDP Storage delivery (unchanged). Otherwise the '
  'Gateway-provider storage root this row is an Enterprise copy for: only '
  'the Gateway device bound to that root may claim it.';

-- A plain FK does not apply RLS during its referential-integrity check (the
-- same Postgres behaviour storage_roots/gateway_storage_pairings guard
-- against): refuse a target root belonging to another tenant at the
-- database, not only in the service that stages the row.
CREATE OR REPLACE FUNCTION app.check_delivery_target_root_tenant() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_storage_root_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM storage_roots
       WHERE id = NEW.target_storage_root_id AND tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'target_storage_root_id % does not belong to this tenant', NEW.target_storage_root_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consent_form_submission_deliveries_check_target_tenant
  BEFORE INSERT OR UPDATE OF target_storage_root_id ON consent_form_submission_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.check_delivery_target_root_tenant();

CREATE INDEX consent_form_submission_deliveries_target_idx
  ON consent_form_submission_deliveries (tenant_id, target_storage_root_id, status);

-- Down Migration

DROP INDEX IF EXISTS consent_form_submission_deliveries_target_idx;
DROP TRIGGER IF EXISTS consent_form_submission_deliveries_check_target_tenant ON consent_form_submission_deliveries;
DROP FUNCTION IF EXISTS app.check_delivery_target_root_tenant();
ALTER TABLE consent_form_submission_deliveries DROP COLUMN IF EXISTS target_storage_root_id;
