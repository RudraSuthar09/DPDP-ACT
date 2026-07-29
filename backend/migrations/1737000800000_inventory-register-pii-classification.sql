-- PII classification for the Data Inventory register (FR-INV-03/04): a
-- rule/dictionary suggestion (category + confidence) that a human must
-- explicitly accept or reject. Never auto-applied — these columns start (and
-- can return to, on reject) a state where nothing has been decided.
--
-- Lives on inventory_register_entries (lifecycle), not on
-- inventory_register_entry_versions (content history): a classification
-- decision is compliance metadata ABOUT the entry's current content, not new
-- descriptive content itself, so it follows the same "mutable in place, never
-- version-forked" precedent as `status`/`tombstone_reason` on this same
-- table — deciding a classification does not create a new version.

-- Up Migration

ALTER TABLE inventory_register_entries
  ADD COLUMN pii_category         text,
  ADD COLUMN pii_confidence       text
                                    CHECK (pii_confidence IN ('high', 'medium', 'low')),
  ADD COLUMN pii_decision         text NOT NULL DEFAULT 'undecided'
                                    CHECK (pii_decision IN ('undecided', 'accepted', 'rejected')),
  ADD COLUMN pii_decision_reason  text,
  ADD COLUMN pii_decided_at       timestamptz,
  ADD COLUMN pii_decided_by       uuid REFERENCES users (id);

COMMENT ON COLUMN inventory_register_entries.pii_category IS
  'The classification a human acted on — set on BOTH accept and reject (so a '
  'rejected suggestion stays visible as "this is what was rejected, and why"). '
  'Only meaningful as a confirmed classification when pii_decision = accepted.';

COMMENT ON COLUMN inventory_register_entries.pii_decision IS
  'undecided (no suggestion has been acted on yet) -> accepted | rejected. '
  'The suggestion itself is never auto-applied — this column is null/undecided '
  'until a human (owner/dpo/compliance_officer) explicitly acts on it.';

-- No new grant/RLS work needed: apply_tenant_rls() already granted dpdp_app
-- SELECT/INSERT/UPDATE on this table (Prompt 8) and these are ordinary
-- columns on an existing RLS-protected row.

-- Down Migration

ALTER TABLE inventory_register_entries
  DROP COLUMN IF EXISTS pii_decided_by,
  DROP COLUMN IF EXISTS pii_decided_at,
  DROP COLUMN IF EXISTS pii_decision_reason,
  DROP COLUMN IF EXISTS pii_decision,
  DROP COLUMN IF EXISTS pii_confidence,
  DROP COLUMN IF EXISTS pii_category;
