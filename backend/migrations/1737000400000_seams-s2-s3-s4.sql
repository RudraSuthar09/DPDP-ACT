-- Seams S2, S3, S4 — the three remaining seams as Stage-1 Postgres tables.
-- Part 5 of the master doc. Postgres only: no Kafka (S2 later), no Temporal
-- (S3 later), no DB drivers (S4 later). Each is "build the seam now, build the
-- system later": a simple interface today, a big system behind it tomorrow,
-- with ~zero business logic changing when it is swapped.
--
-- ===========================================================================
-- S2 — consent_events. Append-only, bitemporal, PARTITIONED. Written through
--      ONE path (app.consent_append), never an ad-hoc INSERT (R3) — enforced the
--      same three ways as the audit log: dpdp_app has SELECT and no INSERT, the
--      only writer is a SECURITY DEFINER function, and a build test forbids any
--      other file from naming the table/function.
--
-- S3 — workflow_jobs. The durable, tenant-scoped deadline register behind the
--      WorkflowRunner. Writes go through SECURITY DEFINER functions (R3); the
--      pg-boss engine (separate infra schema) does the actual waking-up. A
--      role-scoped policy gives the reconciliation ticker a cross-tenant read
--      without weakening dpdp_app's isolation — the resolve_login peephole again.
--
-- S4 — inventory_data_elements. Ordinary tenant metadata (names/types only, I1).
--      Not write-gated: S4's invariant is I1, enforced by the TYPE SYSTEM (no
--      readRows in SchemaSource), not by locking down this table.
-- ===========================================================================

-- Up Migration

-- A generic append-only guard, reused wherever "a correction is a new row, never
-- an edit" holds. (The audit log has its own, message-tuned to evidence; this is
-- the same idea for consent.)
CREATE FUNCTION app.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION
    '% is append-only (R3/I4): % is not permitted. A correction is a NEW event, never an edit.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

-- ---------------------------------------------------------------------------
-- S2 — CONSENT EVENTS
--
-- Bitemporal (two clocks) and append-only: a withdrawal is a NEW event, never an
-- update (FR-CON-05), so the system can answer "what was true on 3rd March, as
-- far as we knew on 3rd March?" forever. Partitioned by HASH(tenant_id): the doc
-- envisions per-tenant partitioning (later, Kafka partitions by tenant too), and
-- HASH keeps idempotency simple — a UNIQUE that includes the partition key.
-- ---------------------------------------------------------------------------
CREATE TABLE consent_events (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant(),

  -- HMAC'd with a per-tenant secret; opaque and irreversible to the platform
  -- (I2). The client holds the customer id and can re-derive this; we cannot go
  -- backwards from it.
  subject_ref       text NOT NULL,

  purpose_id        uuid NOT NULL REFERENCES consent_purposes (id),
  status            text NOT NULL CHECK (status IN ('GRANTED', 'WITHDRAWN', 'EXPIRED')),

  -- Which EXACT notice text the person saw. Consent divorced from its notice is
  -- worthless as evidence (FR-CON-02) — this is not optional.
  notice_version_id text NOT NULL,

  -- The two clocks. occurred_at = valid-time (when it happened); recorded_at =
  -- transaction-time (when the platform learned of it), set by the DB, never the
  -- caller.
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  source            text NOT NULL CHECK (source IN ('web_sdk', 'mobile_sdk', 'api', 'portal', 'import')),
  evidence_hash     text NOT NULL,
  idempotency_key   text NOT NULL,

  -- PK and the idempotency UNIQUE must both include the partition key (tenant_id)
  -- — a constraint of hash partitioning, and the reason idempotency is scoped per
  -- tenant (which is exactly right: keys are the client's, unique within a tenant).
  CONSTRAINT consent_events_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT consent_events_idempotent UNIQUE (tenant_id, idempotency_key)
) PARTITION BY HASH (tenant_id);

COMMENT ON TABLE consent_events IS
  'Seam S2: append-only, bitemporal, hash-partitioned consent events (FR-CON-03/05). '
  'Written ONLY via app.consent_append() through the EventSink (R3). A withdrawal '
  'is a new event, never an update. subject_ref is per-tenant HMAC (I2).';

-- Eight hash partitions. Fixed count, no per-tenant DDL at sign-up; 1.2M rows/yr
-- fits comfortably (the doc's own sizing). More partitions or a re-hash is a
-- migration, invisible above the EventSink.
DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format(
      'CREATE TABLE consent_events_p%s PARTITION OF consent_events FOR VALUES WITH (MODULUS 8, REMAINDER %s)',
      i, i
    );
    -- Defense in depth: RLS on each LEAF partition too, not just the parent. A
    -- query routed through the parent is covered by the parent's policy, but a
    -- direct `SELECT FROM consent_events_p4` must ALSO be tenant-scoped — grants
    -- already deny dpdp_app that, and this makes it belt-and-suspenders. The
    -- isolation precondition suite requires it of every tenant table, and a leaf
    -- partition is one. SELECT-only, like the parent: writes go through the sink.
    EXECUTE format('ALTER TABLE consent_events_p%s ENABLE ROW LEVEL SECURITY', i);
    EXECUTE format('ALTER TABLE consent_events_p%s FORCE ROW LEVEL SECURITY', i);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON consent_events_p%s '
      'USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant())',
      i
    );
  END LOOP;
END
$$;

-- Read paths: a subject's history (proof-of-consent, FR-CON-08) and a purpose's.
CREATE INDEX consent_events_subject_idx ON consent_events (tenant_id, subject_ref, occurred_at DESC);
CREATE INDEX consent_events_purpose_idx ON consent_events (tenant_id, purpose_id, occurred_at DESC);

-- RLS on the parent — enforced for every parent-routed query (which is the only
-- way the app touches this table). SELECT only for dpdp_app: writing is
-- app.consent_append's job, exactly as with the audit log.
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_events
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());
GRANT SELECT ON consent_events TO dpdp_app;

-- Append-only: no UPDATE, no DELETE, for anyone (the trigger fires for the owner
-- and superuser too). Row triggers on a partitioned parent cascade to partitions.
CREATE TRIGGER consent_events_no_mutate
  BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- THE only write path (R3). Takes no tenant_id — it uses app.current_tenant(),
-- so a caller cannot append into another tenant's stream. Idempotent: replaying
-- the same idempotency_key returns the already-stored event and writes nothing.
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
    RAISE EXCEPTION 'consent_append requires a tenant in scope (Seam S1/S2). Every event belongs to one stream.'
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
    -- The key was already present: return the original event untouched. This is
    -- what makes a retried SDK call safe (FR-CON-03 carries an idempotency key).
    RETURN QUERY
      SELECT e.id, e.recorded_at, true
      FROM consent_events e
      WHERE e.tenant_id = v_tenant AND e.idempotency_key = p_idempotency_key;
  END IF;
END
$fn$;

COMMENT ON FUNCTION app.consent_append IS
  'The single INSERT path into consent_events (R3, Seam S2). Takes no tenant_id '
  '(uses app.current_tenant()); idempotent on (tenant, idempotency_key). Called '
  'by exactly one file: the PostgresEventSink.';

REVOKE ALL ON FUNCTION app.consent_append(text, uuid, text, text, timestamptz, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consent_append(text, uuid, text, text, timestamptz, text, text, text) TO dpdp_app;

-- ---------------------------------------------------------------------------
-- S3 — WORKFLOW JOBS
--
-- The durable, tenant-scoped deadline register. pg-boss (in its own `pgboss`
-- schema, created at runtime) is the ENGINE that wakes the worker at run_at;
-- this table is the auditable SOURCE OF TRUTH the domain reasons about. Writes
-- go through SECURITY DEFINER functions only (R3) — no service INSERTs a job row.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),

  -- The thing the deadline is about: an incident / ticket / request id.
  workflow_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('breach', 'grievance', 'dprequest')),

  -- The deadline itself — a VALUE, computed by the caller from a (later, versioned)
  -- deadline policy. Never an `if (daysSince > 3)` in a controller (R2/R3).
  run_at        timestamptz NOT NULL,

  status        text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled', 'fired', 'cancelled', 'failed')),
  attempts      int NOT NULL DEFAULT 0,

  -- Ids and metadata only — never a customer record (I1).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The pg-boss job this row scheduled, so cancel() can pull it from the engine.
  pgboss_job_id uuid,

  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  fired_at      timestamptz,
  cancelled_at  timestamptz,

  -- One live deadline per (workflow, kind). Reschedule updates in place.
  CONSTRAINT workflow_jobs_unique UNIQUE (tenant_id, workflow_id, kind)
);

COMMENT ON TABLE workflow_jobs IS
  'Seam S3: the durable, tenant-scoped deadline register behind the WorkflowRunner. '
  'Shared by Breach, Grievance, DPRequest. Written ONLY via app.workflow_* functions '
  '(R3). pg-boss (separate schema) is the engine that fires jobs at run_at.';

CREATE INDEX workflow_jobs_due_idx ON workflow_jobs (status, run_at);
CREATE INDEX workflow_jobs_tenant_idx ON workflow_jobs (tenant_id, workflow_id);

ALTER TABLE workflow_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_jobs FORCE ROW LEVEL SECURITY;

-- The normal isolation policy (FOR ALL, everyone): dpdp_app sees only its tenant.
CREATE POLICY tenant_isolation ON workflow_jobs
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- The scheduler's peephole. A background ticker must find due deadlines ACROSS
-- tenants — a question that cannot be asked under one tenant's RLS. This extra
-- policy lets ONLY dpdp_owner (via the SECURITY DEFINER sweep below) read across
-- tenants, and ONLY for SELECT. dpdp_app is entirely unaffected: it never matches
-- this policy, so its reads and writes stay tenant-scoped. Same shape as the
-- login directory peephole in Seam S1.
CREATE POLICY workflow_sweep ON workflow_jobs
  FOR SELECT TO dpdp_owner
  USING (true);

-- SELECT only. Every write is a SECURITY DEFINER function (R3).
GRANT SELECT ON workflow_jobs TO dpdp_app;

-- updated_at hygiene (reuses the trigger fn from the identity migration).
CREATE TRIGGER workflow_jobs_touch_updated_at
  BEFORE UPDATE ON workflow_jobs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- schedule (upsert): the only INSERT path. Idempotent on (workflow, kind); a
-- reschedule updates run_at and clears any prior terminal state.
CREATE FUNCTION app.workflow_schedule(
  p_workflow_id   uuid,
  p_kind          text,
  p_run_at        timestamptz,
  p_payload       jsonb,
  p_pgboss_job_id uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  v_tenant uuid := app.current_tenant();
  v_id     uuid;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'workflow_schedule requires a tenant in scope (Seam S1/S3).'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO workflow_jobs (tenant_id, workflow_id, kind, run_at, payload, pgboss_job_id, status)
  VALUES (v_tenant, p_workflow_id, p_kind, p_run_at, COALESCE(p_payload, '{}'::jsonb), p_pgboss_job_id, 'scheduled')
  ON CONFLICT (tenant_id, workflow_id, kind) DO UPDATE
    SET run_at        = EXCLUDED.run_at,
        payload       = EXCLUDED.payload,
        pgboss_job_id = EXCLUDED.pgboss_job_id,
        status        = 'scheduled',
        attempts      = 0,
        last_error    = NULL,
        fired_at      = NULL,
        cancelled_at  = NULL
  RETURNING id INTO v_id;

  RETURN v_id;
END
$fn$;

-- cancel: mark cancelled, hand back the pg-boss job ids so the runner can pull
-- them from the engine. Only scheduled jobs cancel (a fired one is history).
CREATE FUNCTION app.workflow_cancel(p_workflow_id uuid)
  RETURNS SETOF uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  RETURN QUERY
    UPDATE workflow_jobs
       SET status = 'cancelled', cancelled_at = now()
     WHERE tenant_id = app.current_tenant()
       AND workflow_id = p_workflow_id
       AND status = 'scheduled'
    RETURNING pgboss_job_id;
END
$fn$;

-- mark_fired: the transition the worker makes when a deadline fires. Returns
-- true only if it actually moved a scheduled job — so a cancelled or already-
-- fired job is a no-op, and a duplicate delivery does not double-fire.
CREATE FUNCTION app.workflow_mark_fired(p_workflow_id uuid, p_kind text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  v_fired boolean;
BEGIN
  UPDATE workflow_jobs
     SET status = 'fired', fired_at = now(), attempts = attempts + 1
   WHERE tenant_id = app.current_tenant()
     AND workflow_id = p_workflow_id
     AND kind = p_kind
     AND status = 'scheduled'
  RETURNING true INTO v_fired;

  RETURN COALESCE(v_fired, false);
END
$fn$;

-- mark_failed: the deadline handler blew up. Recorded, counted, not lost.
CREATE FUNCTION app.workflow_mark_failed(p_workflow_id uuid, p_kind text, p_error text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  UPDATE workflow_jobs
     SET status = 'failed', last_error = p_error, attempts = attempts + 1
   WHERE tenant_id = app.current_tenant()
     AND workflow_id = p_workflow_id
     AND kind = p_kind;
END
$fn$;

-- due_all: the reconciliation ticker's cross-tenant sweep. Runs as dpdp_owner
-- (definer) so the workflow_sweep policy applies and it sees every tenant's due
-- jobs — returning ids and kind ONLY (no business data, I1). This is the belt to
-- pg-boss's braces: anything the engine missed still gets fired.
CREATE FUNCTION app.workflow_due_all()
  RETURNS TABLE (tenant_id uuid, workflow_id uuid, kind text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  RETURN QUERY
    SELECT j.tenant_id, j.workflow_id, j.kind
    FROM workflow_jobs j
    WHERE j.status = 'scheduled' AND j.run_at <= now()
    ORDER BY j.run_at
    LIMIT 500;
END
$fn$;

COMMENT ON FUNCTION app.workflow_due_all IS
  'Scheduler peephole (Seam S3): due deadlines across ALL tenants, ids + kind only. '
  'Used by the reconciliation ticker to catch jobs pg-boss did not fire. Cross-tenant '
  'by design and narrow by construction — like app.resolve_login for the login path.';

REVOKE ALL ON FUNCTION app.workflow_schedule(uuid, text, timestamptz, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workflow_cancel(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workflow_mark_fired(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workflow_mark_failed(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.workflow_due_all() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workflow_schedule(uuid, text, timestamptz, jsonb, uuid) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.workflow_cancel(uuid) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.workflow_mark_fired(uuid, text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.workflow_mark_failed(uuid, text, text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.workflow_due_all() TO dpdp_app;

-- ---------------------------------------------------------------------------
-- S4 — INVENTORY DATA ELEMENTS
--
-- The metadata a SchemaSource discovers: schema/table/column names, types,
-- nullability, comments — and a PII-category SUGGESTION a human confirms. NEVER a
-- value from a row (I1). Ordinary tenant metadata, so it uses the standard RLS
-- helper (SELECT/INSERT/UPDATE) — no write-gating: S4's guarantee is the ABSENCE
-- of readRows() in the SchemaSource type, checked in the build, not a DB grant.
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_data_elements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),

  -- Provenance: which SchemaSource kind produced this, and a human-readable ref
  -- (the wizard, or the imported file name — evidence of what was declared).
  source_kind   text NOT NULL CHECK (source_kind IN ('manual', 'file_import')),
  source_ref    text,

  schema_name   text NOT NULL,
  table_name    text NOT NULL,
  column_name   text NOT NULL,
  data_type     text NOT NULL,
  nullable      boolean NOT NULL DEFAULT true,
  comment       text,

  -- A SUGGESTION only. Under DPDP the client is the Data Fiduciary and owns the
  -- determination; the platform advises, never decides. NULL until classified.
  pii_category  text,

  discovered_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_data_elements_unique UNIQUE (tenant_id, schema_name, table_name, column_name)
);

COMMENT ON TABLE inventory_data_elements IS
  'Seam S4: schema metadata discovered via a SchemaSource (names/types only, I1). '
  'source_kind records whether it came from ManualEntry or FileImport. pii_category '
  'is a suggestion a human confirms (the client owns the determination).';

SELECT app.apply_tenant_rls('public.inventory_data_elements');

CREATE INDEX inventory_data_elements_loc_idx
  ON inventory_data_elements (tenant_id, schema_name, table_name);

-- Down Migration

DROP TABLE IF EXISTS inventory_data_elements;

DROP FUNCTION IF EXISTS app.workflow_due_all();
DROP FUNCTION IF EXISTS app.workflow_mark_failed(uuid, text, text);
DROP FUNCTION IF EXISTS app.workflow_mark_fired(uuid, text);
DROP FUNCTION IF EXISTS app.workflow_cancel(uuid);
DROP FUNCTION IF EXISTS app.workflow_schedule(uuid, text, timestamptz, jsonb, uuid);
DROP TABLE IF EXISTS workflow_jobs;

DROP FUNCTION IF EXISTS app.consent_append(text, uuid, text, text, timestamptz, text, text, text);
DROP TABLE IF EXISTS consent_events;

DROP FUNCTION IF EXISTS app.forbid_mutation();
