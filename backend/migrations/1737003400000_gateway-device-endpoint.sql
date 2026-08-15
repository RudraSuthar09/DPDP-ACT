-- Phase 3G-2.5: the missing piece of Phase 3C's Gateway control plane — WHERE
-- the browser reaches an already-enrolled Gateway. Phase 3C persisted the
-- Gateway's SECURITY IDENTITY (gateway_devices: public key, status, platform)
-- but never the browser-facing network address, so the browser had nowhere to
-- remember "connect to this Gateway" across a page refresh/re-login.
--
-- WHAT endpoint IS: a plain http(s) URL the CLIENT explicitly configures (e.g.
-- http://192.168.1.50:7071). It is NOT a secret and NOT the security identity —
-- the device's enrolled public key + its `gateway_device` token remain the only
-- things that authenticate it. This column only saves the client a re-typing
-- step; nothing about tenant isolation or device trust depends on it.
--
-- PRODUCT DECISION (explicit, not inferred): ONE TENANT -> ONE ENTERPRISE
-- GATEWAY for this version. Enforced by a PARTIAL UNIQUE INDEX on active
-- devices — the database is the backstop; the service layer gives a friendly
-- error before ever reaching it (same "app-level check + DB constraint"
-- discipline as consent_form_rows_form_purpose_uq). Replacing a Gateway is an
-- EXPLICIT client action (revoke the old device, enroll a new one) — never
-- silent replacement.

-- Up Migration

ALTER TABLE gateway_devices ADD COLUMN endpoint text;

COMMENT ON COLUMN gateway_devices.endpoint IS
  'The client-configured http(s) URL the BROWSER uses to reach this already-'
  'enrolled Gateway (e.g. http://192.168.1.50:7071). Non-secret, not the '
  'security identity — set/changed explicitly by staff, independent of '
  'enrollment/device-token/session security, which are unaffected by this value.';

-- ONE active Gateway per tenant, enforced at the database, not just in code.
CREATE UNIQUE INDEX gateway_devices_one_active_per_tenant_uq
  ON gateway_devices (tenant_id)
  WHERE status = 'active';

-- Down Migration

DROP INDEX IF EXISTS gateway_devices_one_active_per_tenant_uq;
ALTER TABLE gateway_devices DROP COLUMN IF EXISTS endpoint;
