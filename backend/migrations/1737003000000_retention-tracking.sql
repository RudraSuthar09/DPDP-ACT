-- Retention tracking (FR-INV / data-lifecycle). The platform SURFACES which
-- pseudonymised subjects hold data past (or approaching) its retention period;
-- it never deletes the client's actual data (I1 — we don't hold it).
--
-- THREE DESIGN DECISIONS, resolved here and documented:
--
-- 1. WHAT STARTS THE CLOCK. A retention clock is (subject_ref + inventory
--    purpose). For a CONSENT-basis purpose the start is the grant's occurred_at
--    (consent_events, Prompt 20) — materialised when a GRANTED event is recorded
--    for a consent purpose LINKED (consent_purpose_inventory_links, Prompt 32) to
--    an inventory purpose. For a LEGAL-OBLIGATION / LEGITIMATE-USE purpose there
--    is no consent event, so the clock has no natural start; a staff member
--    records a COLLECTION DATE for (subject_ref, inventory purpose) instead. Both
--    paths produce the same retention_records row — non-consent data is NOT
--    silently excluded, it just needs its start stated by a human.
--
-- 2. THE PERIOD MUST BE COMPUTABLE. inventory_entry_purpose_versions.retention_period
--    is free text ("8 years from the end of the relevant FY…") — you cannot add
--    it to a date. So a structured, nullable retention_months is added ALONGSIDE
--    it (not replacing the human description). Retention tracking applies only
--    where retention_months is set; the text stays the authoritative prose.
--
-- 3. EXPIRY IS FROZEN (I4). retention_end is computed once, at record creation,
--    from the purpose version in force THEN, and stored. Editing the purpose's
--    retention_months later publishes a new version and does NOT recompute any
--    existing record — exactly like Breach's on-time-closure evidence.

-- Up Migration

-- 1. Structured, computable retention duration (versioned alongside the prose).
ALTER TABLE inventory_entry_purpose_versions ADD COLUMN retention_months integer
  CHECK (retention_months IS NULL OR retention_months > 0);

COMMENT ON COLUMN inventory_entry_purpose_versions.retention_months IS
  'Structured retention period in months, for computing retention_end. Nullable: '
  'the free-text retention_period stays the authoritative description; this is '
  'the machine-computable companion. Versioned — editing it is a new version, '
  'never a rewrite (I4).';

-- 2. The retention register: one clock per (subject_ref, inventory purpose).
CREATE TABLE retention_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL DEFAULT app.current_tenant()
                           REFERENCES organisations (id),

  -- The HMAC'd subject reference — the same pseudonymised id consent uses (I2).
  -- NEVER a raw customer id, name, email or phone.
  subject_ref            text NOT NULL,
  inventory_purpose_id   uuid NOT NULL REFERENCES inventory_entry_purposes (id),
  -- Set for consent-basis records; NULL for manually-recorded collection dates.
  consent_purpose_id     uuid REFERENCES consent_purposes (id),

  basis                  text NOT NULL,          -- the inventory purpose's legal_basis at creation
  source                 text NOT NULL CHECK (source IN ('consent_grant', 'manual_collection')),

  -- The clock. start_at + retention_months_snapshot -> retention_end, all frozen.
  start_at               timestamptz NOT NULL,
  retention_months_snapshot integer NOT NULL CHECK (retention_months_snapshot > 0),
  retention_end          timestamptz NOT NULL,

  -- Review lifecycle (audited transition). 'expired_flagged_at' is set by the
  -- scheduled WorkflowRunner deadline when it fires at retention_end — a durable
  -- marker that the clock ran out, independent of anyone loading the dashboard.
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reviewed')),
  reviewed_by            uuid REFERENCES users (id),
  reviewed_at            timestamptz,
  review_note            text,
  expired_flagged_at     timestamptz,

  created_by             uuid REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE retention_records IS
  'One retention clock per (subject_ref, inventory purpose). retention_end is '
  'FROZEN at creation (I4) — editing the purpose retention later never changes it. '
  'The platform surfaces expiry; it never deletes client data (I1). subject_ref '
  'is the per-tenant HMAC (I2), never a raw id.';

SELECT app.apply_tenant_rls('public.retention_records');

-- One clock per subject+purpose. A re-grant does not start a second clock.
CREATE UNIQUE INDEX retention_records_subject_purpose_uq
  ON retention_records (tenant_id, subject_ref, inventory_purpose_id);
-- The dashboard's two queries: approaching (end soon) and past (end passed).
CREATE INDEX retention_records_end_idx ON retention_records (tenant_id, status, retention_end);

CREATE TRIGGER retention_records_touch_updated_at
  BEFORE UPDATE ON retention_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- 3. Teach the deadline substrate (S3) a fourth kind. Same physics as the other
--    three: a must-not-be-lost, time-bound flag. workflow_jobs.kind gates it.
ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_kind_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_kind_check
  CHECK (kind IN ('breach', 'grievance', 'dprequest', 'retention'));

-- Down Migration

ALTER TABLE workflow_jobs DROP CONSTRAINT IF EXISTS workflow_jobs_kind_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_kind_check
  CHECK (kind IN ('breach', 'grievance', 'dprequest'));
DROP TABLE IF EXISTS retention_records;
ALTER TABLE inventory_entry_purpose_versions DROP COLUMN IF EXISTS retention_months;
