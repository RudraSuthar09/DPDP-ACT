-- FR-CON-06/07: one-click withdrawal's new source, and the signed outbound
-- webhook pipeline (consent changes -> the client's system).
--
-- Three additions, all additive:
--
--   1. consent_events.source gains 'internal' — a WITHDRAWN event the platform
--      itself constructs on the subject's behalf (one-click withdrawal) is
--      neither the client's SDK nor their portal, and evidence whose provenance
--      is guessed is not evidence.
--
--   2. tenant_webhook_secrets — the per-tenant HMAC secret used to sign
--      outbound webhook payloads. Deliberately the EXACT same shape as
--      tenant_consent_secrets (1737001400000): one random 32-byte secret per
--      tenant, encrypted at rest with the same AES-256-GCM SecretCipher,
--      AAD-bound to the tenant, and immutable once created (UPDATE revoked) —
--      silently changing it would make every signature verified against the
--      OLD secret fail with no error and no way back, exactly as rotating the
--      subject-ref secret would orphan every stored reference. A real rotation
--      is a deliberate, future, audited operation, not an ordinary UPDATE.
--
--   3. tenant_webhook_config — where the client's endpoint URL lives, and
--      webhook_deliveries — the durable log of every attempt (Prompt 23's
--      settings UI reads this). Both are ordinary tenant metadata (not
--      evidence in the I4 sense the consent log itself is), so they use the
--      standard apply_tenant_rls helper rather than a gated SECURITY DEFINER
--      write path — R3's named exception list is consent/audit/workflow
--      tables specifically, and this is a delivery log, not a source of truth
--      about what consent was given.
-- ---------------------------------------------------------------------------

-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. consent_events.source: add 'internal'
-- ---------------------------------------------------------------------------
ALTER TABLE consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('web_sdk', 'mobile_sdk', 'api', 'portal', 'import', 'internal'));

COMMENT ON COLUMN consent_events.source IS
  'Where the event originated. ''internal'' is the platform acting on the '
  'subject''s behalf (e.g. one-click withdrawal, FR-CON-06) — never accepted '
  'from a client-supplied ingest payload, only ever set by ConsentService''s '
  'own withdrawal path.';

-- ---------------------------------------------------------------------------
-- 2. tenant_webhook_secrets — mirrors tenant_consent_secrets exactly.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_webhook_secrets (
  tenant_id         uuid PRIMARY KEY DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  secret_ciphertext text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_webhook_secrets IS
  'FR-CON-07: the per-tenant HMAC secret used to sign outbound webhook '
  'payloads. Encrypted at rest (AES-256-GCM, AAD-bound to the tenant). One row '
  'per tenant, created on first use (first webhook config write) and '
  'thereafter immutable — see the REVOKE UPDATE below.';

SELECT app.apply_tenant_rls('public.tenant_webhook_secrets');

-- Same reasoning as tenant_consent_secrets: an UPDATE here would silently
-- invalidate the client's ability to verify every signature sent under the old
-- secret, with no error surfaced anywhere.
REVOKE UPDATE ON tenant_webhook_secrets FROM dpdp_app;

-- ---------------------------------------------------------------------------
-- 3. tenant_webhook_config — the client's endpoint URL, one per tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_webhook_config (
  tenant_id  uuid PRIMARY KEY DEFAULT app.current_tenant()
               REFERENCES organisations (id),
  url        text,
  enabled    boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

COMMENT ON TABLE tenant_webhook_config IS
  'FR-CON-07: where (and whether) this tenant wants signed consent-change '
  'webhooks delivered. Ordinary mutable settings, not evidence — every change '
  'is still recorded in the S5 audit log via the controller''s @Audited '
  'action, which is where "who changed the endpoint and when" lives.';

SELECT app.apply_tenant_rls('public.tenant_webhook_config');

CREATE TRIGGER tenant_webhook_config_touch_updated_at
  BEFORE UPDATE ON tenant_webhook_config
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. webhook_deliveries — one row per consent-change event we attempted to
--    deliver, updated in place as attempts happen. Not partitioned (nowhere
--    near consent_events' volume) and not append-only in the strict I4 sense:
--    it is the delivery log, not the consent record — the consent_events row
--    it describes is what remains the evidence of record.
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),

  -- What changed, and enough of the consent event to re-render the exact
  -- payload if ever needed without re-querying consent_events (which may have
  -- moved on to a later event for the same subject/purpose by the time this
  -- row is inspected).
  event_type       text NOT NULL,
  consent_event_id uuid NOT NULL,
  subject_ref      text NOT NULL,
  purpose_id       uuid NOT NULL,

  -- The EXACT bytes signed and sent — stored so "what did we actually send"
  -- is answerable later without recomputing it from mutable inputs.
  payload          jsonb NOT NULL,
  url              text NOT NULL,

  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'success', 'failed')),
  attempt_count    int NOT NULL DEFAULT 0,
  last_response_code int,
  last_error       text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  last_attempted_at timestamptz,
  delivered_at     timestamptz
);

COMMENT ON TABLE webhook_deliveries IS
  'FR-CON-07: the durable log of every attempted webhook delivery for a '
  'consent change — one row per consent_events row, updated as attempts are '
  'made. Prompt 23''s settings UI reads this. dpdp_app has no DELETE grant '
  '(apply_tenant_rls), so a delivery history is never silently cleared.';

SELECT app.apply_tenant_rls('public.webhook_deliveries');

CREATE INDEX webhook_deliveries_tenant_created_idx
  ON webhook_deliveries (tenant_id, created_at DESC);
CREATE INDEX webhook_deliveries_event_idx
  ON webhook_deliveries (tenant_id, consent_event_id);

-- Down Migration

DROP TABLE IF EXISTS webhook_deliveries;

DROP TRIGGER IF EXISTS tenant_webhook_config_touch_updated_at ON tenant_webhook_config;
DROP TABLE IF EXISTS tenant_webhook_config;

DROP TABLE IF EXISTS tenant_webhook_secrets;

ALTER TABLE consent_events DROP CONSTRAINT consent_events_source_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_source_check
  CHECK (source IN ('web_sdk', 'mobile_sdk', 'api', 'portal', 'import'));
