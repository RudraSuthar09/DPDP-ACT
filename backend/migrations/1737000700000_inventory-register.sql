-- Data Inventory Register (FR-INV-01/08): guided-form entry of data elements
-- (what is collected, why, where stored, how long retained), with full version
-- history. Distinct from `inventory_data_elements` (Seam S4 discovery output —
-- structural facts a SchemaSource found: schema/table/column/type). This
-- register is the compliance-facing description a human authors and edits.
--
-- Two tables, same split as identity's users/status vs. a hypothetical version
-- log: `inventory_register_entries` is lifecycle only (active/tombstoned);
-- `inventory_register_entry_versions` is the append-only content history. An
-- edit INSERTs a new version row — it never UPDATEs or DELETEs a prior one
-- (FR-INV-08, I4). The "current" version of an entry is simply the row with
-- MAX(version_number) for its entry_id.
--
-- Both tables follow the ordinary Seam S1 pattern: tenant_id defaulting to
-- app.current_tenant(), RLS via app.apply_tenant_rls() (which grants dpdp_app
-- exactly SELECT/INSERT/UPDATE — never DELETE, so even a hard delete of a
-- version row is unexpressible at runtime, just like users.status). Stage 1
-- keeps version immutability to "application code never issues UPDATE/DELETE
-- against the versions table" rather than revoking those grants outright — the
-- stricter SECURITY DEFINER lockdown used for consent_events/workflow_jobs
-- (R3) is deferred to a later hardening pass, same as the rest of this module.

-- Up Migration

CREATE TABLE inventory_register_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),

  -- Never hard-deleted (I4): active -> tombstoned, exactly like users.status.
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason text,
  tombstoned_at    timestamptz,
  tombstoned_by    uuid REFERENCES users (id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_register_entries IS
  'FR-INV-01/08: one row per data element declared through the guided form. '
  'All descriptive content lives in inventory_register_entry_versions; this '
  'row is lifecycle only (active/tombstoned). Never hard-deleted (I4).';

SELECT app.apply_tenant_rls('public.inventory_register_entries');

CREATE INDEX inventory_register_entries_tenant_status_idx
  ON inventory_register_entries (tenant_id, status);

CREATE TABLE inventory_register_entry_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  entry_id          uuid NOT NULL REFERENCES inventory_register_entries (id),
  version_number    integer NOT NULL CHECK (version_number > 0),

  -- What's collected. Category/description only — NEVER a customer record (I1).
  category          text NOT NULL,
  description       text,
  -- Why it's collected.
  purpose           text NOT NULL,
  -- Where it's stored.
  storage_location  text NOT NULL,
  -- How long it's retained. Free text in Stage 1 — FR-INV-05 turns this into a
  -- versioned, linked retention rule later; today it is a fact on the form.
  retention_period  text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users (id),

  CONSTRAINT inventory_register_entry_versions_unique UNIQUE (entry_id, version_number)
);

COMMENT ON TABLE inventory_register_entry_versions IS
  'FR-INV-08: full version history for the register. An edit INSERTs a new '
  'row; application code never UPDATEs or DELETEs an existing one. The '
  'current version of an entry is the row with MAX(version_number) for its '
  'entry_id.';

SELECT app.apply_tenant_rls('public.inventory_register_entry_versions');

-- Serves "latest version per entry" (the register list) and the full-history
-- read (one entry, all versions, newest first).
CREATE INDEX inventory_register_entry_versions_current_idx
  ON inventory_register_entry_versions (entry_id, version_number DESC);

-- Down Migration

DROP TABLE IF EXISTS inventory_register_entry_versions;
DROP TABLE IF EXISTS inventory_register_entries;
