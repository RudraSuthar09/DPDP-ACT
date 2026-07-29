-- Third-party processor/vendor register (FR-INV-07): who else receives this
-- data, as its own entity, linkable to Data Inventory register entries. Same
-- lifecycle + version split as inventory_systems (1737001000000) — see that
-- migration's header for the versioned-entity-vs-plain-link rationale, which
-- applies identically here.

-- Up Migration

CREATE TABLE inventory_vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),

  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason text,
  tombstoned_at    timestamptz,
  tombstoned_by    uuid REFERENCES users (id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE inventory_vendors IS
  'FR-INV-07: one row per third-party processor/vendor who receives data — '
  'lifecycle only. Descriptive content lives in inventory_vendor_versions.';

SELECT app.apply_tenant_rls('public.inventory_vendors');

CREATE INDEX inventory_vendors_tenant_status_idx
  ON inventory_vendors (tenant_id, status);

CREATE TABLE inventory_vendor_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  vendor_id         uuid NOT NULL REFERENCES inventory_vendors (id),
  version_number    integer NOT NULL CHECK (version_number > 0),

  name              text NOT NULL,
  description       text,
  contact_email     text,
  -- Reference to the executed Data Processing Agreement, if any — a pointer
  -- (a filename, an external doc id), never the agreement itself (I1 concerns
  -- don't apply, but this platform still stores metadata, not documents).
  dpa_reference     text,
  country           text, -- relevant to cross-border transfer questions under DPDP

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users (id),

  CONSTRAINT inventory_vendor_versions_unique UNIQUE (vendor_id, version_number)
);

COMMENT ON TABLE inventory_vendor_versions IS
  'Append-only content history for one vendor (I4). An edit INSERTs a new '
  'row; application code never UPDATEs or DELETEs an existing one.';

SELECT app.apply_tenant_rls('public.inventory_vendor_versions');

CREATE INDEX inventory_vendor_versions_current_idx
  ON inventory_vendor_versions (vendor_id, version_number DESC);

-- The link: which register entries are shared with which vendors (many-to-many).
CREATE TABLE inventory_entry_vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),
  entry_id         uuid NOT NULL REFERENCES inventory_register_entries (id),
  vendor_id        uuid NOT NULL REFERENCES inventory_vendors (id),

  -- Optional context on the transfer itself, e.g. "SCC executed", "processed
  -- for payment settlement only". Mutable in place (a link attribute, not
  -- primary content) — same precedent as pii_decision_reason.
  transfer_notes   text,

  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason text,
  tombstoned_at    timestamptz,
  tombstoned_by    uuid REFERENCES users (id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id)
);

COMMENT ON TABLE inventory_entry_vendors IS
  'FR-INV-07/10: links a data element to a vendor who receives it (the '
  '"recipient" in elements -> purposes -> recipients). A relationship fact — '
  'removed by tombstoning, never versioned content.';

SELECT app.apply_tenant_rls('public.inventory_entry_vendors');

CREATE UNIQUE INDEX inventory_entry_vendors_active_unique
  ON inventory_entry_vendors (entry_id, vendor_id) WHERE status = 'active';

CREATE INDEX inventory_entry_vendors_vendor_idx
  ON inventory_entry_vendors (vendor_id, status);

-- Down Migration

DROP TABLE IF EXISTS inventory_entry_vendors;
DROP TABLE IF EXISTS inventory_vendor_versions;
DROP TABLE IF EXISTS inventory_vendors;
