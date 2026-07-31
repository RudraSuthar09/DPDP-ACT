-- FR-DPR-01/02/03/06 — the Data Principal Request Tracker, on top of the shared
-- request substrate (1737001800000_request-substrate.sql).
--
-- Two things happen in this file, and the first one is NOT DPR-specific:
--
--   1. The substrate's SLA policy becomes VERSIONED and KEYED (§1 below). That
--      is a generalisation of Prompt 25's mechanism, not a parallel one.
--   2. DPR's own satellite table, keyed by ticket id (§2), in the exact shape
--      grievance_details established.
--
-- ===========================================================================
-- WHY §1 GENERALISES THE SUBSTRATE INSTEAD OF ADDING A DPR-ONLY CONFIG LAYER
--
-- Prompt 25 shipped `request_sla_policies`: one mutable row per (tenant,
-- request_type), overwritten in place by an UPSERT. That satisfied "deadlines
-- are data" but not "deadlines are VERSIONED configuration records" — after an
-- update, the policy a still-open ticket was filed under existed nowhere. The
-- ticket's own `sla_seconds` snapshot preserved the NUMBER, but not the record:
-- you could see a request was given 30 days, never that 30 days was v2 of the
-- access policy effective from a stated date, nor read v1 to explain a ticket
-- filed the week before. For a regulator asking "under what rule was this
-- judged", the snapshot is an answer without a citation.
--
-- DPR forces the issue for a second reason: it needs a deadline PER RIGHTS
-- TYPE, and `request_type` has only two values. The choice was a DPR-only
-- versioned config table, or generalising the substrate's one.
--
-- Generalising, because the alternative gives the platform two different
-- answers to "what deadline applies here", and Breach — which has the same
-- requirement, per FR-BRC-02 — would make three. What is added is deliberately
-- minimal and DPR-agnostic:
--
--   * `policy_key`: one opaque string the substrate never interprets. Grievance
--     passes '' and behaves exactly as before. DPR passes
--     'dprequest:erasure'. Breach will pass whatever it needs, and nothing in
--     request/* will have to learn what it means.
--   * append-only versions with `effective_from`, so superseding a policy adds
--     v2 and leaves v1 readable forever (I4).
--   * `request_tickets.sla_policy_key` / `sla_policy_version`: the ticket now
--     cites the record it was judged against, not just the number it produced.
--
-- `request_sla_policies` is NOT dropped and its code path is NOT removed. It
-- stays as the resolution fallback below the versions table, so every Prompt 25
-- tenant, ticket and test keeps working untouched — see RequestSlaService.policyFor.
-- ===========================================================================

-- Up Migration

-- ===========================================================================
-- 1. VERSIONED SLA POLICY (substrate-level, not DPR-specific)
-- ===========================================================================
CREATE TABLE request_sla_policy_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant()
                    REFERENCES organisations (id),

  request_type    text NOT NULL CHECK (request_type IN ('grievance', 'dprequest')),

  -- The sub-discriminator, opaque to the substrate. '' means "the whole
  -- request type" and is what Grievance uses; DPR uses 'dprequest:<rightType>'.
  -- Empty string rather than NULL so the UNIQUE below actually constrains it
  -- (NULLs do not collide in Postgres, so a nullable key would happily admit
  -- two v1 base policies).
  policy_key      text NOT NULL DEFAULT '',

  version         int NOT NULL CHECK (version >= 1),

  sla_seconds     int NOT NULL CHECK (sla_seconds BETWEEN 60 AND 31536000),
  ladder          jsonb NOT NULL,

  -- When this version starts to apply. Separate from created_at because
  -- counsel revising a deadline in March for an April rule change is the
  -- normal case, not the exception.
  effective_from  timestamptz NOT NULL DEFAULT now(),

  -- Why. A deadline record with no stated basis is the thing this table exists
  -- to stop being possible.
  note            text,

  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, request_type, policy_key, version)
);

COMMENT ON TABLE request_sla_policy_versions IS
  'Versioned, append-only SLA/statutory-deadline policy records for the shared '
  'request substrate. Supersedes (but does not remove) request_sla_policies: '
  'that table holds one mutable current value per request type, this one holds '
  'the full history per (request_type, policy_key). Rows are never updated or '
  'deleted — superseding a policy inserts the next version (I4). policy_key is '
  'opaque to request/*: Grievance uses '''', DPRequest uses dprequest:<rightType>.';

SELECT app.apply_tenant_rls('public.request_sla_policy_versions');

-- Append-only for real, not by convention: the identical trigger + revoked-grant
-- pair the correspondence and status trails use (app.apply_tenant_rls grants
-- UPDATE by default, so it is taken straight back off). Superseding is an INSERT.
REVOKE UPDATE ON request_sla_policy_versions FROM dpdp_app;
CREATE TRIGGER request_sla_policy_versions_no_mutate
  BEFORE UPDATE OR DELETE ON request_sla_policy_versions
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

CREATE INDEX request_sla_policy_versions_lookup_idx
  ON request_sla_policy_versions (tenant_id, request_type, policy_key, effective_from DESC, version DESC);

-- The ticket cites the record it was judged against.
ALTER TABLE request_tickets
  ADD COLUMN sla_policy_key     text NOT NULL DEFAULT '',
  ADD COLUMN sla_policy_version int;

COMMENT ON COLUMN request_tickets.sla_policy_key IS
  'Which keyed policy this ticket''s clock resolved against. '''' for grievances '
  '(the base policy for the request type); dprequest:<rightType> for rights '
  'requests. Set at intake, never changed.';
COMMENT ON COLUMN request_tickets.sla_policy_version IS
  'The request_sla_policy_versions.version in force when this ticket''s clock '
  'started. NULL means the clock resolved against the legacy '
  'request_sla_policies row or the platform default — the two pre-versioning '
  'sources, kept working rather than back-filled with a version that never existed.';

-- ===========================================================================
-- 2. THE DPR SATELLITE (the grievance_details pattern, second occupant)
-- ===========================================================================
CREATE TABLE dprequest_details (
  ticket_id             uuid PRIMARY KEY REFERENCES request_tickets (id),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant()
                          REFERENCES organisations (id),

  right_type            text NOT NULL CHECK (right_type IN (
                          'access', 'correction', 'erasure', 'nomination',
                          'portability', 'withdraw_consent'
                        )),

  -- ------------------------------------------------------------------------
  -- SUBJECT-REFERENCE RESOLUTION (I2), and why this column is not a
  -- contradiction of request_tickets' "no identifier of the requester in the
  -- client's systems" rule.
  --
  -- What the client supplies during identity verification is the RAW customer
  -- id. It is HMAC'd with the tenant's own secret by the SAME SubjectRefHasher
  -- the Consent module writes every consent event with (FR-CON-04), held in
  -- memory for the length of one request, and discarded. What lands here is
  -- the hex digest — the identical value already stored on consent_events, so
  -- a rights request can be matched to the subject's consent history without
  -- either side ever holding the raw id.
  --
  -- HMAC is one-way: from this column the platform cannot recover the customer
  -- id. The client, who holds the id, can re-derive the ref. That asymmetry IS
  -- I2, and it is the reason this is storable when a customer id is not.
  -- ------------------------------------------------------------------------
  subject_ref           text CHECK (subject_ref ~ '^[0-9a-f]{64}$'),
  subject_ref_resolved_at timestamptz,
  subject_ref_resolved_by uuid REFERENCES users (id),
  -- How many consent records the ref matched. Evidence the resolution actually
  -- found the person, without saying anything about who they are.
  subject_ref_match_count int,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT dprequest_details_subject_ref_complete CHECK (
    (subject_ref IS NULL) = (subject_ref_resolved_at IS NULL)
  )
);

COMMENT ON TABLE dprequest_details IS
  'FR-DPR-01/06 — rights-request-specific fields on top of the shared request '
  'substrate. One row per dprequest ticket, keyed by ticket_id. Never read or '
  'written by backend/src/modules/request/* (R2). subject_ref is an HMAC under '
  'the tenant''s own consent secret — the raw customer id that produced it is '
  'never stored anywhere on this platform (I2).';

SELECT app.apply_tenant_rls('public.dprequest_details');

CREATE INDEX dprequest_details_right_type_idx ON dprequest_details (tenant_id, right_type);
CREATE INDEX dprequest_details_subject_ref_idx ON dprequest_details (tenant_id, subject_ref);

-- ===========================================================================
-- 3. SEED v1 OF THE STATUTORY DEADLINES, per rights type, per existing tenant
--
-- Seeded as real ROWS, not as constants in a service. The prompt's requirement
-- is that these are configuration records, and a record a tenant can read,
-- supersede and cite is the difference between "the platform gave you 30 days"
-- and "you were judged under v1 of the erasure policy, effective 2026-01-01".
--
-- ON THE NUMBERS, honestly: the DPDP Rules set the operative periods and were
-- not final when this was written. 30 days is the working figure for the
-- §11/§12/§14 rights. withdraw_consent gets 7 — §6(4) requires withdrawal to be
-- as easy as giving consent and the cessation to follow "within a reasonable
-- time", and a month is not a reasonable time to keep processing data someone
-- has told you to stop processing. Every one of these is a v1 a tenant's
-- counsel can supersede with v2 the day the Rules land; that is the point of
-- the table.
--
-- The ladder mirrors request-sla-policy.ts's STANDARD_LADDER, in PERCENTAGES,
-- so the same three rungs work for a 7-day withdrawal and a 30-day access
-- request with no second definition.
--
-- Written for tenants that exist NOW. Tenants created later have no rows here
-- and fall through to the substrate default until DPRequestService seeds them
-- on first use (idempotently) — a migration cannot reach into the future.
-- ===========================================================================
INSERT INTO request_sla_policy_versions
  (tenant_id, request_type, policy_key, version, sla_seconds, ladder, effective_from, note)
SELECT o.id,
       'dprequest',
       'dprequest:' || d.right_type,
       1,
       d.days * 86400,
       '[{"level":1,"atPercent":50,"rung":"grievance_officer"},
         {"level":2,"atPercent":80,"rung":"dpo"},
         {"level":3,"atPercent":100,"rung":"escalation_contact"}]'::jsonb,
       now(),
       d.note
  FROM organisations o
 CROSS JOIN (VALUES
    ('access',           30, 'DPDP §11 — response to a request for a summary of personal data.'),
    ('correction',       30, 'DPDP §12 — correction, completion or updating of personal data.'),
    ('erasure',          30, 'DPDP §12(3) — erasure, unless retention is required by law.'),
    ('nomination',       30, 'DPDP §14 — giving effect to a nomination.'),
    ('portability',      30, 'DPDP §11 — machine-readable copy of the personal data summary.'),
    ('withdraw_consent',  7, 'DPDP §6(4)-(6) — cessation of processing after withdrawal must follow within a reasonable time; 7 days, not 30.')
 ) AS d(right_type, days, note)
ON CONFLICT (tenant_id, request_type, policy_key, version) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS dprequest_details;
ALTER TABLE request_tickets
  DROP COLUMN IF EXISTS sla_policy_key,
  DROP COLUMN IF EXISTS sla_policy_version;
DROP TABLE IF EXISTS request_sla_policy_versions;
