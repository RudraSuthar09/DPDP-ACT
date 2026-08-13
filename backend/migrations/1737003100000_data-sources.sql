-- Phase 1 of the Gateway line of work: the CENTRAL REPRESENTATION of a client's
-- data sources and their access mode. This is METADATA/CONFIGURATION ONLY. It
-- does NOT read, and CANNOT hold, any customer data value — see the refusal list
-- below and I1/§2.1 (the two-mode contract).
--
-- WHY A NEW TABLE (and not inventory_systems). inventory_systems is a VERSIONED
-- RoPA descriptor of "where data lives" (append-only content history, part of
-- the data map). A data source is a different thing with a different lifecycle:
-- a connectable endpoint with a MUTABLE access mode toggled in place. Conflating
-- the two would put a mutable security switch onto a versioned evidence record.
-- So this is its own mutable table, soft-deleted like inventory_systems (no
-- DELETE grant — app.apply_tenant_rls grants only SELECT/INSERT/UPDATE), with
-- the immutable S5 audit chain as the evidence trail for every change (same
-- precedent as pii_decision / consent_form_rows: mutable state + audited change).
--
-- WHAT THIS TABLE MUST NEVER HOLD (read the column list as refusals too):
--   NO customer_data / row_data / raw_value / response_body / payload /
--   customer_record column — Mode B raw values are transient only and never
--   persisted (I1).
--   NO password / api_key / private_key / secret / connection string with
--   credentials — source credentials stay client-side and are designed in the
--   Gateway phase. connection_hint is a NON-SECRET identifier only.
--
-- WHAT MODE B DOES AND DOES NOT MEAN IN PHASE 1. data_access_mode =
-- 'gateway_connected' is ONLY a configuration state: "this source is explicitly
-- permitted to allow future Gateway-based raw access." It grants NOTHING today —
-- there is no Gateway, no connector, no raw-read code path anywhere. Any raw-data
-- operation fails closed because the capability does not exist. See the
-- raw-access guard test in the datasource module.

-- Up Migration

CREATE TABLE data_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant()
                          REFERENCES organisations (id),

  name                  text NOT NULL,

  -- The KIND of source, metadata only in Phase 1 (no connector implements any of
  -- these yet). The safe-first order is excel/csv/filesystem, then the databases.
  source_kind           text NOT NULL CHECK (source_kind IN (
                          'excel', 'csv', 'filesystem',
                          'postgresql', 'mysql', 'sqlserver'
                        )),

  -- The two-mode access control (I1/§2.1). PER SOURCE. Defaults closed. Enabling
  -- 'gateway_connected' is an explicit, privileged, audited operation — it is
  -- never set implicitly at creation.
  data_access_mode      text NOT NULL DEFAULT 'metadata_only'
                          CHECK (data_access_mode IN ('metadata_only', 'gateway_connected')),

  -- Lifecycle. Soft-delete only (I4) — there is no DELETE grant on this table.
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'tombstoned')),

  -- A NON-SECRET, human-readable identifier so a user can tell sources apart
  -- (e.g. "Finance shared drive", "billing DB host billing.internal:5432/app").
  -- MUST NOT contain a credential or a connection string with a secret; the DTO
  -- rejects obvious secret patterns, and nothing in the code treats this as a
  -- connection string.
  connection_hint       text,

  -- A NULLABLE, NON-SECRET reference for a future Gateway enrolment binding
  -- (e.g. an enrolment id). Unused in Phase 1. Never a secret.
  gateway_binding_ref   text,

  -- Attribution for the security-sensitive mode toggle (in addition to the S5
  -- audit entry, which is the authoritative record).
  mode_last_changed_at  timestamptz,
  mode_last_changed_by  uuid REFERENCES users (id),

  tombstone_reason      text,
  tombstoned_at         timestamptz,
  tombstoned_by         uuid REFERENCES users (id),

  created_by            uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE data_sources IS
  'Central metadata for a client data source and its per-source access mode '
  '(I1/§2.1). Metadata/config ONLY — never a customer value, never a secret. '
  'metadata_only by default; gateway_connected is opt-in and grants no raw '
  'access in Phase 1 (fail closed). Mutable + soft-deleted; the S5 audit chain '
  'is the evidence trail.';
COMMENT ON COLUMN data_sources.data_access_mode IS
  'metadata_only (default) | gateway_connected. Per source, not per tenant. '
  'gateway_connected is a configuration state only until the Gateway exists.';
COMMENT ON COLUMN data_sources.connection_hint IS
  'Non-secret human identifier only. NEVER a password/credential/connection '
  'string with a secret.';

SELECT app.apply_tenant_rls('public.data_sources');

CREATE INDEX data_sources_tenant_status_idx ON data_sources (tenant_id, status);
CREATE INDEX data_sources_tenant_mode_idx ON data_sources (tenant_id, data_access_mode, status);

CREATE TRIGGER data_sources_touch_updated_at
  BEFORE UPDATE ON data_sources
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS data_sources;
