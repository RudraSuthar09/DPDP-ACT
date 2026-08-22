-- Central DPDP Storage customer-centric correction: the public consent form
-- no longer hardcodes Name/Email/Phone (the client configures every field,
-- Google-Forms-style — see shared/src/consent.ts). Something still has to
-- supply the raw value SubjectRefHasher pseudonymises into subject_ref (I2)
-- and lets the platform recognise a repeat submission from the same
-- customer (section 2 of the brief) — so the client now marks ONE of their
-- own fields "Use as Customer Identifier", generalising what a hardcoded
-- email/phone field did before to any field shape (Student ID, Account
-- Number, ...). Configuration only: a boolean flag, never a value.

-- Up Migration

ALTER TABLE consent_form_customer_fields
  ADD COLUMN is_identifier boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consent_form_customer_fields.is_identifier IS
  'Whether THIS field''s submitted value is the raw identity hashed into '
  'subject_ref (I2) and used to resolve/reuse the customer''s Central DPDP '
  'Storage folder (storage_mappings, module_key ''data_principal''). At '
  'most one per form (see the partial unique index below). If no field is '
  'marked, each submission is treated as a new, unrelated customer -- '
  'correct behaviour, not an error.';

-- At most one identifier field per form — DB-enforced, not just UI
-- discipline, mirroring every other "exactly one" rule in this schema.
CREATE UNIQUE INDEX consent_form_customer_fields_one_identifier_per_form
  ON consent_form_customer_fields (form_id)
  WHERE is_identifier AND status = 'active';

-- Down Migration

DROP INDEX IF EXISTS consent_form_customer_fields_one_identifier_per_form;
ALTER TABLE consent_form_customer_fields DROP COLUMN is_identifier;
