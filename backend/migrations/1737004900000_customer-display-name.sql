-- Central DPDP Storage correction: separate CUSTOMER NAME from CUSTOMER
-- IDENTIFIER. Both were being conflated — the identifier field's raw value
-- (e.g. an email) was being used as the filesystem folder's display name,
-- which is wrong for two reasons: (1) an email is not a human-friendly
-- folder name, (2) the client should be able to configure a DIFFERENT field
-- (or the SAME field) as "the thing that names this customer on disk" vs
-- "the thing that resolves/reuses this customer's identity".
--
-- data_principals.display_name is the customer's human-readable name,
-- separate from subject_ref (the deterministic identity hash, I2) and from
-- id (the internal UUID every database mapping uses). It is metadata about
-- an identity the platform already resolved — not a new raw-value store:
-- I1 is about consent FIELD VALUES (Aadhaar, PDF, Excel...) never landing in
-- Postgres; a customer's own chosen display name, explicitly designated by
-- the client as "the field that names this customer", is the same category
-- of thing storage_roots.name or a Grievance ticket's subject line already
-- is — configuration/metadata the platform legitimately holds.
--
-- consent_form_customer_fields.is_customer_name is is_identifier's sibling,
-- same discipline (at most one per form, DB-enforced) — see
-- 1737004600000_consent-form-field-identifier.sql's header.

-- Up Migration

ALTER TABLE data_principals ADD COLUMN display_name text;

COMMENT ON COLUMN data_principals.display_name IS
  'The customer''s human-readable name, from whichever field the client '
  'marked "Use as Customer Name" on the submitted form (may be null if none '
  'configured, or if this customer was only ever resolved server-side '
  'without one — e.g. the Enterprise sweep). Used ONLY for filesystem '
  'folder naming/display — never an identity: subject_ref/id remain the '
  'sole identity. Updated (never blanked by a later null) on every submit.';

ALTER TABLE consent_form_customer_fields
  ADD COLUMN is_customer_name boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consent_form_customer_fields.is_customer_name IS
  'Whether THIS field''s submitted value should become this customer''s '
  'human-readable display name (data_principals.display_name) — used for '
  'filesystem folder naming, never for identity resolution (that is '
  'is_identifier''s job, and may be a different field, or the same one). At '
  'most one per form (see the partial unique index below).';

CREATE UNIQUE INDEX consent_form_customer_fields_one_customer_name_per_form
  ON consent_form_customer_fields (form_id)
  WHERE is_customer_name AND status = 'active';

-- Down Migration

DROP INDEX IF EXISTS consent_form_customer_fields_one_customer_name_per_form;
ALTER TABLE consent_form_customer_fields DROP COLUMN is_customer_name;
ALTER TABLE data_principals DROP COLUMN display_name;
