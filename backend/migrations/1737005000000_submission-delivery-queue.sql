-- Submission delivery queue — the cloud relay for a PUBLIC hosted-link
-- consent-form submission whose customer field values/documents must reach a
-- tenant's LOCAL (Electron-native or SaaS) storage even when the CUSTOMER's
-- own device obviously has no access to it, and the tenant's own delivery
-- agent may be offline at submission time.
--
-- THIS IS A DELIBERATE, DOCUMENTED, NARROWLY-SCOPED EXCEPTION TO CLAUDE.md's
-- I1/R6 ("the central platform never persists customer data values... there
-- is no such thing as temporary durable storage"). See CLAUDE.md's "Cloud
-- relay staging exception" section for the full reasoning; the short version:
-- a customer filling a hosted link on their OWN device has no way to reach
-- `D:\...` directly (correctly — the browser must never touch a client path),
-- so SOME durable holding point between "customer submits" and "the tenant's
-- own machine is next online" is unavoidable if submissions must never be
-- lost. This table is that holding point, and nothing else in the platform
-- gains persistence of customer values because of it:
--   - the payload is ENCRYPTED at rest (AES-256-GCM, platform key) — never
--     plaintext in this table;
--   - it is DELETED (columns nulled) the moment the client's own delivery
--     agent confirms the local filesystem write succeeded — never kept "for
--     later", never evidence-retained the way an audit/consent row is (I4
--     does not apply to the payload columns specifically; it still applies
--     to the row's lifecycle metadata: id/status/timestamps stay, exactly
--     like every other append-only lifecycle record here);
--   - every other write path in the platform (site-wide widget embed,
--     Enterprise 'server'-provider synchronous write, the browser/Electron
--     synchronous dual-write) is completely unmodified and still never
--     touches Postgres with a field value (see consent-forms.service.ts).

-- Up Migration

CREATE TABLE consent_form_submission_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant()
                          REFERENCES organisations (id),

  submission_id         uuid NOT NULL REFERENCES consent_form_submissions (id),
  form_id               uuid NOT NULL REFERENCES consent_forms (id),

  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),

  -- AES-256-GCM ciphertext of the JSON-serialised delivery payload (customer
  -- folder hints + field values/document bytes) — see submission-delivery
  -- .service.ts for the exact shape. NULL once delivered (or if this
  -- submission had no field values to relay at all — see the trigger below).
  payload_ciphertext    bytea,
  payload_iv            bytea,
  payload_auth_tag      bytea,

  claimed_by_device_id  uuid REFERENCES gateway_devices (id),
  attempt_count         integer NOT NULL DEFAULT 0,
  claimed_at            timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  -- A short, sanitized failure reason ONLY — never a field value, never a
  -- filesystem path fragment derived from customer content. Populated by the
  -- agent's own error message (already sanitized before it ever leaves the
  -- client, same discipline as EnterpriseStorageSyncService's logging).
  last_error            text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE consent_form_submission_deliveries IS
  'Cloud relay staging for a hosted-link submission''s field values/documents, '
  'PENDING -> DELIVERING -> DELIVERED|FAILED, picked up by the tenant''s own '
  'local delivery agent. Encrypted at rest; nulled on delivery. Deliberate, '
  'documented I1/R6 exception — see this migration''s header and CLAUDE.md.';
COMMENT ON COLUMN consent_form_submission_deliveries.payload_ciphertext IS
  'AES-256-GCM ciphertext — never plaintext. Nulled once delivered.';

SELECT app.apply_tenant_rls('public.consent_form_submission_deliveries');

CREATE INDEX consent_form_submission_deliveries_tenant_status_idx
  ON consent_form_submission_deliveries (tenant_id, status, created_at);
CREATE INDEX consent_form_submission_deliveries_submission_idx
  ON consent_form_submission_deliveries (submission_id);
CREATE INDEX consent_form_submission_deliveries_device_idx
  ON consent_form_submission_deliveries (claimed_by_device_id);

CREATE TRIGGER consent_form_submission_deliveries_touch_updated_at
  BEFORE UPDATE ON consent_form_submission_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS consent_form_submission_deliveries;
