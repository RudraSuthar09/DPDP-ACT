-- FR-BRC-01…07 — the Breach Register: incident intake, gated workflow,
-- versioned statutory deadlines, escalating alerts, evidence hashes and a
-- sealed closure packet.
--
-- ===========================================================================
-- SECTION 1 GENERALISES SOMETHING THAT ALREADY EXISTS. READ WHY FIRST.
--
-- Prompt 30 built versioned deadline policies for DPR: append-only rows, an
-- `effective_from`, an opaque `policy_key`, and the version cited on every
-- record judged against it. That is exactly what Breach needs — FR-BRC-02 is
-- where "deadlines are data, not code" was written down in the first place.
--
-- The problem is that it was built INSIDE the request substrate:
-- `request_sla_policy_versions`, with `request_type CHECK IN ('grievance',
-- 'dprequest')`. A breach incident is not a request ticket. It has no portal
-- submission, no OTP, no contact channel — it is an internal incident someone
-- at the Data Fiduciary opens. Three ways to proceed, and only one is honest:
--
--   (a) widen the CHECK to 'breach' and leave the table named `request_*`.
--       Zero risk, and a table whose name says "request" holding incident
--       deadlines is the kind of quiet lie that makes a schema untrustworthy
--       two years later.
--   (b) create `breach_deadline_policy_versions` with the same shape. Two
--       tables, two resolution routines, free to diverge — and the moment they
--       diverge, "which deadline was in force" has two answers.
--   (c) rename it to what it always actually was: a versioned deadline policy
--       register, keyed by DOMAIN and by an opaque key within that domain.
--
-- (c), and the migration below is the rename. Prompt 30's own header predicted
-- it: "Breach will pass whatever it needs, and nothing in request/* will have
-- to learn what it means." Nothing about the mechanism changes — same columns,
-- same append-only trigger, same resolution rule, same citation on the record.
-- What changes is that it is no longer pretending to belong to one module.
--
-- No data moves. Existing grievance/dprequest rows keep their ids, versions and
-- effective_from; `request_type` becomes `policy_domain` with the same values.
-- ===========================================================================

-- Up Migration

ALTER TABLE request_sla_policy_versions RENAME TO deadline_policy_versions;
ALTER TABLE deadline_policy_versions RENAME COLUMN request_type TO policy_domain;

ALTER TABLE deadline_policy_versions DROP CONSTRAINT request_sla_policy_versions_request_type_check;
ALTER TABLE deadline_policy_versions ADD CONSTRAINT deadline_policy_versions_domain_check
  CHECK (policy_domain IN ('grievance', 'dprequest', 'breach'));

ALTER INDEX request_sla_policy_versions_lookup_idx RENAME TO deadline_policy_versions_lookup_idx;
ALTER TRIGGER request_sla_policy_versions_no_mutate ON deadline_policy_versions
  RENAME TO deadline_policy_versions_no_mutate;

COMMENT ON TABLE deadline_policy_versions IS
  'Versioned, append-only statutory/SLA deadline records for every module that '
  'has deadlines — Grievance, DPRequest and Breach (FR-BRC-02, FR-DPR-03). '
  'Rows are never updated or deleted: superseding a policy INSERTs the next '
  'version (I4). policy_domain says which module; policy_key is opaque to the '
  'resolver — '''' for a domain default, dprequest:<rightType>, '
  'breach:<gate>. Formerly request_sla_policy_versions; renamed when Breach '
  'became the third caller and the request-substrate name stopped being true.';

COMMENT ON COLUMN deadline_policy_versions.policy_domain IS
  'Which module''s deadlines these are. Formerly request_type.';

-- ===========================================================================
-- 2. THE INCIDENT
--
-- WHAT IT STORES AND WHAT IT MUST NOT. An incident record describes an EVENT
-- and the organisation's response to it: what happened, when it was found, how
-- bad, which of the tenant's OWN systems and data categories were involved.
-- None of that is a customer record.
--
-- What it deliberately has no column for is the affected people. Not names, not
-- a list of ids, not an exported set of rows "for the notification". A breach
-- register that accumulated the identities of everyone affected by every
-- incident would be the single most sensitive table in the product and would
-- end I1 outright. `estimated_affected_count` is a NUMBER, and the notification
-- templates in FR-BRC-06 are addressed by the client's own systems, from the
-- client's own data, exactly as Tier 2 of the Personal Data Summary is.
-- ===========================================================================
CREATE TABLE breach_incidents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL DEFAULT app.current_tenant()
                             REFERENCES organisations (id),

  reference_code           text NOT NULL,
  title                    text NOT NULL,
  what_happened            text NOT NULL,

  -- DISCOVERY is the clock's anchor, not row creation. An incident found on
  -- Monday and logged on Wednesday is two days into its statutory window, not
  -- starting fresh — backdating the anchor is the whole reason this is a
  -- separate, required column rather than created_at.
  discovered_at            timestamptz NOT NULL,
  -- When it actually happened, if known. Often unknown, hence nullable, and
  -- never used for deadlines — no statute runs from a date you inferred later.
  occurred_at              timestamptz,

  -- Free text by design: these are the tenant's infrastructure names, which the
  -- platform has no register of. Contrast the data categories in §3, which the
  -- platform DOES hold and therefore must reference rather than re-type.
  systems_affected         text[] NOT NULL DEFAULT '{}',

  estimated_affected_count int CHECK (estimated_affected_count >= 0),
  severity                 text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  current_gate             text NOT NULL DEFAULT 'acknowledge'
                             CHECK (current_gate IN ('acknowledge', 'assess',
                                                     'notify_data_principals', 'notify_board',
                                                     'remediate', 'rca', 'closure')),
  status                   text NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'closed')),

  closed_at                timestamptz,
  closure_signed_off_by    uuid REFERENCES users (id),
  closure_note             text,

  opened_by                uuid REFERENCES users (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE breach_incidents IS
  'FR-BRC-01 — one row per personal-data breach incident. Describes the event '
  'and the response, never the people affected: there is no column for a '
  'name, an identifier, or an exported row set, and estimated_affected_count '
  'is a count (I1). Deadlines run from discovered_at, never created_at.';

SELECT app.apply_tenant_rls('public.breach_incidents');
CREATE INDEX breach_incidents_status_idx ON breach_incidents (tenant_id, status, discovered_at DESC);
CREATE TRIGGER breach_incidents_touch_updated_at
  BEFORE UPDATE ON breach_incidents FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ===========================================================================
-- 3. WHICH DATA CATEGORIES WERE INVOLVED — REFERENCED, NOT RE-TYPED
--
-- A foreign key to inventory_register_entries, not a text column. The
-- difference is the whole point of having a Data Inventory: an incident that
-- says "customer contact details" as free text is an assertion, while one
-- pointing at register entry #7 inherits that entry's purposes, legal bases,
-- retention and downstream systems — which is what makes an assessment and a
-- regulator report auto-populatable at all (FR-BRC-06).
--
-- It also means the two registers cannot drift: rename the category in the
-- inventory and every incident referencing it reads the new name, because it
-- never held a copy.
-- ===========================================================================
CREATE TABLE breach_incident_categories (
  incident_id  uuid NOT NULL REFERENCES breach_incidents (id),
  entry_id     uuid NOT NULL REFERENCES inventory_register_entries (id),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant()
                 REFERENCES organisations (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, entry_id)
);

COMMENT ON TABLE breach_incident_categories IS
  'FR-BRC-01 — which Data Inventory entries this incident touched. A reference, '
  'never a copied category name, so an incident inherits the entry''s purposes, '
  'legal basis, retention and systems for assessment and reporting (FR-BRC-06).';

SELECT app.apply_tenant_rls('public.breach_incident_categories');

-- ===========================================================================
-- 4. THE GATED WORKFLOW (FR-BRC-03) — append-only
--
-- One row per gate PASSED. Not a status column that gets overwritten: "we
-- notified the Board at 14:02 on the 3rd, and Meera signed it off" is the
-- evidence, and evidence is not something a later UPDATE gets to revise (I4).
-- The incident's `current_gate` is a convenience projection of the newest row
-- here; this table is the record of fact.
-- ===========================================================================
CREATE TABLE breach_gate_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),
  incident_id   uuid NOT NULL REFERENCES breach_incidents (id),

  gate          text NOT NULL CHECK (gate IN ('acknowledge', 'assess',
                                              'notify_data_principals', 'notify_board',
                                              'remediate', 'rca', 'closure')),
  -- What the person actually did and found. This is the substance a regulator
  -- reads; a gate passed with no account of it is a checkbox, not evidence.
  notes         text NOT NULL,
  completed_by  uuid REFERENCES users (id),
  completed_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, incident_id, gate)
);

COMMENT ON TABLE breach_gate_events IS
  'FR-BRC-03 — one append-only row per workflow gate passed. Never updated, '
  'never deleted; the UNIQUE constraint makes passing a gate twice impossible '
  'rather than merely discouraged.';

SELECT app.apply_tenant_rls('public.breach_gate_events');
REVOKE UPDATE ON breach_gate_events FROM dpdp_app;
CREATE TRIGGER breach_gate_events_no_mutate
  BEFORE UPDATE OR DELETE ON breach_gate_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE INDEX breach_gate_events_incident_idx ON breach_gate_events (tenant_id, incident_id, completed_at);

-- ===========================================================================
-- 5. PER-GATE DEADLINES AND THEIR ESCALATIONS
--
-- Structurally the same as request_sla_timers, and for the same reasons — see
-- that table's comments. One row per scheduled deadline, carrying what the
-- deadline MEANS and a snapshot of who to tell; the WorkflowRunner (S3) owns
-- "has this moment arrived" and the two meet only on workflow_id.
--
-- Different from the request substrate in one way that matters: a request has
-- ONE deadline with a ladder of warnings inside it. An incident has SEVERAL
-- independent statutory deadlines running at once — notify the Board within
-- 72h, notify Data Principals within 72h, remediate within 30 days — each with
-- its own ladder. So the gate is part of the key.
-- ===========================================================================
CREATE TABLE breach_deadlines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  incident_id    uuid NOT NULL REFERENCES breach_incidents (id),

  gate           text NOT NULL,
  -- The versioned record this deadline was computed from — the citation, so an
  -- incident judged last March can be explained against the policy that was in
  -- force last March and not against today's.
  policy_key     text NOT NULL,
  policy_version int,
  due_at         timestamptz NOT NULL,

  level          int NOT NULL,
  rung           text NOT NULL CHECK (rung IN ('grievance_officer', 'dpo', 'escalation_contact')),
  trigger_reason text NOT NULL CHECK (trigger_reason IN ('sla_proximity', 'sla_breach')),
  workflow_id    text NOT NULL,

  notify_user_id uuid REFERENCES users (id),
  notify_contact text,

  status         text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'fired', 'cancelled')),
  fired_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, incident_id, gate, level)
);

COMMENT ON TABLE breach_deadlines IS
  'FR-BRC-04 — the escalation ladder scheduled for each of an incident''s gates. '
  'Mirrors request_sla_timers: the domain''s record of what a deadline means, '
  'joined to the S3 deadline register only on workflow_id. Unlike a request, an '
  'incident runs several statutory clocks at once, so gate is part of the key.';

SELECT app.apply_tenant_rls('public.breach_deadlines');
CREATE INDEX breach_deadlines_workflow_idx ON breach_deadlines (workflow_id);
CREATE INDEX breach_deadlines_incident_idx ON breach_deadlines (tenant_id, incident_id, due_at);

CREATE TABLE breach_escalations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  incident_id       uuid NOT NULL REFERENCES breach_incidents (id),

  gate              text NOT NULL,
  level             int NOT NULL,
  rung              text NOT NULL,
  trigger_reason    text NOT NULL CHECK (trigger_reason IN ('sla_proximity', 'sla_breach', 'manual')),
  notified_user_id  uuid REFERENCES users (id),
  notified_contact  text,
  notified_ok       boolean,
  reason            text NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),

  -- Idempotency at the database, exactly as request_escalations does it: a
  -- deadline delivered twice (pg-boss plus the reconciliation ticker can both
  -- see it) escalates once.
  UNIQUE (tenant_id, incident_id, gate, level)
);

COMMENT ON TABLE breach_escalations IS
  'FR-BRC-04 — the append-only trail of escalations raised on an incident. '
  'NOTE: escalations raised by a FIRED DEADLINE are recorded here but are NOT '
  'in the S5 hash chain — the worker has no HTTP request and the audit sink has '
  'exactly one writer (R3). Identical gap to request_escalations; see '
  'breach-escalation.service.ts, which names it rather than papering over it.';

SELECT app.apply_tenant_rls('public.breach_escalations');
REVOKE UPDATE ON breach_escalations FROM dpdp_app;
CREATE TRIGGER breach_escalations_no_mutate
  BEFORE UPDATE OR DELETE ON breach_escalations
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();

-- ===========================================================================
-- 6. EVIDENCE — THE HASH, NEVER THE FILE (FR-BRC-05)
--
-- The same rule ImportEvidenceStore already established for CSV imports, and
-- for a sharper reason here: breach evidence is a forensic log, a screenshot of
-- an exposed record, a database export. Those are the MOST likely files in the
-- entire product to contain real personal data, so storing them is exactly the
-- thing that must not happen (I1/R6).
--
-- The bytes are hashed in memory and discarded. What remains is a SHA-256, a
-- filename, a size and a description — enough to prove later that a specific
-- file was the one submitted, provided the tenant still holds it. The platform
-- attests; it does not archive.
-- ===========================================================================
CREATE TABLE breach_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant()
                 REFERENCES organisations (id),
  incident_id  uuid NOT NULL REFERENCES breach_incidents (id),

  file_name    text NOT NULL,
  content_type text,
  size_bytes   int NOT NULL CHECK (size_bytes >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  description  text,

  uploaded_by  uuid REFERENCES users (id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE breach_evidence IS
  'FR-BRC-05 — evidence ATTESTATION, not evidence storage. Holds a SHA-256 of '
  'the submitted bytes plus its metadata; the bytes themselves are hashed in '
  'memory and discarded, never written anywhere (I1) — breach evidence is the '
  'likeliest file in the product to contain real personal data.';

SELECT app.apply_tenant_rls('public.breach_evidence');
REVOKE UPDATE ON breach_evidence FROM dpdp_app;
CREATE TRIGGER breach_evidence_no_mutate
  BEFORE UPDATE OR DELETE ON breach_evidence
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE INDEX breach_evidence_incident_idx ON breach_evidence (tenant_id, incident_id, uploaded_at);

-- ===========================================================================
-- 7. SEED v1 OF EACH GATE'S DEADLINE, PER EXISTING TENANT
--
-- Real records, not constants — same reasoning as the DPR seed. A tenant can
-- read them, supersede them, and cite the version an incident was judged under.
--
-- ON THE NUMBERS, honestly: DPDP §8(6) requires notifying the Board and each
-- affected Data Principal of a breach, and the Rules set the operative form and
-- period. 72 hours is the working figure for both notifications (the widely
-- expected period, and the one the draft Rules use for the detailed report);
-- everything else here is an internal service level rather than a statute —
-- acknowledge and assess exist to make the 72-hour clock survivable, and
-- remediate/RCA/closure are the organisation's own discipline. All are v1, all
-- overridable, none of them hardcoded anywhere in TypeScript.
--
-- All run from discovered_at. The ladder is in PERCENTAGES, so the same three
-- rungs work unchanged for a 6-hour acknowledgement and a 45-day closure.
-- ===========================================================================
INSERT INTO deadline_policy_versions
  (tenant_id, policy_domain, policy_key, version, sla_seconds, ladder, effective_from, note)
SELECT o.id, 'breach', 'breach:' || g.gate, 1, g.secs,
       '[{"level":1,"atPercent":50,"rung":"grievance_officer"},
         {"level":2,"atPercent":80,"rung":"dpo"},
         {"level":3,"atPercent":100,"rung":"escalation_contact"}]'::jsonb,
       now(), g.note
  FROM organisations o
 CROSS JOIN (VALUES
    ('acknowledge',            6 * 3600, 'Internal: an incident must be owned within 6 hours of discovery. Not statutory — this is what makes the 72-hour clock survivable.'),
    ('assess',                24 * 3600, 'Internal: scope, categories and severity assessed within 24 hours, so the notification decision rests on findings rather than guesswork.'),
    ('notify_data_principals', 72 * 3600, 'DPDP §8(6) — each affected Data Principal must be informed of a personal data breach. 72 hours from discovery.'),
    ('notify_board',           72 * 3600, 'DPDP §8(6) — the Data Protection Board must be notified of a personal data breach. 72 hours from discovery.'),
    ('remediate',        30 * 24 * 3600, 'Internal: containment and remediation completed within 30 days of discovery.'),
    ('rca',              30 * 24 * 3600, 'Internal: root-cause analysis documented within 30 days of discovery.'),
    ('closure',          45 * 24 * 3600, 'Internal: incident signed off and closed within 45 days of discovery.')
 ) AS g(gate, secs, note)
ON CONFLICT (tenant_id, policy_domain, policy_key, version) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS breach_evidence;
DROP TABLE IF EXISTS breach_escalations;
DROP TABLE IF EXISTS breach_deadlines;
DROP TABLE IF EXISTS breach_gate_events;
DROP TABLE IF EXISTS breach_incident_categories;
DROP TABLE IF EXISTS breach_incidents;

DELETE FROM deadline_policy_versions WHERE policy_domain = 'breach';
ALTER TRIGGER deadline_policy_versions_no_mutate ON deadline_policy_versions
  RENAME TO request_sla_policy_versions_no_mutate;
ALTER INDEX deadline_policy_versions_lookup_idx RENAME TO request_sla_policy_versions_lookup_idx;
ALTER TABLE deadline_policy_versions DROP CONSTRAINT deadline_policy_versions_domain_check;
ALTER TABLE deadline_policy_versions RENAME COLUMN policy_domain TO request_type;
ALTER TABLE deadline_policy_versions RENAME TO request_sla_policy_versions;
ALTER TABLE request_sla_policy_versions ADD CONSTRAINT request_sla_policy_versions_request_type_check
  CHECK (request_type IN ('grievance', 'dprequest'));
