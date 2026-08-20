-- Locked-architecture foundation phase: INSTALLATIONS.
--
-- Separates "a concrete deployed/running instance of DPDP" from both the
-- commercial Plan (organisations.plan) and the Gateway device that runs
-- inside it (gateway_devices, linked in migration 1737003900000). Today one
-- Gateway device *is* the de facto installation (DB-enforced one-active-
-- device-per-tenant); this table gives that concept its own identity so a
-- future installation can exist independently of any single Gateway device,
-- and so plan/deployment_type can be validated against a LICENSE at
-- registration time rather than merely displayed (see 1737003800000).
--
-- WHAT THIS TABLE MUST NEVER HOLD: any customer data value, any credential,
-- any secret connection string (I1). `environment_metadata` is descriptive
-- installation metadata ONLY (os/platform/hostname-hash/etc) — never a
-- customer record.

-- Up Migration

CREATE TABLE installations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),

  -- Snapshots what this installation was licensed for at registration time
  -- (validated against a license — see InstallationService). organisations.
  -- plan/deployment_type remain the descriptive commercial defaults; this is
  -- the entitlement actually granted to THIS running instance.
  plan                  text NOT NULL CHECK (plan IN ('saas', 'enterprise')),
  deployment_type       text NOT NULL CHECK (deployment_type IN ('hosted', 'client_server')),

  version               text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'inactive', 'decommissioned')),

  -- Non-secret installation metadata only — never a customer data value.
  environment_metadata  jsonb NOT NULL DEFAULT '{}'::jsonb,

  registered_at         timestamptz NOT NULL DEFAULT now(),
  registered_by         uuid REFERENCES users (id),
  last_heartbeat_at     timestamptz,

  decommissioned_at     timestamptz,
  decommissioned_by     uuid REFERENCES users (id),

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE installations IS
  'A concrete deployed/running instance of DPDP (SaaS client or Enterprise '
  'deployment), distinct from Plan (organisations.plan, descriptive) and from '
  'the Gateway device that runs inside it (gateway_devices.installation_id). '
  'Registered only through a validated license (licenses table). Tenant-scoped '
  '+ RLS-forced.';

COMMENT ON COLUMN installations.environment_metadata IS
  'Non-secret descriptive metadata only (e.g. platform, hostname hash, node '
  'version) — never a customer data value, credential, or connection string (I1).';

SELECT app.apply_tenant_rls('public.installations');
CREATE INDEX installations_tenant_status_idx ON installations (tenant_id, status);
CREATE TRIGGER installations_touch_updated_at
  BEFORE UPDATE ON installations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS installations;
