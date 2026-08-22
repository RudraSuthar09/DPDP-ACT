-- Locked-architecture foundation phase: STORAGE & FOLDER MAPPING.
--
-- The central platform is the CONTROL PLANE for where a tenant's compliance
-- artefacts live — never the place they live. This migration adds a generic,
-- tenant-scoped hierarchy: Storage Root -> Folder -> Module Mapping. It works
-- identically for SaaS (a client-selected local root, provider='local') and
-- Enterprise (a root reached through an already-enrolled Gateway device,
-- provider='gateway') without assuming any particular downstream storage
-- technology (filesystem, object storage, etc. all fit the same shape later).
--
-- WHAT THESE TABLES MUST NEVER HOLD (read the column list as refusals too):
--   NO customer_data / document_content / file_bytes / row_data column —
--   these tables record WHERE something is filed, never WHAT is in it (I1).
--   NO password / api_key / secret / connection string with credentials —
--   `root_path` is a non-secret path/reference, exactly like
--   data_sources.connection_hint; the Gateway/desktop app resolves it locally.
--
-- WHY NOT REUSE data_sources. A data_source is a READABLE structured endpoint
-- (a table/file DataConnector can query). A storage root is a WRITE
-- destination for DPDP-generated/collected artefacts (e.g. where a consent
-- form's evidence gets filed) — a different concept with a different shape
-- (it has folders under it; a data source does not). Conflating them would
-- force every data source to grow a folder tree it has no use for.
--
-- WHY module_key + entity_id (no cross-module foreign key). This module must
-- stay reusable by Consent Register today and Data Inventory/DSR/Grievance/
-- Breach later without a schema change or a new table each time (R2: no
-- module reaches into another module's tables). `entity_id` is validated by
-- the OWNING module's own service before it ever calls this API — the storage
-- module itself has no knowledge of what a "consent form" is.
--
-- WHY NO DELETE GRANT. app.apply_tenant_rls grants only SELECT/INSERT/UPDATE
-- (same as every other tenant table, I4) — every "delete" here is a status
-- flip, evidenced by updated_at and (for roots/folders) a tombstone reason.

-- Up Migration

-- 1. Storage Root -------------------------------------------------------------
-- The top-level location a tenant configures once (e.g. "DPDP" on a local
-- disk, or on Enterprise storage reached through a Gateway). A tenant may
-- configure more than one (e.g. one per Gateway), each independent.
CREATE TABLE storage_roots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant()
                        REFERENCES organisations (id),

  name                text NOT NULL,

  -- 'local'   — SaaS: a client-selected local/desktop storage location. No
  --             Gateway involved; gateway_device_id must be NULL.
  -- 'gateway' — Enterprise: reached through an already-enrolled Gateway
  --             device (gateway_devices, Phase 3C/3G-2.5). gateway_device_id
  --             is required. Future providers (e.g. object storage) extend
  --             this list without changing the shape of folders/mappings.
  provider            text NOT NULL DEFAULT 'local'
                        CHECK (provider IN ('local', 'gateway')),

  gateway_device_id   uuid REFERENCES gateway_devices (id),

  -- A NON-SECRET path/reference the local desktop app or Gateway resolves on
  -- its own side (e.g. "D:\DPDP" or "C:\CompanyData\DPDP"). The central
  -- platform never reads or writes anything at this path — it only remembers
  -- the client's own choice so they are not asked again. MUST NOT contain a
  -- credential; nothing here is a connection string.
  root_path           text,

  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason    text,
  tombstoned_at       timestamptz,
  tombstoned_by       uuid REFERENCES users (id),

  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT storage_roots_provider_binding CHECK (
    (provider = 'gateway' AND gateway_device_id IS NOT NULL)
    OR (provider = 'local' AND gateway_device_id IS NULL)
  )
);

COMMENT ON TABLE storage_roots IS
  'Central, persistent record of a tenant''s configured storage location(s) — '
  'CONFIGURATION ONLY, never a customer data value. local = SaaS client-'
  'selected storage; gateway = Enterprise storage reached through an already-'
  'enrolled Gateway device. Tenant-scoped + RLS-forced.';
COMMENT ON COLUMN storage_roots.root_path IS
  'Non-secret path/reference resolved locally by the desktop app or Gateway. '
  'Never a credential or connection string.';

SELECT app.apply_tenant_rls('public.storage_roots');

CREATE INDEX storage_roots_tenant_status_idx ON storage_roots (tenant_id, status);
CREATE INDEX storage_roots_gateway_device_idx ON storage_roots (gateway_device_id);
-- One active root per name per tenant — a client-hygiene guard, not a
-- security control (unlike gateway_devices' one-active-device index).
CREATE UNIQUE INDEX storage_roots_tenant_name_active_uq
  ON storage_roots (tenant_id, name) WHERE status = 'active';

CREATE TRIGGER storage_roots_touch_updated_at
  BEFORE UPDATE ON storage_roots
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Tenant-binding guard for gateway_device_id. A plain foreign key does NOT
-- apply RLS during its own referential-integrity check (a documented
-- Postgres limitation) — without this trigger, a tenant could bind a storage
-- root to ANOTHER tenant's Gateway device simply by guessing/observing its
-- id, even though every other cross-tenant read is blocked by RLS. This
-- trigger runs as the invoking (RLS-subject) role, so its own SELECT against
-- gateway_devices is tenant-scoped exactly like any ordinary app query: a
-- foreign device id is indistinguishable from a nonexistent one. This is the
-- database-level backstop behind the equivalent check the application
-- service performs first (I3: enforced by the database, not app code alone).
CREATE OR REPLACE FUNCTION app.check_storage_root_gateway_device_tenant() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.gateway_device_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM gateway_devices
       WHERE id = NEW.gateway_device_id AND tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION 'gateway_device_id % does not belong to this tenant', NEW.gateway_device_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.check_storage_root_gateway_device_tenant() IS
  'Rejects binding a storage root to a Gateway device belonging to a '
  'different tenant. A plain FK does not apply RLS during its own '
  'referential-integrity check, so this trigger is the actual enforcement — '
  'not a redundant nicety. See the migration header and Seam S1/I3.';

CREATE TRIGGER storage_roots_check_gateway_device_tenant
  BEFORE INSERT OR UPDATE OF gateway_device_id ON storage_roots
  FOR EACH ROW EXECUTE FUNCTION app.check_storage_root_gateway_device_tenant();

-- 2. Storage Folder -------------------------------------------------------------
-- A VIRTUAL folder the client explicitly created or selected under a root
-- (self-referencing for nesting, e.g. Customers / Consent). This table is the
-- logical structure the client chose to see in the browser; it does not
-- perform any real filesystem/object-storage I/O (that is a later, separate
-- capability layered on the existing Gateway data plane, deliberately out of
-- scope here — see the master doc's Gateway phases).
CREATE TABLE storage_folders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant()
                        REFERENCES organisations (id),
  storage_root_id     uuid NOT NULL REFERENCES storage_roots (id),
  parent_folder_id    uuid REFERENCES storage_folders (id),

  name                text NOT NULL,

  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'tombstoned')),
  tombstone_reason    text,
  tombstoned_at       timestamptz,
  tombstoned_by       uuid REFERENCES users (id),

  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE storage_folders IS
  'A VIRTUAL folder in a tenant''s configured storage hierarchy — structural '
  'metadata only (name + parent), never a file or a customer data value. '
  'Self-referencing for nesting. Tenant-scoped + RLS-forced.';

SELECT app.apply_tenant_rls('public.storage_folders');

CREATE INDEX storage_folders_tenant_root_idx ON storage_folders (tenant_id, storage_root_id, status);
CREATE INDEX storage_folders_parent_idx ON storage_folders (parent_folder_id);
-- No two active sibling folders may share a name under the same parent (or,
-- for top-level folders, under the same root). NULLS are not distinct for
-- uniqueness purposes by default, so parent_folder_id is coalesced to a fixed
-- sentinel — this is the standard workaround, not a real folder id.
CREATE UNIQUE INDEX storage_folders_sibling_name_active_uq
  ON storage_folders (
    tenant_id,
    storage_root_id,
    COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
  )
  WHERE status = 'active';

CREATE TRIGGER storage_folders_touch_updated_at
  BEFORE UPDATE ON storage_folders
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- 3. Storage Mapping ------------------------------------------------------------
-- Which folder a DPDP module/template stores its artefacts in. Generic and
-- polymorphic on purpose (module_key + entity_id, no FK into the owning
-- module's table — see the header). Mutable: "change the mapping" is an
-- UPDATE of folder_id on the same row, so a client never ends up with two
-- simultaneous active mappings for the same entity.
CREATE TABLE storage_mappings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL DEFAULT app.current_tenant()
                        REFERENCES organisations (id),

  -- The allowlist of DPDP concepts that may own a mapping. Extend this list
  -- (a one-line migration) when a future module needs one — Consent Register
  -- is the only wired-up caller today.
  module_key          text NOT NULL CHECK (module_key IN ('consent_form')),
  -- The owning module's own primary key for the thing being mapped (e.g.
  -- consent_forms.id). Never dereferenced or validated by this table/module —
  -- that is the owning module's job (R2).
  entity_id           uuid NOT NULL,

  folder_id           uuid NOT NULL REFERENCES storage_folders (id),

  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive')),

  created_by          uuid REFERENCES users (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- At most one mapping row per (module, entity) — "remap" updates folder_id
  -- in place instead of creating a second row.
  CONSTRAINT storage_mappings_module_entity_uq UNIQUE (tenant_id, module_key, entity_id)
);

COMMENT ON TABLE storage_mappings IS
  'Which storage folder a DPDP module/template (by module_key + its own '
  'entity_id) files its artefacts into. Never automatically inferred — always '
  'the result of an explicit client choice (see storage.service.ts). Tenant-'
  'scoped + RLS-forced.';

SELECT app.apply_tenant_rls('public.storage_mappings');

CREATE INDEX storage_mappings_folder_idx ON storage_mappings (folder_id);

CREATE TRIGGER storage_mappings_touch_updated_at
  BEFORE UPDATE ON storage_mappings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS storage_mappings;
DROP TABLE IF EXISTS storage_folders;
DROP TABLE IF EXISTS storage_roots;
DROP FUNCTION IF EXISTS app.check_storage_root_gateway_device_tenant();
