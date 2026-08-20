-- Locked-architecture foundation phase: LICENSES — the central, server-side
-- enforced entitlement record behind "SaaS vs Enterprise" and "hosted vs
-- client_server". Mirrors gateway_enrollments' established secret-handling
-- pattern exactly: the raw license key is shown to staff ONCE at issuance and
-- is NEVER stored — only its SHA-256 hash (+ a display-only prefix).
--
-- Unlike gateway_enrollments, this needs NO pre-tenant "peephole" resolver:
-- a license is always activated by an ALREADY-AUTHENTICATED staff request
-- (POST /installations, staff JWT + TenantGuard), so the lookup stays
-- ordinary RLS-scoped SQL under the caller's own tenant — there is no
-- chicken-and-egg "which tenant does this belong to" question to answer
-- outside a tenant context (contrast the Gateway enrolment code, which is
-- redeemed by an unauthenticated device that has no tenant yet).
--
-- WHAT THIS TABLE MUST NEVER HOLD: the raw license key, any customer data
-- value, any credential (I1).

-- Up Migration

CREATE TABLE licenses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),

  -- The entitlement itself. An installation may only register with a plan/
  -- deployment_type that EXACTLY matches an active license's (see
  -- InstallationService) — no mixing, no partial grants.
  plan                  text NOT NULL CHECK (plan IN ('saas', 'enterprise')),
  deployment_type       text NOT NULL CHECK (deployment_type IN ('hosted', 'client_server')),

  installation_id       uuid REFERENCES installations (id),

  -- SHA-256 of the raw key. The raw key is returned exactly once, in the
  -- issuance API response, and never stored — same discipline as
  -- gateway_enrollments.code_hash.
  license_key_hash      text NOT NULL,
  license_key_prefix    text NOT NULL,

  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'expired', 'revoked')),

  -- Entitlement overrides layered on top of plan-based feature defaults
  -- (CapabilityService). Empty object = plan defaults apply unmodified.
  features              jsonb NOT NULL DEFAULT '{}'::jsonb,

  issued_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  activated_at          timestamptz,
  activation_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,

  revoked_at            timestamptz,
  revoked_by            uuid REFERENCES users (id),
  revoke_reason         text,

  created_by            uuid NOT NULL REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT licenses_key_hash_unique UNIQUE (license_key_hash)
);

COMMENT ON TABLE licenses IS
  'Central, server-side-enforced license entitlements. Stores the license key '
  'HASH only — never the raw key (I1), same discipline as gateway_enrollments. '
  'An installation may register only with a plan/deployment_type matching an '
  'active license exactly. Tenant-scoped + RLS-forced.';

COMMENT ON COLUMN licenses.features IS
  'Entitlement overrides layered on plan-based feature defaults. Never a '
  'customer data value — feature flags only (e.g. {"databaseConnectors": false}).';

SELECT app.apply_tenant_rls('public.licenses');
CREATE INDEX licenses_tenant_status_idx ON licenses (tenant_id, status);
CREATE TRIGGER licenses_touch_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS licenses;
