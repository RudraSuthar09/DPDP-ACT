-- Phase 3C of the Gateway line of work: the CENTRAL CONTROL PLANE for the
-- Enterprise Local Gateway. This is the outbound-HTTPS relationship
--
--     Customer Enterprise installation  --outbound HTTPS-->  our Azure  -->  central PG
--
-- that lets the platform identify which TENANT, which DATA SOURCE, and which
-- enrolled DEVICE a Gateway belongs to — WITHOUT ever holding customer data or a
-- device private key.
--
-- WHAT THESE TABLES MUST NEVER HOLD (read the column lists as refusals too):
--   NO private key, NO device secret, NO database password/credential, NO
--   connection string with a secret, NO customer data value of any kind (I1).
--   Central PG stores only the device PUBLIC key, non-secret metadata, and the
--   HASHES of one-time codes / session tokens (never the codes/tokens themselves).
--
-- AUTH MODEL (reuses existing platform primitives — no second auth architecture):
--   * Enrolment code  — one-time, expiring; issued by staff (normal JWT), redeemed
--     once by the Gateway. Resolved pre-tenant via app.resolve_gateway_enrollment()
--     (the SECURITY DEFINER peephole below), exactly like app.resolve_login /
--     app.resolve_public_api_key.
--   * Device token    — a `gateway_device` JWT (typ), signed by the platform
--     secret, carrying tenant_id. It authenticates subsequent device calls; its
--     tenant claim binds the RLS GUC. Device revocation is a status check here.
--   * Pairing nonce   — one-time, expiring, {tenant,user,source,device}-bound.
--   * Session         — short-lived, revocable, {tenant,user,source,device}-bound.
-- All four tables are tenant-scoped + RLS-forced (app.apply_tenant_rls), so a
-- forgotten WHERE still returns zero cross-tenant rows (I3).

-- Up Migration

-- ---------------------------------------------------------------------------
-- Enrolled devices. PUBLIC key + non-secret metadata only.
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),

  -- The device's PUBLIC key (PEM). Non-secret identity material. The matching
  -- PRIVATE key is generated on and never leaves the Enterprise machine — there
  -- is deliberately no column for it, here or anywhere.
  public_key         text NOT NULL,
  -- An optional, non-secret device-provided reference (e.g. a hostname label).
  device_ref         text,

  platform           text NOT NULL CHECK (platform IN ('windows', 'linux')),
  agent_version      text NOT NULL,
  display_name       text NOT NULL,

  -- Lifecycle. Revoked/removed devices fail closed on every control call.
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked', 'removed')),

  enrolled_by        uuid REFERENCES users (id),
  enrolled_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at  timestamptz,
  revoked_at         timestamptz,
  revoked_by         uuid REFERENCES users (id),
  revoke_reason      text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gateway_devices IS
  'Enrolled Local Gateway devices. PUBLIC key + non-secret metadata ONLY — never '
  'a private key, a credential, or a customer value (I1). Revoked/removed fail '
  'closed. Tenant-scoped + RLS-forced.';

SELECT app.apply_tenant_rls('public.gateway_devices');
CREATE INDEX gateway_devices_tenant_status_idx ON gateway_devices (tenant_id, status);
CREATE TRIGGER gateway_devices_touch_updated_at
  BEFORE UPDATE ON gateway_devices
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- One-time enrolment codes. Only the HASH is stored (like consent_api_keys).
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_enrollments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),

  -- SHA-256 of the raw code. The raw code is shown to staff exactly once and
  -- never stored — this table can only confirm "does this hash match".
  code_hash          text NOT NULL,
  code_prefix        text NOT NULL,
  label              text,

  created_by         uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  consumed_device_id uuid REFERENCES gateway_devices (id),

  CONSTRAINT gateway_enrollments_code_hash_unique UNIQUE (code_hash)
);

COMMENT ON TABLE gateway_enrollments IS
  'One-time, expiring Gateway enrolment codes. Stores the code HASH only. '
  'Resolvable pre-tenant via app.resolve_gateway_enrollment(), same shape as '
  'app.resolve_public_api_key().';

SELECT app.apply_tenant_rls('public.gateway_enrollments');

-- ---------------------------------------------------------------------------
-- One-time pairing nonces. {tenant,user,source,device}-bound. HASH only.
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_pairings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  source_id    uuid NOT NULL REFERENCES data_sources (id),
  device_id    uuid NOT NULL REFERENCES gateway_devices (id),

  nonce_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,

  CONSTRAINT gateway_pairings_nonce_hash_unique UNIQUE (nonce_hash)
);

COMMENT ON TABLE gateway_pairings IS
  'One-time, expiring pairing nonces bound to {tenant,user,source,device}. Stores '
  'the nonce HASH only. Redeemed by the device via /gateway/pair/redeem.';

SELECT app.apply_tenant_rls('public.gateway_pairings');
CREATE INDEX gateway_pairings_tenant_device_idx ON gateway_pairings (tenant_id, device_id);

-- ---------------------------------------------------------------------------
-- Short-lived sessions. {tenant,user,source,device}-bound. HASH only.
-- ---------------------------------------------------------------------------
CREATE TABLE gateway_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  source_id    uuid NOT NULL REFERENCES data_sources (id),
  device_id    uuid NOT NULL REFERENCES gateway_devices (id),
  pairing_id   uuid REFERENCES gateway_pairings (id),

  token_hash   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,

  CONSTRAINT gateway_sessions_token_hash_unique UNIQUE (token_hash)
);

COMMENT ON TABLE gateway_sessions IS
  'Short-lived, revocable Gateway sessions bound to {tenant,user,source,device}. '
  'Stores the session-token HASH only — never the token, never customer data.';

SELECT app.apply_tenant_rls('public.gateway_sessions');
CREATE INDEX gateway_sessions_tenant_device_idx ON gateway_sessions (tenant_id, device_id);

-- ---------------------------------------------------------------------------
-- The enrolment peephole: code_hash -> (tenant_id, enrollment_id, created_by,
-- expires_at, consumed_at). Same shape/reasoning as app.api_key_directory /
-- app.resolve_public_api_key: because gateway_enrollments is FORCE RLS, even a
-- SECURITY DEFINER reading it directly (as owner) would see zero rows with no
-- tenant GUC set — so we read an un-RLS'd shadow table synced by trigger.
-- dpdp_app is granted NO privileges on the directory; the only way through is the
-- SECURITY DEFINER resolver, exact-hash match, minimal columns, no listing.
-- ---------------------------------------------------------------------------
CREATE TABLE app.gateway_enrollment_directory (
  code_hash      text PRIMARY KEY,
  enrollment_id  uuid NOT NULL,
  tenant_id      uuid NOT NULL,
  created_by     uuid NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.gateway_enrollment_directory IS
  'code_hash -> (tenant_id, enrollment_id, created_by, expires_at, consumed_at). '
  'NOT row-level-secured and NOT granted to dpdp_app: reachable only via '
  'app.resolve_gateway_enrollment(). Maintained by trigger from '
  'public.gateway_enrollments.';

-- NO GRANTS TO dpdp_app ON THIS TABLE. That omission is the security control.

CREATE FUNCTION app.sync_gateway_enrollment_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.gateway_enrollment_directory
      (code_hash, enrollment_id, tenant_id, created_by, expires_at, consumed_at)
    VALUES (NEW.code_hash, NEW.id, NEW.tenant_id, NEW.created_by, NEW.expires_at, NEW.consumed_at);
  ELSE
    UPDATE app.gateway_enrollment_directory
       SET consumed_at = NEW.consumed_at, updated_at = now()
     WHERE enrollment_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app.sync_gateway_enrollment_directory() IS
  'Maintains app.gateway_enrollment_directory from public.gateway_enrollments. '
  'SECURITY DEFINER because dpdp_app cannot touch the directory directly.';

CREATE TRIGGER gateway_enrollments_sync_directory
  AFTER INSERT OR UPDATE ON gateway_enrollments
  FOR EACH ROW EXECUTE FUNCTION app.sync_gateway_enrollment_directory();

CREATE FUNCTION app.resolve_gateway_enrollment(p_code_hash text)
  RETURNS TABLE (tenant_id uuid, enrollment_id uuid, created_by uuid, expires_at timestamptz, consumed_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.enrollment_id, d.created_by, d.expires_at, d.consumed_at
  FROM app.gateway_enrollment_directory d
  WHERE d.code_hash = p_code_hash;
$fn$;

COMMENT ON FUNCTION app.resolve_gateway_enrollment(text) IS
  'The Gateway enrolment peephole: exact code hash -> (tenant_id, enrollment_id, '
  'created_by, expires_at, consumed_at). Mirrors app.resolve_public_api_key(). '
  'Expiry/consumption are checked by the caller, not filtered here.';

REVOKE ALL ON FUNCTION app.sync_gateway_enrollment_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_gateway_enrollment(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_gateway_enrollment(text) TO dpdp_app;

-- Down Migration

DROP TRIGGER IF EXISTS gateway_enrollments_sync_directory ON gateway_enrollments;
DROP FUNCTION IF EXISTS app.resolve_gateway_enrollment(text);
DROP FUNCTION IF EXISTS app.sync_gateway_enrollment_directory();
DROP TABLE IF EXISTS app.gateway_enrollment_directory;
DROP TABLE IF EXISTS gateway_sessions;
DROP TABLE IF EXISTS gateway_pairings;
DROP TABLE IF EXISTS gateway_enrollments;
DROP TABLE IF EXISTS gateway_devices;
