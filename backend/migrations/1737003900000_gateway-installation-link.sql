-- Locked-architecture foundation phase: link an enrolled Gateway device to
-- the Installation it runs inside (Tenant -> Installation -> Gateway ->
-- Gateway Binding -> Data Source). Nullable and purely additive: it changes
-- nothing about the existing enroll/heartbeat/pairing/session flow, the
-- `agent/` package, or the one-active-device-per-tenant rule. A device may
-- be linked to an installation after the fact via
-- PATCH /gateway/devices/:id/installation (staff-only, capability-gated).

-- Up Migration

ALTER TABLE gateway_devices
  ADD COLUMN installation_id uuid REFERENCES installations (id);

COMMENT ON COLUMN gateway_devices.installation_id IS
  'Optional link to the Installation this Gateway device runs inside. Nullable '
  'for backward compatibility with devices enrolled before installations '
  'existed, and because the enroll flow itself is unaffected. When set, the '
  'Gateway''s SaaS/Enterprise profile is DERIVED from installations.deployment_type '
  '(never duplicated onto this table), and heartbeat also touches the '
  'installation''s last_heartbeat_at/version.';

CREATE INDEX gateway_devices_installation_idx ON gateway_devices (installation_id);

-- Down Migration

DROP INDEX IF EXISTS gateway_devices_installation_idx;
ALTER TABLE gateway_devices DROP COLUMN IF EXISTS installation_id;
