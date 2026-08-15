-- Phase 3G-1 of the Gateway line of work: let a Consent Form field be
-- configured to eventually correspond to a column in the client's OWN
-- connected customer-data source, alongside the existing consent-purpose rows.
--
-- WHAT THIS MIGRATION IS. Pure CONFIGURATION/METADATA:
--   - which data_source a form is associated with (client-chosen, optional),
--   - the field's label/type/required flag,
--   - its DESTINATION: the consent record, an existing client column (by NAME),
--     or both,
--   - if "create new column" was chosen, the requested name/type — CONFIGURATION
--     ONLY. No ALTER TABLE runs from this table or this migration.
--
-- WHAT THIS MIGRATION IS NOT, spelled out because it is the entire point of I1:
--   NO customer value column. NO submitted-answer-value column. A client column
--   NAME (e.g. "aadhaar_number") is schema metadata, exactly like
--   data_sources.connection_hint — never the Aadhaar number itself.
--   NO automatic mapping — mapped_column/new_column_name are NULL until a human
--   explicitly chooses them (enforced by the DTO layer, not by this schema).
--   NO write/ALTER capability — that is Phase 3G-2, a Gateway-side operation.
--
-- Data Inventory (inventory_register_entries etc.) is UNTOUCHED by this
-- migration and by everything built on it — connecting a data source or mapping
-- a form field must never create/alter a Data Inventory entry.

-- Up Migration

-- 1. A form MAY be associated with one connected data source. Optional and
--    explicit — SaaS tenants with no Gateway/data source leave this NULL and the
--    existing consent-purpose-only forms work exactly as before.
ALTER TABLE consent_forms ADD COLUMN source_id uuid REFERENCES data_sources (id);

COMMENT ON COLUMN consent_forms.source_id IS
  'The client data source this form may map customer-data fields into. NULL for '
  'ordinary SaaS/consent-only forms (unchanged behaviour). Set only when a '
  'client explicitly associates a form with a Gateway-connected source.';

-- 2. Per-source identity configuration: which column identifies "this is the
--    same customer". Explicit, client-chosen, never assumed (not hardcoded to
--    email/mobile). NULL until configured. Reused later by Grievance/DSR/Breach
--    (same source, same identity column — one client customer, many DPDP
--    workflows, never a second customer table per module).
ALTER TABLE data_sources ADD COLUMN identity_column text;

COMMENT ON COLUMN data_sources.identity_column IS
  'The client-chosen column (by NAME, never a value) that identifies a customer '
  'in this source, e.g. "email" or "customer_id". NULL until explicitly '
  'configured. Reusable across Consent/Grievance/DSR/Breach — one identity '
  'concept, not one per DPDP module.';

-- 3. Customer-data fields on a form: coexist with the existing consent_form_rows
--    (which remain the consent-PURPOSE questions, untouched). A customer-data
--    field is a DIFFERENT kind of thing — its destination is configurable.
CREATE TABLE consent_form_customer_fields (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant()
                       REFERENCES organisations (id),
  form_id            uuid NOT NULL REFERENCES consent_forms (id),

  label              text NOT NULL,
  -- A DISPLAY type for the form UI (e.g. 'text', 'document_upload'). Not a
  -- database type — see mapped_column_type/new_column_type below for that.
  field_type         text NOT NULL DEFAULT 'text',
  required           boolean NOT NULL DEFAULT false,

  -- Where the submitted response eventually goes. 'consent_record' means it is
  -- NOT a customer-data field at all (e.g. "I agree to Terms") — kept as an
  -- explicit option here so the builder can represent both kinds of field in
  -- one list; 'customer_field' / 'both' require a resolved destination column.
  destination        text NOT NULL DEFAULT 'consent_record'
                       CHECK (destination IN ('consent_record', 'customer_field', 'both')),

  -- EXISTING-COLUMN mapping: the exact column NAME in the client's source, only
  -- once a human has explicitly selected it. Never auto-populated (enforced by
  -- the DTO/service, not by this CHECK — the schema only records the decision).
  mapped_column      text,

  -- CREATE-NEW-COLUMN configuration (3G-1: configuration only — nothing is
  -- created). Both null until the client picks "create new column" and fills
  -- them in; Phase 3G-2 is the only thing that ever turns this into a write.
  new_column_name    text,
  new_column_type    text,

  display_order      integer NOT NULL DEFAULT 0,
  -- Soft-removed (I4-consistent), same discipline as consent_form_rows.
  status              text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'removed')),

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consent_form_customer_fields_mapping_requires_dest CHECK (
    (destination = 'consent_record' AND mapped_column IS NULL AND new_column_name IS NULL)
    OR (destination IN ('customer_field', 'both'))
  )
);

COMMENT ON TABLE consent_form_customer_fields IS
  'Phase 3G-1: CONFIGURATION for a customer-data form field — label/type/'
  'required + an explicit destination (consent record / an existing client '
  'column BY NAME / both). Never a submitted value. mapped_column and '
  'new_column_name are NULL until a human explicitly chooses them. No ALTER '
  'TABLE or write happens because a row exists here.';
COMMENT ON COLUMN consent_form_customer_fields.mapped_column IS
  'The client column NAME this field maps to, chosen explicitly by staff — '
  'never inferred, never auto-selected. Schema metadata only (like '
  'data_sources.connection_hint), never a customer value.';

SELECT app.apply_tenant_rls('public.consent_form_customer_fields');

CREATE INDEX consent_form_customer_fields_form_idx
  ON consent_form_customer_fields (tenant_id, form_id, display_order);

CREATE TRIGGER consent_form_customer_fields_touch_updated_at
  BEFORE UPDATE ON consent_form_customer_fields
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS consent_form_customer_fields;
ALTER TABLE data_sources DROP COLUMN IF EXISTS identity_column;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS source_id;
