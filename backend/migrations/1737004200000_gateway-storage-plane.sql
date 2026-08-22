-- Storage data-plane integration — the control-plane primitives that let a
-- browser establish a session with an Enterprise Gateway SCOPED TO A STORAGE
-- ROOT (not a data source). This is a SEPARATE pairing/session mechanism from
-- gateway_pairings/gateway_sessions (Phase 3C), deliberately NOT a shared
-- table with a nullable/XOR column: those tables are already live-tested
-- security-critical infrastructure, and duplicating their (small) shape here
-- is lower-risk than reshaping them. Both mechanisms reuse the SAME device/
-- enrollment infrastructure (gateway_devices) and the SAME hash-only,
-- single-use, short-lived, revocable discipline — this is the same control
-- plane, applied to a second resource kind, not a second security model.
--
-- WHAT THESE TABLES MUST NEVER HOLD: a raw nonce/token (hash only, exactly
-- like gateway_pairings/gateway_sessions), any customer data value, any
-- filesystem path, any credential (I1).

-- Up Migration

CREATE TABLE gateway_storage_pairings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  storage_root_id  uuid NOT NULL REFERENCES storage_roots (id),
  device_id        uuid NOT NULL REFERENCES gateway_devices (id),
  nonce_hash       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  consumed_at      timestamptz
);

COMMENT ON TABLE gateway_storage_pairings IS
  'One-time, expiring pairing nonces bound to {tenant,user,storage_root,'
  'device} — the storage-plane sibling of gateway_pairings. Stores a HASH '
  'only, never the raw nonce.';

SELECT app.apply_tenant_rls('public.gateway_storage_pairings');
CREATE INDEX gateway_storage_pairings_tenant_device_idx ON gateway_storage_pairings (tenant_id, device_id);

-- Tenant-binding guard, same reasoning as storage_roots.gateway_device_id's
-- trigger: a plain FK does NOT apply RLS during its own referential-integrity
-- check, so without this a tenant could mint a pairing referencing ANOTHER
-- tenant's storage root or device. This trigger's own SELECTs run as the
-- invoking (RLS-subject) role, so they are genuinely tenant-scoped.
CREATE OR REPLACE FUNCTION app.check_gateway_storage_pairing_tenant() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage_roots WHERE id = NEW.storage_root_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'storage_root_id % does not belong to this tenant', NEW.storage_root_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gateway_devices WHERE id = NEW.device_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'device_id % does not belong to this tenant', NEW.device_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_storage_pairings_check_tenant
  BEFORE INSERT OR UPDATE OF storage_root_id, device_id ON gateway_storage_pairings
  FOR EACH ROW EXECUTE FUNCTION app.check_gateway_storage_pairing_tenant();

CREATE TABLE gateway_storage_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  user_id          uuid NOT NULL REFERENCES users (id),
  storage_root_id  uuid NOT NULL REFERENCES storage_roots (id),
  device_id        uuid NOT NULL REFERENCES gateway_devices (id),
  pairing_id       uuid REFERENCES gateway_storage_pairings (id),
  token_hash       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);

COMMENT ON TABLE gateway_storage_sessions IS
  'Short-lived, revocable Gateway sessions bound to {tenant,user,storage_root,'
  'device} — the storage-plane sibling of gateway_sessions. Stores a HASH '
  'only, never the raw token.';

SELECT app.apply_tenant_rls('public.gateway_storage_sessions');
CREATE INDEX gateway_storage_sessions_tenant_device_idx ON gateway_storage_sessions (tenant_id, device_id);

CREATE OR REPLACE FUNCTION app.check_gateway_storage_session_tenant() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage_roots WHERE id = NEW.storage_root_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'storage_root_id % does not belong to this tenant', NEW.storage_root_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gateway_devices WHERE id = NEW.device_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'device_id % does not belong to this tenant', NEW.device_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_storage_sessions_check_tenant
  BEFORE INSERT OR UPDATE OF storage_root_id, device_id ON gateway_storage_sessions
  FOR EACH ROW EXECUTE FUNCTION app.check_gateway_storage_session_tenant();

-- Down Migration

DROP TABLE IF EXISTS gateway_storage_sessions;
DROP FUNCTION IF EXISTS app.check_gateway_storage_session_tenant();
DROP TABLE IF EXISTS gateway_storage_pairings;
DROP FUNCTION IF EXISTS app.check_gateway_storage_pairing_tenant();
