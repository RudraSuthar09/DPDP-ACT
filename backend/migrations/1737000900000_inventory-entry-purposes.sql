-- Processing purposes + legal basis + retention (FR-INV-05), linked to a Data
-- Inventory register entry, versioned, nothing overwritten.
--
-- DESIGN DECISION (read before touching this file or register.*):
-- Prompt 8 gave `inventory_register_entry_versions` flat `purpose` and
-- `retention_period` columns — one purpose, one retention rule, per data
-- element. That cannot express the real DPDP fact pattern: one data element
-- is routinely collected for SEVERAL purposes, each with its OWN legal basis
-- and its OWN retention clock (e.g. a phone number kept for "fraud
-- prevention" under legitimate use for 3 years, and separately for
-- "marketing" under consent, withdrawable at any time — two different
-- grounds, two different retention rules, one data element).
--
-- We are MIGRATING to a proper one-to-many `inventory_entry_purposes` /
-- `_versions` pair rather than keeping the flat columns as a "primary
-- purpose" convenience alongside it. Keeping both would mean two sources of
-- truth for "why do we hold this" — the flat column and the linked rows can
-- silently disagree, and nothing forces an editor to keep them in sync. For
-- a compliance register, an ambiguous authoritative source is worse than a
-- one-time migration cost. So:
--   * `purpose` / `retention_period` on inventory_register_entry_versions
--     become NULLABLE here and are FROZEN: existing version rows keep
--     whatever value was true when authored (I4 — history is never
--     rewritten), but application code stops WRITING them for new versions
--     from this migration forward. They are read-only historical fields the
--     UI may still show for old versions.
--   * All new purpose/legal-basis/retention data lives here, one row per
--     purpose, many purposes per entry, each independently versioned exactly
--     like the register entry itself (lifecycle table + append-only content
--     table, same split, same rationale, same grants).
--
-- Same Seam S1 pattern throughout: tenant_id defaults to app.current_tenant(),
-- RLS via app.apply_tenant_rls() (SELECT/INSERT/UPDATE only — no DELETE, so a
-- purpose is retired by tombstoning, never removed).

-- Up Migration

ALTER TABLE inventory_register_entry_versions
  ALTER COLUMN purpose DROP NOT NULL,
  ALTER COLUMN retention_period DROP NOT NULL;

COMMENT ON COLUMN inventory_register_entry_versions.purpose IS
  'DEPRECATED (Prompt 14 / FR-INV-05): frozen historical value for versions '
  'created before inventory_entry_purposes existed. New versions leave this '
  'NULL — purposes now live in inventory_entry_purposes (one-to-many, each '
  'with its own legal basis and retention). Never rewritten (I4).';

COMMENT ON COLUMN inventory_register_entry_versions.retention_period IS
  'DEPRECATED (Prompt 14 / FR-INV-05): frozen historical value — see the '
  'purpose column comment. Retention now lives per-purpose on '
  'inventory_entry_purpose_versions.';

CREATE TABLE inventory_entry_purposes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),
  entry_id         uuid NOT NULL REFERENCES inventory_register_entries (id),

  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason text,
  tombstoned_at    timestamptz,
  tombstoned_by    uuid REFERENCES users (id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_entry_purposes IS
  'FR-INV-05: one row per processing purpose attached to a register entry — '
  'lifecycle only (active/tombstoned), same split as inventory_register_entries '
  'vs its _versions table. A data element may have many purposes.';

SELECT app.apply_tenant_rls('public.inventory_entry_purposes');

CREATE INDEX inventory_entry_purposes_entry_idx
  ON inventory_entry_purposes (entry_id, status);

CREATE TABLE inventory_entry_purpose_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  purpose_id        uuid NOT NULL REFERENCES inventory_entry_purposes (id),
  version_number    integer NOT NULL CHECK (version_number > 0),

  -- Why this purpose exists, e.g. "Marketing communications", "Fraud prevention".
  purpose_name      text NOT NULL,
  description       text,

  -- The DPDP ground relied on for this purpose. `other` + legal_basis_note
  -- covers a ground not worth a dedicated enum value in Stage 1.
  legal_basis       text NOT NULL
                      CHECK (legal_basis IN
                        ('consent', 'legitimate_use', 'contract', 'legal_obligation', 'other')),
  legal_basis_note  text,

  -- How long data is kept FOR THIS PURPOSE. Free text, same convention as the
  -- register entry's own (now-deprecated) retention_period field.
  retention_period  text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users (id),

  CONSTRAINT inventory_entry_purpose_versions_unique UNIQUE (purpose_id, version_number)
);

COMMENT ON TABLE inventory_entry_purpose_versions IS
  'Append-only content history for one purpose (FR-INV-05, same I4 pattern as '
  'inventory_register_entry_versions). An edit INSERTs a new row; application '
  'code never UPDATEs or DELETEs an existing one.';

SELECT app.apply_tenant_rls('public.inventory_entry_purpose_versions');

CREATE INDEX inventory_entry_purpose_versions_current_idx
  ON inventory_entry_purpose_versions (purpose_id, version_number DESC);

-- Down Migration

DROP TABLE IF EXISTS inventory_entry_purpose_versions;
DROP TABLE IF EXISTS inventory_entry_purposes;

ALTER TABLE inventory_register_entry_versions
  ALTER COLUMN purpose SET NOT NULL,
  ALTER COLUMN retention_period SET NOT NULL;
