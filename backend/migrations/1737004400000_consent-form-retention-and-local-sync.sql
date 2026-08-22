-- Central DPDP Storage simplification: two small, additive columns.
--
-- 1. consent_forms.retention_months — structured retention config for a
--    consent template, mirroring the existing pattern on
--    inventory_entry_purpose_versions.retention_months (same name/semantics,
--    same nullable+CHECK shape). This phase does NOT wire it into the
--    existing retention engine (retention_records/WorkflowRunner kind
--    'retention') — it only makes the configuration available, per the
--    brief's own instruction not to build a second retention system.
--
-- 2. consent_form_submissions.local_synced_at — the queue marker for the
--    hybrid local-write model: NULL means this submission's consent.json has
--    not yet been written into the client's local Central DPDP Storage (or
--    an optional additional folder). Set once the browser confirms the
--    write. Never file bytes/content — a timestamp only.

-- Up Migration

ALTER TABLE consent_forms
  ADD COLUMN retention_months integer
    CHECK (retention_months IS NULL OR retention_months > 0);

COMMENT ON COLUMN consent_forms.retention_months IS
  'How long (in months) this template''s consent data should be retained in '
  'the client''s local storage. Configuration only -- the platform holds no '
  'file to delete (I1); this is read by the client-side sync/retention UI, '
  'not an automatic deletion engine.';

ALTER TABLE consent_form_submissions
  ADD COLUMN local_synced_at timestamptz;

COMMENT ON COLUMN consent_form_submissions.local_synced_at IS
  'When this submission''s consent record was last written into the '
  'client''s local Central DPDP Storage (and/or its template''s additional '
  'storage folder, if configured). NULL = not yet written -- picked up by '
  'the Storage page''s pending-sync routine. Never file content, a '
  'timestamp only.';

-- Down Migration

ALTER TABLE consent_form_submissions DROP COLUMN IF EXISTS local_synced_at;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS retention_months;
