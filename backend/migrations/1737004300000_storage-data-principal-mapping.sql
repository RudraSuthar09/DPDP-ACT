-- Customer Storage foundation follow-up: extend storage_mappings.module_key
-- to allow a customer/data-principal association, per shared/src/storage.ts's
-- own documented extension mechanism ("a one-line migration + this array").
--
-- WHAT THIS DOES: widens ONE CHECK constraint. No new table, no new column,
-- no change to storage_roots/storage_folders, no change to the Gateway-
-- storage tables. entity_id for module_key = 'data_principal' MUST be an
-- opaque reference the client controls -- this migration does not, and
-- cannot, enforce that at the database level (entity_id is or has always
-- been a bare uuid with no FK, by design -- R2, polymorphic mapping); it is
-- documented at the type level (shared/src/storage.ts) and in the frontend
-- copy. This table has never stored, and still never stores, a customer's
-- name or any other personal-data value -- only ids/hashes/references.

-- Up Migration

ALTER TABLE storage_mappings DROP CONSTRAINT storage_mappings_module_key_check;
ALTER TABLE storage_mappings ADD CONSTRAINT storage_mappings_module_key_check
  CHECK (module_key IN ('consent_form', 'data_principal'));

COMMENT ON COLUMN storage_mappings.module_key IS
  'Which DPDP concept owns this mapping: consent_form (a consent template) '
  'or data_principal (a customer, identified by an opaque entity_id the '
  'client controls -- never a name or other personal-data value, I1).';

-- Down Migration

-- Reverting requires no 'data_principal' rows to exist, or this fails loudly
-- rather than silently truncating data behind a narrower CHECK.
ALTER TABLE storage_mappings DROP CONSTRAINT storage_mappings_module_key_check;
ALTER TABLE storage_mappings ADD CONSTRAINT storage_mappings_module_key_check
  CHECK (module_key IN ('consent_form'));
