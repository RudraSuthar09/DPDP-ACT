-- Consent-form FILE UPLOAD fields: a general "File upload" field type, with
-- the three things a form owner needs to configure about it (which kinds of
-- file, how big, and what to tell the respondent).
--
-- This EXTENDS the existing field list; it does not replace it. Before this
-- migration the builder already had two upload types, 'pdf' and 'excel',
-- whose own name was the whole configuration: one hard-wired content type,
-- no size cap beyond the relay's own limits, no instructions. Live forms use
-- them, so they stay exactly as they are and keep working; 'file' is the type
-- new fields get, and the only one with the columns below.
--
-- WHERE THE BYTES GO IS UNCHANGED. An upload still travels through
-- consent_form_submission_deliveries (1737005000000) as one AES-256-GCM
-- payload, nulled on acknowledgement, and is written by the tenant's own
-- Gateway into a folder its administrator authorized for writing. This
-- migration adds no new store, no new path and no new exception to I1: a
-- file's BYTES never rest in this database, and these columns are
-- CONFIGURATION about a field, not anything a respondent submitted.
--
-- max_file_bytes is bounded in the schema as well as in the DTO
-- (shared/src/consent-uploads.ts: UPLOAD_MIN_BYTES ..
-- UPLOAD_MAX_BYTES_CEILING). The ceiling is not a preference: the bytes ride
-- through one encrypted row, so an unbounded cap would let a single
-- submission turn a transit buffer into a file store.

-- Up Migration

ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT consent_form_customer_fields_field_type_check;
ALTER TABLE consent_form_customer_fields
  ADD CONSTRAINT consent_form_customer_fields_field_type_check
  CHECK (field_type IN ('text', 'file', 'pdf', 'excel'));

ALTER TABLE consent_form_customer_fields ADD COLUMN description text;
ALTER TABLE consent_form_customer_fields ADD COLUMN allowed_file_kinds text;
ALTER TABLE consent_form_customer_fields ADD COLUMN max_file_bytes integer;

COMMENT ON COLUMN consent_form_customer_fields.description IS
  'Optional instructions shown under this field''s label on the public form '
  '(e.g. "Both sides, in one PDF"). Client-authored plain text — never '
  'generated, and never a respondent value.';
COMMENT ON COLUMN consent_form_customer_fields.allowed_file_kinds IS
  'For field_type = ''file'': which kinds of file this field accepts — '
  '''image'', ''pdf'' or ''image_pdf''. A COARSE choice on purpose: the form '
  'owner picks photos, PDFs or both, and never edits a content-type '
  'allowlist, so no configuration path can widen a field into accepting an '
  'executable. The authoritative per-type check is on the bytes themselves '
  '(shared/src/consent-uploads.ts: inspectUpload). NULL for every other '
  'field type.';
COMMENT ON COLUMN consent_form_customer_fields.max_file_bytes IS
  'For field_type = ''file'': this field''s size cap in bytes. NULL for '
  'every other field type.';

-- Both upload columns belong to an upload field and to no other kind, and a
-- 'file' field is not configured until it has them. Enforced here as well as
-- in the DTO so a direct API call cannot leave a field in a state the public
-- form would have to guess about.
ALTER TABLE consent_form_customer_fields
  ADD CONSTRAINT consent_form_customer_fields_file_config_check
  CHECK (
    (field_type = 'file'
       AND allowed_file_kinds IN ('image', 'pdf', 'image_pdf')
       AND max_file_bytes IS NOT NULL)
    OR
    (field_type <> 'file'
       AND allowed_file_kinds IS NULL
       AND max_file_bytes IS NULL)
  );

-- The schema's own half of the bound in consent-uploads.ts. A mismatch
-- between the two is a bug, but this is the one that cannot be bypassed.
ALTER TABLE consent_form_customer_fields
  ADD CONSTRAINT consent_form_customer_fields_max_file_bytes_range_check
  CHECK (max_file_bytes IS NULL OR (max_file_bytes >= 1024 AND max_file_bytes <= 26214400));

-- Down Migration

-- IF EXISTS on the drops, like 1737005400000's down, so a partially-applied or
-- hand-repaired schema still rolls back cleanly.
ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT IF EXISTS consent_form_customer_fields_max_file_bytes_range_check;
ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT IF EXISTS consent_form_customer_fields_file_config_check;

-- A 'file' field cannot be represented once its configuration columns are
-- gone. Map each to the closest surviving upload type rather than deleting
-- the field and silently changing what a live form collects (same discipline
-- as 1737004500000's own down-migration note): a PDF-only field becomes
-- 'pdf'; anything that accepted images becomes 'pdf' as well, since that was
-- the only general upload type before this migration. This loses the
-- allowed-kinds and size configuration, which is exactly what rolling back
-- this migration means.
ALTER TABLE consent_form_customer_fields NO FORCE ROW LEVEL SECURITY;
UPDATE consent_form_customer_fields SET field_type = 'pdf' WHERE field_type = 'file';
ALTER TABLE consent_form_customer_fields FORCE ROW LEVEL SECURITY;

ALTER TABLE consent_form_customer_fields DROP COLUMN IF EXISTS max_file_bytes;
ALTER TABLE consent_form_customer_fields DROP COLUMN IF EXISTS allowed_file_kinds;
ALTER TABLE consent_form_customer_fields DROP COLUMN IF EXISTS description;

ALTER TABLE consent_form_customer_fields
  DROP CONSTRAINT IF EXISTS consent_form_customer_fields_field_type_check;
ALTER TABLE consent_form_customer_fields
  ADD CONSTRAINT consent_form_customer_fields_field_type_check
  CHECK (field_type IN ('text', 'pdf', 'excel'));
