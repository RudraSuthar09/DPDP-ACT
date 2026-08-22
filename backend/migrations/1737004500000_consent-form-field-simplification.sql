-- Consent Form builder simplification: replace the Phase 3G-1/3H-1
-- "Customer Data Source / destination / mapped-column / staff-assisted
-- consent" system with a simple, Google-Forms-like field list plus
-- field-LEVEL optional additional local storage (reusing the existing
-- polymorphic storage_mappings table, moduleKey 'consent_form_field' --
-- see shared/src/storage.ts).
--
-- WHAT THIS DOES:
--   1. consent_form_customer_fields loses destination/mapped_column/
--      new_column_name/new_column_type (and their CHECK constraints) --
--      a field is now just label + type + required, nothing else. Gains a
--      CHECK on field_type (defence in depth, mirroring the DTO allowlist).
--   2. consent_forms loses source_id -- a template no longer associates with
--      a Customer Data Source at all.
--   3. storage_mappings.module_key gains 'consent_form_field', alongside the
--      existing 'consent_form' (still valid, simply unused by this UI now --
--      not removed, since removing it would be a breaking narrow for no
--      benefit) and 'data_principal'.
--
-- WHAT THIS DOES NOT TOUCH: data_sources.identity_column/allow_customer_create/
-- writable_columns (backend/migrations/1737003300000, 1737003500000) -- that
-- configuration surface backs the Data Sources module's own admin page, a
-- separate, still-valid capability, not the consent-form-side field system
-- being simplified here.
--
-- Both consent_form_customer_fields and consent_forms.source_id have zero
-- rows/non-null values in the live database as of this migration (verified
-- before writing it) -- there is no data-loss step here, but the DROP COLUMN
-- statements would fail loudly rather than silently discard data if that
-- were ever untrue by the time this runs elsewhere.

-- Up Migration

ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT consent_form_customer_fields_mapping_requires_dest;
ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT consent_form_customer_fields_destination_check;

ALTER TABLE consent_form_customer_fields DROP COLUMN destination;
ALTER TABLE consent_form_customer_fields DROP COLUMN mapped_column;
ALTER TABLE consent_form_customer_fields DROP COLUMN new_column_name;
ALTER TABLE consent_form_customer_fields DROP COLUMN new_column_type;

-- Pre-existing rows may carry a field_type from the old, wider allowlist
-- ('number','date','document_upload','signature','checkbox'), across MANY
-- tenants. Rather than silently truncating data behind a narrower CHECK
-- (I4), map each to its closest surviving type instead of deleting the row:
-- document_upload/signature -> pdf (both were "upload a file" types);
-- number/date/checkbox -> text (still collectible as a plain text value).
--
-- This migration runs as the owner role with NO tenant GUC set, which is
-- RLS-FORCE-bound (no BYPASSRLS) -- a plain UPDATE here would silently touch
-- ZERO rows across every tenant (RLS-filtered), while the CHECK constraint
-- added below is enforced by a full-table DDL rewrite that ignores RLS
-- entirely -- the two would disagree. Lift FORCE for these two statements
-- only, and restore it immediately after, so the fixup actually reaches
-- every tenant's rows the same way the CHECK constraint's own validation will.
ALTER TABLE consent_form_customer_fields NO FORCE ROW LEVEL SECURITY;
UPDATE consent_form_customer_fields
   SET field_type = 'pdf'
 WHERE field_type IN ('document_upload', 'signature');
UPDATE consent_form_customer_fields
   SET field_type = 'text'
 WHERE field_type IN ('number', 'date', 'checkbox');
ALTER TABLE consent_form_customer_fields FORCE ROW LEVEL SECURITY;

ALTER TABLE consent_form_customer_fields ADD CONSTRAINT consent_form_customer_fields_field_type_check
  CHECK (field_type IN ('text', 'pdf', 'excel'));

COMMENT ON TABLE consent_form_customer_fields IS
  'A consent form''s plain field list (Google-Forms-style): label + type '
  '(text/pdf/excel) + required, nothing else. A field''s submitted VALUE '
  'never reaches this table or any other PostgreSQL table -- the browser '
  'writes it directly to Central DPDP Storage, and optionally to this '
  'field''s own additional local folder (storage_mappings, module_key '
  '''consent_form_field'', entity_id = this table''s id). See '
  'shared/src/storage.ts and 1737004100000_storage-configuration.sql.';

ALTER TABLE consent_forms DROP CONSTRAINT consent_forms_source_id_fkey;
ALTER TABLE consent_forms DROP COLUMN source_id;

ALTER TABLE storage_mappings DROP CONSTRAINT storage_mappings_module_key_check;
ALTER TABLE storage_mappings ADD CONSTRAINT storage_mappings_module_key_check
  CHECK (module_key IN ('consent_form', 'data_principal', 'consent_form_field'));

COMMENT ON COLUMN storage_mappings.module_key IS
  'Which DPDP concept owns this mapping: consent_form (a whole template, '
  'legacy/unused by the current UI), data_principal (a customer, identified '
  'by an opaque entity_id), or consent_form_field (ONE form field''s own '
  'optional additional folder, entity_id = consent_form_customer_fields.id) '
  '-- never a name or other personal-data value, I1.';

-- Down Migration

-- Reverting requires no 'consent_form_field' rows to exist, or this fails
-- loudly rather than silently truncating data behind a narrower CHECK.
ALTER TABLE storage_mappings DROP CONSTRAINT storage_mappings_module_key_check;
ALTER TABLE storage_mappings ADD CONSTRAINT storage_mappings_module_key_check
  CHECK (module_key IN ('consent_form', 'data_principal'));

ALTER TABLE consent_forms ADD COLUMN source_id uuid REFERENCES data_sources (id);

ALTER TABLE consent_form_customer_fields DROP CONSTRAINT consent_form_customer_fields_field_type_check;

ALTER TABLE consent_form_customer_fields ADD COLUMN new_column_type text;
ALTER TABLE consent_form_customer_fields ADD COLUMN new_column_name text;
ALTER TABLE consent_form_customer_fields ADD COLUMN mapped_column text;
ALTER TABLE consent_form_customer_fields ADD COLUMN destination text NOT NULL DEFAULT 'consent_record';

ALTER TABLE consent_form_customer_fields ADD CONSTRAINT consent_form_customer_fields_destination_check
  CHECK (destination IN ('consent_record', 'customer_field', 'both'));
ALTER TABLE consent_form_customer_fields ADD CONSTRAINT consent_form_customer_fields_mapping_requires_dest
  CHECK (
    (destination = 'consent_record' AND mapped_column IS NULL AND new_column_name IS NULL)
    OR (destination IN ('customer_field', 'both'))
  );
