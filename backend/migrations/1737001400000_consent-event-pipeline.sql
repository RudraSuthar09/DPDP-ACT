-- The consent event pipeline, completed (FR-CON-03/04/05, Seam S2).
--
-- WHAT WAS ALREADY RIGHT — and is deliberately left alone:
--   * `consent_events` is already bitemporal (occurred_at = valid-time from the
--     caller, recorded_at = transaction-time stamped by the database), already
--     HASH-partitioned 8 ways on tenant_id, already append-only (a BEFORE
--     UPDATE/DELETE trigger raises, and dpdp_app holds SELECT and nothing else),
--     and already idempotent (UNIQUE (tenant_id, idempotency_key) +
--     ON CONFLICT DO NOTHING returning the original row).
--   * `app.consent_append` is already the single SECURITY DEFINER write path (R3).
-- None of that is rebuilt here. This migration is additive.
--
-- WHAT WAS WRONG, and is fixed here:
--
--   1. `notice_version_id` was `text` with NO foreign key — a placeholder from
--      Seam S2 (Prompt 6), written before notices existed. Live rows contain
--      literal strings like 'notice-v1' and 'n'. Since FR-CON-02 landed
--      (Prompt 18) there is a real `consent_notice_versions` table, and
--      "which exact notice text did this person see" is the field the whole
--      evidentiary value of a consent record rests on. It becomes a real uuid
--      FK here.
--
--   2. The per-tenant HMAC secret (I2 / FR-CON-04) was DERIVED from a single
--      deployment-wide pepper — HMAC(pepper, tenant_id) — not stored per tenant.
--      That means one leaked pepper compromises every tenant's subject refs at
--      once, and a rotation breaks all tenants simultaneously. The master doc
--      says "HMAC'd with a per-tenant secret"; this adds real, independent,
--      per-tenant secret material, encrypted at rest.
--
--   3. Nothing constrained `occurred_at`. A caller could claim a valid-time
--      years in the future and silently poison every "what was true on date X"
--      query forever. Guarded in the write path below.
--
--   4. `evidence_hash` was ambiguous: the platform derived one, but FR-CON-03
--      also lists it as a client-supplied payload field. One column meaning two
--      different things is a defect in an evidence system, so its provenance is
--      now recorded alongside it.
--
-- ---------------------------------------------------------------------------
-- HOW THE 9 PRE-EXISTING ROWS ARE HANDLED (read before changing this)
--
-- They cannot satisfy a real notice FK — they reference notices that never
-- existed. This migration does NOT delete them: consent_events is append-only
-- evidence, and "delete the inconvenient rows" is precisely the habit the table
-- exists to make impossible. Instead it uses the same pattern this codebase
-- already applies twice (inventory_register_entry_versions.purpose /
-- retention_period, and consent_purposes.name): the old column is RENAMED to a
-- frozen `legacy_*` field, kept forever, never rewritten (I4), and a new,
-- correctly-typed column takes its name.
--
-- Integrity for NEW rows is then enforced by a time-boundary CHECK rather than
-- by NOT NULL: only rows recorded BEFORE this migration may lack a real notice
-- reference. Every row written from now on must have one, and that is enforced
-- by the engine — not merely by the write path remembering to.
--
-- In production this same migration would need a backfill window instead (map
-- legacy refs onto real notice versions before cutting over). This is dev data,
-- which is the only reason the frozen-column route is honest here.
-- ---------------------------------------------------------------------------

-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. Per-tenant subject-reference secrets (FR-CON-04, I2)
--
-- One random 32-byte secret per tenant, encrypted at rest with the same
-- AES-256-GCM SecretCipher that protects TOTP secrets (NFR-SEC-03), AAD-bound
-- to the tenant so ciphertext lifted into another tenant's row will not
-- decrypt. subject_ref = HMAC(tenant_secret, customer_id): one-way, so the
-- platform can never recover a customer id, while the client — who holds the
-- id — can always re-derive the same ref to find their own events. That
-- asymmetry is the whole of I2.
--
-- This is also the seam for NFR-SEC-02: swapping the ciphertext for a KMS/Vault
-- key handle is a change to how this ONE column is read, not a re-hash of every
-- consent event ever written.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_consent_secrets (
  tenant_id         uuid PRIMARY KEY DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  secret_ciphertext text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_consent_secrets IS
  'FR-CON-04 / I2: the per-tenant HMAC secret used to pseudonymise consent '
  'subject references at ingest. Encrypted at rest (AES-256-GCM, AAD-bound to '
  'the tenant). One row per tenant, created on first use and thereafter '
  'immutable — see the REVOKE UPDATE below.';

SELECT app.apply_tenant_rls('public.tenant_consent_secrets');

-- apply_tenant_rls grants SELECT/INSERT/UPDATE as standard. UPDATE is revoked
-- here, deliberately and against the house pattern: silently changing a
-- tenant's secret would orphan EVERY subject_ref ever written for that tenant —
-- every stored consent event would become permanently unmatchable to the
-- customer it belongs to, with no error and no way back. Rotation is a real
-- future need, but it is a deliberate, audited, re-derivation-aware operation,
-- not something an ordinary UPDATE should be able to do by accident.
REVOKE UPDATE ON tenant_consent_secrets FROM dpdp_app;

-- ---------------------------------------------------------------------------
-- 2. consent_events: notice_version_id becomes a real reference
-- ---------------------------------------------------------------------------

-- The old free-text column, frozen. Never rewritten (I4) — it is the only
-- record of what those early events actually claimed.
ALTER TABLE consent_events RENAME COLUMN notice_version_id TO legacy_notice_version_ref;
ALTER TABLE consent_events ALTER COLUMN legacy_notice_version_ref DROP NOT NULL;

COMMENT ON COLUMN consent_events.legacy_notice_version_ref IS
  'DEPRECATED / FROZEN: the free-text notice reference used before FR-CON-02 '
  'notice versions existed. Non-NULL only on events recorded before the '
  'consent-event-pipeline migration. New events leave this NULL and populate '
  'notice_version_id instead. Never rewritten (I4).';

ALTER TABLE consent_events
  ADD COLUMN notice_version_id uuid REFERENCES consent_notice_versions (id);

COMMENT ON COLUMN consent_events.notice_version_id IS
  'FR-CON-02/03: the EXACT notice version the data principal was shown. '
  'A real reference to consent_notice_versions — consent divorced from the '
  'notice it was given against is worthless as evidence.';

-- Backfill the one legacy row whose text happened to already BE a real notice
-- version id (written after Prompt 18 landed but before this migration).
--
-- TWO ENGINE-LEVEL GUARDS MUST BE STOOD DOWN FOR THIS SINGLE STATEMENT, and
-- both are restored immediately after. Neither is optional to think about:
--
--   * consent_events_no_mutate raises on ANY update, for everyone including the
--     owner — that is the append-only guarantee, and it applies to migrations
--     too. Disabling it here is the one place in the system that is allowed to,
--     and it is filling in a NEW column on historical rows, not altering what
--     any of them ever claimed.
--   * FORCE ROW LEVEL SECURITY makes even the table owner subject to the tenant
--     policy, and app.current_tenant() is NULL during a migration — so without
--     NO FORCE this UPDATE would silently match ZERO rows and "succeed",
--     leaving the backfill quietly undone. (Same trap as the consent_purposes
--     backfill in the previous migration.)
--
-- NOTE THE SECOND TABLE. `consent_notice_versions` must be stood down too, not
-- just the one being updated: the EXISTS below READS it, and a FORCE-RLS read
-- with no tenant in scope returns zero rows — so the UPDATE would match nothing
-- and report success. This was caught only by inspecting the rows afterwards,
-- which is the point: an RLS-silenced backfill has no failure mode you can see
-- from the migration output. Every table a backfill TOUCHES needs standing down,
-- not merely the target.
ALTER TABLE consent_events DISABLE TRIGGER consent_events_no_mutate;
ALTER TABLE consent_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_notice_versions NO FORCE ROW LEVEL SECURITY;

UPDATE consent_events e
   SET notice_version_id = e.legacy_notice_version_ref::uuid
 WHERE e.legacy_notice_version_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS (
     SELECT 1 FROM consent_notice_versions nv
      WHERE nv.id = e.legacy_notice_version_ref::uuid
        AND nv.tenant_id = e.tenant_id
   );

ALTER TABLE consent_notice_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events ENABLE TRIGGER consent_events_no_mutate;

-- Integrity for everything written from here on. A fixed literal, not now():
-- migrations must mean the same thing whenever they are replayed. Any row
-- recorded after this instant MUST carry a real notice version.
ALTER TABLE consent_events
  ADD CONSTRAINT consent_events_notice_required
    CHECK (notice_version_id IS NOT NULL OR recorded_at < TIMESTAMPTZ '2026-07-28 13:00:00+00');

-- Where the evidence_hash came from. A client-supplied hash is the CLIENT's
-- attestation over evidence they hold (the rendered notice, the form state);
-- a platform-derived one is our canonical digest over exactly what was
-- recorded. Both are legitimate; being unable to tell them apart later is not.
ALTER TABLE consent_events
  ADD COLUMN evidence_hash_origin text NOT NULL DEFAULT 'platform'
    CHECK (evidence_hash_origin IN ('client', 'platform'));

COMMENT ON COLUMN consent_events.evidence_hash_origin IS
  'Provenance of evidence_hash: ''client'' = supplied in the ingest payload '
  '(the client''s seal over evidence they hold); ''platform'' = derived by us '
  'over the recorded envelope. Legacy rows default to ''platform'', which is '
  'what they in fact were.';

-- The bitemporal read path: "as of valid-time X, as far as we knew at
-- transaction-time Y, for this subject". The existing subject index covers
-- occurred_at only; this covers the second clock and the per-purpose grouping.
CREATE INDEX consent_events_bitemporal_idx
  ON consent_events (tenant_id, subject_ref, purpose_id, occurred_at DESC, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- 3. app.consent_append — same single write path (R3), correct arguments
--
-- Replaced rather than added to: the notice argument changes type (text -> uuid),
-- so the old signature must go, or two write paths would exist and R3 would be
-- a comment rather than a fact.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.consent_append(text, uuid, text, text, timestamptz, text, text, text);

CREATE FUNCTION app.consent_append(
  p_subject_ref          text,
  p_purpose_id           uuid,
  p_status               text,
  p_notice_version_id    uuid,
  p_occurred_at          timestamptz,
  p_source               text,
  p_evidence_hash        text,
  p_evidence_hash_origin text,
  p_idempotency_key      text
) RETURNS TABLE (event_id uuid, event_recorded_at timestamptz, deduplicated boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  v_tenant   uuid := app.current_tenant();
  v_id       uuid;
  v_recorded timestamptz;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'consent_append requires a tenant in scope (Seam S1/S2). Every event belongs to one stream.'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Valid-time sanity. A small skew allowance covers honest clock drift on a
  -- client device; beyond that, an event claiming to have happened in the
  -- future would sit undetected in the store and corrupt every "what was true
  -- on date X" answer from now until someone noticed. Rejecting is the only
  -- safe option — there is no correct way to store a lie about when consent
  -- was given.
  IF p_occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'occurred_at (%) is more than 5 minutes in the future. Consent cannot be given before it happens.', p_occurred_at
      USING ERRCODE = 'invalid_datetime_format';
  END IF;

  -- The notice must exist, belong to this tenant, AND be a notice FOR THE
  -- PURPOSE being consented to. The foreign key alone would allow recording
  -- consent for "marketing" against the notice text for "appointment
  -- reminders" — structurally valid, evidentially worthless. Checked here, in
  -- the single write path, so it is impossible rather than merely unlikely.
  IF NOT EXISTS (
    SELECT 1 FROM consent_notice_versions nv
     WHERE nv.id = p_notice_version_id
       AND nv.tenant_id = v_tenant
       AND nv.purpose_id = p_purpose_id
  ) THEN
    RAISE EXCEPTION 'notice_version_id % is not a notice version of purpose % in this tenant.', p_notice_version_id, p_purpose_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO consent_events (
    tenant_id, subject_ref, purpose_id, status, notice_version_id,
    occurred_at, recorded_at, source, evidence_hash, evidence_hash_origin, idempotency_key
  ) VALUES (
    v_tenant, p_subject_ref, p_purpose_id, p_status, p_notice_version_id,
    p_occurred_at, now(), p_source, p_evidence_hash, p_evidence_hash_origin, p_idempotency_key
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id, recorded_at INTO v_id, v_recorded;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_recorded, false;
  ELSE
    -- The key was already present: return the ORIGINAL event, untouched, and
    -- write nothing. Note this is true even if the replayed payload differs —
    -- an idempotency key means "this is the same request", and the first
    -- version of a request is the one that counts. That is what makes a
    -- retried SDK call in a checkout flow safe.
    RETURN QUERY
      SELECT e.id, e.recorded_at, true
      FROM consent_events e
      WHERE e.tenant_id = v_tenant AND e.idempotency_key = p_idempotency_key;
  END IF;
END
$fn$;

COMMENT ON FUNCTION app.consent_append IS
  'The single INSERT path into consent_events (R3, Seam S2). Takes no tenant_id '
  '(uses app.current_tenant()); validates valid-time and that the notice version '
  'belongs to the purpose; idempotent on (tenant, idempotency_key). Called by '
  'exactly one file: the PostgresEventSink.';

REVOKE ALL ON FUNCTION app.consent_append(text, uuid, text, uuid, timestamptz, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consent_append(text, uuid, text, uuid, timestamptz, text, text, text, text) TO dpdp_app;

-- Down Migration

DROP FUNCTION IF EXISTS app.consent_append(text, uuid, text, uuid, timestamptz, text, text, text, text);

DROP INDEX IF EXISTS consent_events_bitemporal_idx;

ALTER TABLE consent_events DROP CONSTRAINT IF EXISTS consent_events_notice_required;
ALTER TABLE consent_events DROP COLUMN IF EXISTS evidence_hash_origin;
ALTER TABLE consent_events DROP COLUMN IF EXISTS notice_version_id;
ALTER TABLE consent_events RENAME COLUMN legacy_notice_version_ref TO notice_version_id;

DROP TABLE IF EXISTS tenant_consent_secrets;

-- Restore the pre-migration write path so a down/up cycle is symmetric.
CREATE FUNCTION app.consent_append(
  p_subject_ref       text,
  p_purpose_id        uuid,
  p_status            text,
  p_notice_version_id text,
  p_occurred_at       timestamptz,
  p_source            text,
  p_evidence_hash     text,
  p_idempotency_key   text
) RETURNS TABLE (event_id uuid, event_recorded_at timestamptz, deduplicated boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  v_tenant   uuid := app.current_tenant();
  v_id       uuid;
  v_recorded timestamptz;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'consent_append requires a tenant in scope (Seam S1/S2).'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO consent_events (
    tenant_id, subject_ref, purpose_id, status, notice_version_id,
    occurred_at, recorded_at, source, evidence_hash, idempotency_key
  ) VALUES (
    v_tenant, p_subject_ref, p_purpose_id, p_status, p_notice_version_id,
    p_occurred_at, now(), p_source, p_evidence_hash, p_idempotency_key
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id, recorded_at INTO v_id, v_recorded;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_recorded, false;
  ELSE
    RETURN QUERY
      SELECT e.id, e.recorded_at, true
      FROM consent_events e
      WHERE e.tenant_id = v_tenant AND e.idempotency_key = p_idempotency_key;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION app.consent_append(text, uuid, text, text, timestamptz, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consent_append(text, uuid, text, text, timestamptz, text, text, text) TO dpdp_app;
