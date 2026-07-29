-- Systems/assets register (FR-INV-06): where data lives, as its own entity,
-- linkable to one or more Data Inventory register entries. Same lifecycle +
-- append-only-version split as the register entry itself and its purposes
-- (see 1737000700000 and 1737000900000) — a system's name/type/description is
-- descriptive content a human authors and may revise, so it is versioned; the
-- link from an entry to a system is a plain fact ("this element is stored
-- here") with no content of its own worth versioning, so it is just an
-- append/tombstone row (same precedent as pii_decision fields being mutable in
-- place rather than version-forked: content vs. metadata-about-a-relationship).

-- Up Migration

CREATE TABLE inventory_systems (
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

COMMENT ON TABLE inventory_systems IS
  'FR-INV-06: one row per system/asset that stores or processes data — '
  'lifecycle only (active/tombstoned). Descriptive content lives in '
  'inventory_system_versions.';

SELECT app.apply_tenant_rls('public.inventory_systems');

CREATE INDEX inventory_systems_tenant_status_idx
  ON inventory_systems (tenant_id, status);

CREATE TABLE inventory_system_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  system_id      uuid NOT NULL REFERENCES inventory_systems (id),
  version_number integer NOT NULL CHECK (version_number > 0),

  name           text NOT NULL,
  system_type    text NOT NULL, -- free text, e.g. "database", "SaaS", "file store"
  description    text,
  hosting_location text, -- e.g. "AWS ap-south-1", "on-premise, Mumbai DC"

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users (id),

  CONSTRAINT inventory_system_versions_unique UNIQUE (system_id, version_number)
);

COMMENT ON TABLE inventory_system_versions IS
  'Append-only content history for one system (I4). An edit INSERTs a new '
  'row; application code never UPDATEs or DELETEs an existing one.';

SELECT app.apply_tenant_rls('public.inventory_system_versions');

CREATE INDEX inventory_system_versions_current_idx
  ON inventory_system_versions (system_id, version_number DESC);

-- The link: which register entries live on which systems (many-to-many).
CREATE TABLE inventory_entry_systems (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),
  entry_id         uuid NOT NULL REFERENCES inventory_register_entries (id),
  system_id        uuid NOT NULL REFERENCES inventory_systems (id),

  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason text,
  tombstoned_at    timestamptz,
  tombstoned_by    uuid REFERENCES users (id),

  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users (id)
);

COMMENT ON TABLE inventory_entry_systems IS
  'FR-INV-06/10: links a data element to a system it lives on. A plain '
  'relationship fact — removed by tombstoning, never versioned content.';

SELECT app.apply_tenant_rls('public.inventory_entry_systems');

-- Prevents the same entry/system pair being linked twice while both are active.
CREATE UNIQUE INDEX inventory_entry_systems_active_unique
  ON inventory_entry_systems (entry_id, system_id) WHERE status = 'active';

CREATE INDEX inventory_entry_systems_system_idx
  ON inventory_entry_systems (system_id, status);

-- Down Migration

DROP TABLE IF EXISTS inventory_entry_systems;
DROP TABLE IF EXISTS inventory_system_versions;
DROP TABLE IF EXISTS inventory_systems;
