-- Seam S5 -- the hash-chained, append-only audit log. FR-AUD-01/02/03, I4, R3.
--
-- This migration exists before any module writes data, because an audit trail is
-- the one thing that cannot be backfilled: you cannot reconstruct who did what
-- last Tuesday from a table that did not exist last Tuesday.
--
-- ===========================================================================
-- HOW TAMPERING IS DETECTED
--
-- Every entry stores the SHA-256 of the entry before it (per tenant). The hash
-- covers the whole entry INCLUDING that prev_hash, so each entry commits to the
-- entire history behind it. Change one byte of one old row and its hash no
-- longer matches its contents; fix that hash and it no longer matches the
-- prev_hash of the next entry; fix that one and the break walks forward to the
-- head. There is no local edit. app.verify_audit_chain() finds the break.
--
-- WHY THE APPLICATION CANNOT FORGE A LINK
--
-- seq, prev_hash and hash are NOT accepted from the caller. A BEFORE INSERT
-- trigger computes all three from the row's contents and the current head of
-- that tenant's chain, overwriting anything supplied. So the chain is a property
-- the DATABASE maintains -- not a convention the application is trusted to
-- follow. Even a direct INSERT by the table owner gets correctly chained.
--
-- WHY ONLY THE INTERCEPTOR CAN WRITE (R3) -- three independent barriers:
--
--   1. dpdp_app has SELECT on audit_log and NOTHING else. An ad-hoc
--      `INSERT INTO audit_log ...` from any service is `permission denied`.
--      The only write path is app.audit_append(), a SECURITY DEFINER function.
--   2. app.audit_append() does not take a tenant_id. It uses app.current_tenant(),
--      so no caller can write into another tenant's chain even by trying.
--   3. In the application, AuditModule does not export the sink, so no other
--      module can inject it, and an architecture test fails the build if any
--      file outside src/modules/audit/ so much as names audit_log/audit_append.
--
-- APPEND-ONLY IS ENFORCED BY TRIGGER, NOT BY GRANT ALONE
--
-- Grants stop dpdp_app. A trigger stops EVERYONE: triggers fire for the table
-- owner and for superusers too, so even a DBA's `UPDATE audit_log SET ...` or a
-- `TRUNCATE` raises. (A determined superuser can still disable the trigger --
-- but that is a deliberate, logged act, not a slip, and the chain would still
-- show the break.)
-- ===========================================================================

-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. The log. One row per audited action, per tenant, forever.
--
--    The chain is PER TENANT, not global. A tenant must be able to verify its
--    own history end to end, and under RLS it can only see its own rows -- so a
--    global chain would be unverifiable by the only people who need to verify it.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),

  -- Position in this tenant's chain, from 1. Contiguous by construction: a gap
  -- means rows were removed, which the verifier reports.
  seq            bigint NOT NULL,

  -- WHEN. Set by the database, never by the caller -- an actor should not get to
  -- say when they acted.
  occurred_at    timestamptz NOT NULL DEFAULT now(),

  -- WHO. actor_id is NULL exactly when there is no user row to point at: a
  -- failed login, or the instant of self-registration before the Owner exists.
  -- actor_label carries what we do know in those cases (e.g. the email tried).
  actor_id       uuid REFERENCES users (id),
  actor_label    text,

  -- WHAT. A stable dotted name -- 'identity.user.suspended'. Stable because
  -- these strings outlive the code that writes them: they are what an auditor
  -- greps for in three years.
  action         text NOT NULL,
  outcome        text NOT NULL DEFAULT 'success'
                   CHECK (outcome IN ('success', 'denied', 'error')),

  -- WHAT it was done to.
  target_type    text,
  target_id      text,

  -- WHY (I4). Nullable because not every action has a human reason -- logging in
  -- is its own reason. Actions that are decisions ABOUT people (suspend, remove,
  -- role change) require one at the API boundary.
  reason         text,

  -- BEFORE / AFTER (I4). Redacted by the writer: these must never carry
  -- credentials, and they must never carry customer records (I1).
  before_state   jsonb,
  after_state    jsonb,

  -- FROM WHERE. Note an IP is itself personal data and we are a Data Processor:
  -- it is stored because an audit trail without provenance is not evidence, and
  -- it inherits this table's retention and access controls.
  source_ip      inet,
  user_agent     text,

  correlation_id uuid NOT NULL,

  -- THE CHAIN. Computed by trigger; any value supplied by a caller is discarded.
  prev_hash      bytea NOT NULL,
  hash           bytea NOT NULL,

  -- Makes a forked chain unrepresentable, not merely unlikely: even if the
  -- advisory lock below were removed, two concurrent appends cannot both take
  -- the same position.
  CONSTRAINT audit_log_seq_unique UNIQUE (tenant_id, seq),
  CONSTRAINT audit_log_hash_len CHECK (length(hash) = 32 AND length(prev_hash) = 32)
);

COMMENT ON TABLE audit_log IS
  'Seam S5: append-only, hash-chained evidence. One entry per audited action. '
  'Written ONLY via app.audit_append() by the single AuditInterceptor (R3). '
  'seq/prev_hash/hash are computed by trigger and cannot be supplied. Rows are '
  'never updated or deleted -- enforced by trigger, for every role including the '
  'owner. Verify with app.verify_audit_chain().';

-- Read path: "show me this tenant's log, newest first".
CREATE INDEX audit_log_tenant_seq_idx ON audit_log (tenant_id, seq DESC);
-- Read path: "everything that happened to this user / in this request".
CREATE INDEX audit_log_target_idx ON audit_log (tenant_id, target_type, target_id);
CREATE INDEX audit_log_correlation_idx ON audit_log (tenant_id, correlation_id);

-- ---------------------------------------------------------------------------
-- 2. RLS. Deliberately NOT app.apply_tenant_rls(): that helper grants
--    SELECT, INSERT, UPDATE, and this table must grant SELECT only.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_log
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

-- The whole grant. No INSERT (that is app.audit_append's job), no UPDATE, no
-- DELETE. This single line is what makes "a service cannot write an audit row"
-- a fact about the database rather than a rule in a document.
GRANT SELECT ON audit_log TO dpdp_app;

-- ---------------------------------------------------------------------------
-- 3. The hash. ONE definition, used by both the writer and the verifier -- if
--    they could disagree, the verifier would be checking its own arithmetic
--    rather than the log.
--
--    Canonicalisation notes, because a hash is only as good as its input:
--      * jsonb sorts and de-duplicates keys, so its text form is stable for a
--        given value regardless of how the caller wrote it.
--      * timestamps are rendered in explicit UTC with fixed precision. A bare
--        timestamptz::text depends on the session TimeZone, which would make the
--        same entry hash differently for two verifiers in two countries.
--      * NULL and absent are distinguished by fixed keys always being present.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_entry_hash(
  p_prev_hash      bytea,
  p_tenant_id      uuid,
  p_seq            bigint,
  p_occurred_at    timestamptz,
  p_actor_id       uuid,
  p_actor_label    text,
  p_action         text,
  p_outcome        text,
  p_target_type    text,
  p_target_id      text,
  p_reason         text,
  p_before_state   jsonb,
  p_after_state    jsonb,
  p_source_ip      inet,
  p_user_agent     text,
  p_correlation_id uuid
) RETURNS bytea
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $fn$
  SELECT sha256(convert_to(jsonb_build_object(
    'prev',          encode(p_prev_hash, 'hex'),
    'tenant',        p_tenant_id::text,
    'seq',           p_seq,
    'at',            to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor',         p_actor_id::text,
    'actorLabel',    p_actor_label,
    'action',        p_action,
    'outcome',       p_outcome,
    'targetType',    p_target_type,
    'targetId',      p_target_id,
    'reason',        p_reason,
    'before',        p_before_state,
    'after',         p_after_state,
    'ip',            p_source_ip::text,
    'ua',            p_user_agent,
    'correlationId', p_correlation_id::text
  )::text, 'UTF8'));
$fn$;

COMMENT ON FUNCTION app.audit_entry_hash IS
  'The one canonical hash of an audit entry, covering its contents AND the '
  'previous entry hash. Used by the chain trigger and by verify_audit_chain() '
  'so the two can never disagree.';

-- The genesis link: the "previous hash" of the first entry in a tenant's chain.
CREATE FUNCTION app.audit_genesis_hash() RETURNS bytea
  LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. The chain trigger. The reason the application cannot forge history.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_chain_link() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  v_prev_hash bytea;
  v_prev_seq  bigint;
BEGIN
  -- Serialise appends within a tenant. Two concurrent requests would otherwise
  -- read the same head and compute the same prev_hash, forking the chain. The
  -- lock is transaction-scoped and per tenant, so tenants never wait on each
  -- other. (The UNIQUE(tenant_id, seq) constraint is the backstop if this is
  -- ever removed: a fork becomes an error rather than a silent second history.)
  PERFORM pg_advisory_xact_lock(hashtext(NEW.tenant_id::text)::bigint);

  SELECT a.hash, a.seq INTO v_prev_hash, v_prev_seq
  FROM audit_log a
  WHERE a.tenant_id = NEW.tenant_id
  ORDER BY a.seq DESC
  LIMIT 1;

  -- Whatever the caller put in these, it is discarded. This is the line that
  -- turns "services are supposed to not forge audit rows" into "services cannot".
  NEW.prev_hash := COALESCE(v_prev_hash, app.audit_genesis_hash());
  NEW.seq       := COALESCE(v_prev_seq, 0) + 1;
  NEW.occurred_at := COALESCE(NEW.occurred_at, now());

  NEW.hash := app.audit_entry_hash(
    NEW.prev_hash, NEW.tenant_id, NEW.seq, NEW.occurred_at,
    NEW.actor_id, NEW.actor_label, NEW.action, NEW.outcome,
    NEW.target_type, NEW.target_id, NEW.reason,
    NEW.before_state, NEW.after_state, NEW.source_ip, NEW.user_agent,
    NEW.correlation_id
  );

  RETURN NEW;
END
$fn$;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_chain_link();

-- ---------------------------------------------------------------------------
-- 5. Append-only, for everyone.
--    The grants above already stop dpdp_app. This stops the table owner, a
--    migration, a DBA at a psql prompt, and a superuser -- triggers are not
--    bypassed by ownership or by BYPASSRLS the way policies are.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only (Seam S5 / invariant I4): % is not permitted on this table. '
    'Evidence is never rewritten. To correct the record, append a new entry.',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END
$fn$;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_forbid_mutation();

-- TRUNCATE takes no rows and fires no row triggers -- it would quietly erase an
-- entire tenant's history, so it gets its own statement-level guard.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 6. The ONLY write path.
--
--    Note what is missing from the signature: tenant_id. It is taken from
--    app.current_tenant(), so a caller cannot append to another tenant's chain
--    even deliberately -- and if the GUC is unset, tenant_id is NULL and the
--    NOT NULL constraint fails the write closed.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.audit_append(
  p_action         text,
  p_outcome        text,
  p_correlation_id uuid,
  p_actor_id       uuid    DEFAULT NULL,
  p_actor_label    text    DEFAULT NULL,
  p_target_type    text    DEFAULT NULL,
  p_target_id      text    DEFAULT NULL,
  p_reason         text    DEFAULT NULL,
  p_before_state   jsonb   DEFAULT NULL,
  p_after_state    jsonb   DEFAULT NULL,
  p_source_ip      inet    DEFAULT NULL,
  p_user_agent     text    DEFAULT NULL
-- OUT names are prefixed (entry_*) so they cannot collide with the identically
-- named audit_log columns inside the RETURNING clause below -- plpgsql resolves
-- an unqualified `id` to the OUT parameter and the insert fails to compile.
) RETURNS TABLE (entry_id uuid, entry_seq bigint, entry_occurred_at timestamptz, entry_hash bytea)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  RETURN QUERY
  INSERT INTO audit_log (
    tenant_id, seq, actor_id, actor_label, action, outcome,
    target_type, target_id, reason, before_state, after_state,
    source_ip, user_agent, correlation_id, prev_hash, hash
  ) VALUES (
    app.current_tenant(),
    -- Placeholders. The chain trigger overwrites all three; they are here only
    -- because the columns are NOT NULL.
    0, p_actor_id, p_actor_label, p_action, p_outcome,
    p_target_type, p_target_id, p_reason, p_before_state, p_after_state,
    p_source_ip, p_user_agent, p_correlation_id,
    app.audit_genesis_hash(), app.audit_genesis_hash()
  )
  RETURNING audit_log.id, audit_log.seq, audit_log.occurred_at, audit_log.hash;
END
$fn$;

COMMENT ON FUNCTION app.audit_append IS
  'The single INSERT path into audit_log (R3). Takes no tenant_id -- it uses '
  'app.current_tenant(), so no caller can write into another tenant chain. '
  'Called by exactly one file: the AuditInterceptor sink.';

-- ---------------------------------------------------------------------------
-- 7. The verifier. Walks a tenant's chain and reports every break.
--
--    SECURITY INVOKER on purpose: it runs under the caller's RLS, so a tenant
--    verifies its own chain and cannot see, or vouch for, anyone else's.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.verify_audit_chain()
  RETURNS TABLE (entry_seq bigint, entry_id uuid, problem text)
  LANGUAGE plpgsql
  STABLE
  SET search_path = pg_catalog, app, public
AS $fn$
DECLARE
  r             record;
  expected_prev bytea  := app.audit_genesis_hash();
  expected_seq  bigint := 1;
  recomputed    bytea;
BEGIN
  FOR r IN
    SELECT * FROM audit_log WHERE tenant_id = app.current_tenant() ORDER BY audit_log.seq
  LOOP
    -- A gap means entries were removed. (Which the triggers forbid -- so if you
    -- are reading this in a report, something reached past the application.)
    IF r.seq <> expected_seq THEN
      RETURN QUERY SELECT r.seq, r.id,
        format('sequence gap: expected %s, found %s -- %s entrie(s) missing',
               expected_seq, r.seq, r.seq - expected_seq);
    END IF;

    -- The link to the entry before it.
    IF r.prev_hash IS DISTINCT FROM expected_prev THEN
      RETURN QUERY SELECT r.seq, r.id,
        format('broken link: prev_hash %s does not match the previous entry hash %s',
               encode(r.prev_hash, 'hex'), encode(expected_prev, 'hex'));
    END IF;

    -- The entry's own integrity: does its stored hash still match its contents?
    recomputed := app.audit_entry_hash(
      r.prev_hash, r.tenant_id, r.seq, r.occurred_at, r.actor_id, r.actor_label,
      r.action, r.outcome, r.target_type, r.target_id, r.reason,
      r.before_state, r.after_state, r.source_ip, r.user_agent, r.correlation_id
    );
    IF recomputed IS DISTINCT FROM r.hash THEN
      RETURN QUERY SELECT r.seq, r.id,
        format('altered entry: contents hash to %s but the row stores %s',
               encode(recomputed, 'hex'), encode(r.hash, 'hex'));
    END IF;

    expected_prev := r.hash;
    expected_seq  := r.seq + 1;
  END LOOP;
END
$fn$;

COMMENT ON FUNCTION app.verify_audit_chain IS
  'Walks the calling tenant chain in order and returns one row per problem: a '
  'sequence gap, a broken link, or an altered entry. No rows = intact.';

-- Locked down: EXECUTE defaults to PUBLIC on new functions, which for the one
-- SECURITY DEFINER write path is exactly what we do not want.
REVOKE ALL ON FUNCTION app.audit_append(text, text, uuid, uuid, text, text, text, text, jsonb, jsonb, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_chain_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.audit_forbid_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.audit_append(text, text, uuid, uuid, text, text, text, text, jsonb, jsonb, inet, text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.verify_audit_chain() TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.audit_entry_hash(bytea, uuid, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, jsonb, inet, text, uuid) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.audit_genesis_hash() TO dpdp_app;

-- Down Migration

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
DROP FUNCTION IF EXISTS app.verify_audit_chain();
DROP FUNCTION IF EXISTS app.audit_append(text, text, uuid, uuid, text, text, text, text, jsonb, jsonb, inet, text);
DROP FUNCTION IF EXISTS app.audit_forbid_mutation();
DROP FUNCTION IF EXISTS app.audit_chain_link();
DROP FUNCTION IF EXISTS app.audit_entry_hash(bytea, uuid, bigint, timestamptz, uuid, text, text, text, text, text, text, jsonb, jsonb, inet, text, uuid);
DROP FUNCTION IF EXISTS app.audit_genesis_hash();
DROP TABLE IF EXISTS audit_log;
