-- The SHARED REQUEST SUBSTRATE — the foundation both the Grievance Register
-- (complaints, DPDP §13, FR-GRV-01/03/04/05) and the Data Principal Request
-- Tracker (rights requests, §§11-14, FR-DPR) sit on. CLAUDE.md: "They share one
-- substrate — portal, OTP, identity-verification handoff, ticketing, SLA timers,
-- webhooks — so DPRequest is a specialised workflow on shared foundations, not a
-- second ticketing system."
--
-- Everything here is deliberately GENERIC. The word is "request", never
-- "grievance": a ticket carries a `request_type` discriminator and nothing else
-- that either module would recognise as its own. Complaint categories, rights
-- types, the two-tier Personal Data Summary — none of that belongs in this
-- migration, and adding it here is how a shared substrate becomes one module's
-- table that another module has to work around.
--
-- ===========================================================================
-- THE ONE ARCHITECTURAL IDEA IN THIS FILE: THE IDENTITY-VERIFICATION HANDOFF
--
-- FR-GRV-04. A person submits a request from a public page with no login. Two
-- completely different questions have to be answered before anyone acts on it:
--
--   1. "Did this email address / phone number really receive this message?"
--      — a fact about a CHANNEL. The platform can answer it: send a one-time
--        code, see it come back. That is `request_contact_verifications`.
--
--   2. "Is the person behind that channel actually a customer of this Data
--      Fiduciary, and which one?"
--      — a fact about a PERSON, answerable only against the client's own
--        customer records. The platform must NEVER answer this. It holds no
--        customer records (I1), and it must not start holding them in order to
--        match one. So it does not try: it creates a TASK
--        (`request_identity_verifications`), hands that task to the tenant's own
--        staff, and records only their VERDICT (matched / not matched /
--        inconclusive) plus their reason. The customer id they matched against
--        stays on their side of the line, permanently.
--
-- The lifecycle makes this an explicit STATE, not an assumption:
--
--   created -> contact_verified -> pending_identity_verification
--           -> assigned -> in_progress -> resolved -> closed
--
-- `pending_identity_verification` exists precisely so that "the platform is
-- waiting for a human at the client to do the thing the platform is not allowed
-- to do" is a visible, queryable, SLA-bound state rather than a gap between two
-- other states that everyone assumes someone handled.
-- ===========================================================================
--
-- SEAM S3 (WorkflowRunner) owns every clock in here. There is no `run_at`
-- column the application polls and no `if (daysSince > 3)` anywhere: the ticket
-- records WHICH deadlines it asked for (`request_sla_timers`) and the runner
-- owns WHEN they fire. See the header of request_sla_timers for why the ladder
-- is scheduled as N independent deadlines up front rather than one that
-- reschedules itself.
--
-- Up Migration

-- ===========================================================================
-- 1. THE PUBLIC TENANT IDENTIFIER (portal_slug)
--
-- A public portal URL has to name a tenant before anybody has authenticated:
-- /portal/acme-health-3f9c21/requests. Nothing in the platform could do that
-- yet — every existing tenant identifier is either the raw tenant uuid (an
-- internal key we do not want in URLs people paste into emails) or a
-- credential.
--
-- PATH-BASED SLUG, NOT SUBDOMAIN. A subdomain (acme.portal.dpdp.example) would
-- need wildcard DNS, a wildcard TLS certificate, and host-based routing that
-- differs between local dev, CI, and production — three pieces of environment
-- infrastructure bought for zero functional gain, which is exactly what R1
-- forbids without a trigger metric. A path segment works identically in every
-- environment and needs nothing. If a tenant ever demands a vanity domain, that
-- is a routing layer in front of this, not a change to this column.
--
-- THIS IS AN IDENTIFIER, NOT A CREDENTIAL — AND THE DIFFERENCE IS THE POINT.
--
-- The Consent SDK's public API key (1737001700000) is a credential: presenting
-- it AUTHORISES writes to the consent register, so it is stored hashed, shown
-- once, and revocable. The portal slug is the opposite kind of thing. It names
-- a tenant so a public page can be rendered; it authorises nothing. Knowing a
-- slug lets you do precisely what any member of the public is supposed to be
-- able to do — see who the Grievance Officer is and file a request — and every
-- one of those actions is independently rate-limited and OTP-gated. It is
-- stored in the clear, it appears in URLs, and it must never be checked as
-- though possession of it proved anything. The two resolution paths are kept
-- physically separate (app.resolve_portal_slug here vs
-- app.resolve_public_api_key there) so that no future edit can quietly make one
-- behave like the other.
--
-- The 6-hex suffix is not a secret and is not there for security. It is there
-- so slugs are collision-free without a retry loop, and so a competitor cannot
-- derive a tenant's portal URL by guessing at their company name.
-- ===========================================================================

ALTER TABLE organisations ADD COLUMN portal_slug text;

CREATE FUNCTION app.mint_portal_slug(p_name text, p_id uuid) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $fn$
  SELECT COALESCE(
           NULLIF(left(trim(BOTH '-' FROM regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), 40), ''),
           'org'
         )
         || '-' || left(encode(sha256(convert_to(p_id::text, 'UTF8')), 'hex'), 6);
$fn$;

COMMENT ON FUNCTION app.mint_portal_slug(text, uuid) IS
  'Derives a tenant public portal slug from its name plus a 6-hex digest of its '
  'id. The suffix prevents collisions and name-guessing; it is NOT a secret and '
  'the slug is NOT a credential — see the header of this migration.';

-- Backfill before the NOT NULL.
--
-- The NO FORCE window is not optional and not cosmetic. `organisations` is
-- FORCE ROW LEVEL SECURITY, and FORCE means the policy applies to the TABLE
-- OWNER too — which is who runs migrations. With no app.current_tenant GUC set,
-- `tenant_id = app.current_tenant()` is never true, so a bare `UPDATE
-- organisations SET ...` here matches ZERO rows and reports success. The
-- migration would then hit `SET NOT NULL` on a column it believes it just
-- filled. (It did, once, which is why this comment exists.) Dropping FORCE for
-- the duration lets the owner see every tenant for exactly this one backfill;
-- it is restored on the next line.
ALTER TABLE organisations NO FORCE ROW LEVEL SECURITY;
UPDATE organisations SET portal_slug = app.mint_portal_slug(name, id) WHERE portal_slug IS NULL;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;

ALTER TABLE organisations ALTER COLUMN portal_slug SET NOT NULL;
CREATE UNIQUE INDEX organisations_portal_slug_unique ON organisations (portal_slug);

COMMENT ON COLUMN organisations.portal_slug IS
  'The tenant public identifier used to route /portal/:slug/*. An IDENTIFIER, '
  'never a credential: it authorises nothing and is stored in the clear.';

-- Minted by trigger, so organisation sign-up (FR-IDN-01) needs no change and no
-- future insert path can forget it.
CREATE FUNCTION app.organisations_set_portal_slug() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF NEW.portal_slug IS NULL THEN
    NEW.portal_slug := app.mint_portal_slug(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER organisations_portal_slug
  BEFORE INSERT ON organisations
  FOR EACH ROW EXECUTE FUNCTION app.organisations_set_portal_slug();

-- ---------------------------------------------------------------------------
-- The pre-tenant peephole: slug -> tenant. Same chicken-and-egg as login and as
-- the SDK API key — the answer IS the tenant, so the question cannot be asked
-- under a tenant's RLS. And the same trap: `organisations` is FORCE ROW LEVEL
-- SECURITY, so a SECURITY DEFINER function reading it directly would run as the
-- owner, find no tenant GUC, and silently return ZERO rows. Hence a shadow
-- table, exactly like app.user_directory and app.api_key_directory.
--
-- Note what it returns: tenant id and display name, and nothing else. The
-- portal page needs to say "you are filing a request with Acme Health Ltd";
-- it needs no other fact about the tenant, so no other fact leaves this
-- function.
-- ---------------------------------------------------------------------------
CREATE TABLE app.org_directory (
  portal_slug text PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.org_directory IS
  'portal_slug -> (tenant_id, name). Deliberately NOT row-level-secured and NOT '
  'granted to dpdp_app: reachable only via app.resolve_portal_slug(). '
  'Maintained by trigger from public.organisations. Sibling of '
  'app.user_directory and app.api_key_directory. See Seam S1.';

-- NO GRANTS TO dpdp_app ON THIS TABLE. The omission is the control.

CREATE FUNCTION app.sync_org_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  INSERT INTO app.org_directory (portal_slug, tenant_id, name)
  VALUES (NEW.portal_slug, NEW.id, NEW.name)
  ON CONFLICT (portal_slug) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, updated_at = now();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER organisations_sync_directory
  AFTER INSERT OR UPDATE ON organisations
  FOR EACH ROW EXECUTE FUNCTION app.sync_org_directory();

-- Seed for tenants that already existed. Same NO FORCE window, same reason as
-- the backfill above: the SELECT would otherwise see none of them.
ALTER TABLE organisations NO FORCE ROW LEVEL SECURITY;
INSERT INTO app.org_directory (portal_slug, tenant_id, name)
  SELECT portal_slug, id, name FROM organisations
  ON CONFLICT (portal_slug) DO NOTHING;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.resolve_portal_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, name text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.name FROM app.org_directory d WHERE d.portal_slug = p_slug;
$fn$;

COMMENT ON FUNCTION app.resolve_portal_slug(text) IS
  'The public-portal peephole: exact slug -> (tenant_id, display name). Exact '
  'match only, no listing, no pattern matching. Resolving a slug ESTABLISHES '
  'WHICH TENANT a public page is about; it AUTHORISES NOTHING — unlike '
  'app.resolve_public_api_key, whose input is a credential.';

REVOKE ALL ON FUNCTION app.sync_org_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_portal_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_portal_slug(text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.mint_portal_slug(text, uuid) TO dpdp_app;

-- ===========================================================================
-- 2. THE THIRD RUNG OF THE ESCALATION LADDER
--
-- org_designations (FR-IDN-04) already names THE DPO and THE Grievance Officer.
-- The ladder needs one more rung above them — the person a request escalates to
-- when the DPO has not resolved it either. It is the same KIND of fact (a single
-- named point of contact per tenant), so it belongs in the same table rather
-- than in a request-module table that would duplicate it.
-- ===========================================================================
ALTER TABLE org_designations DROP CONSTRAINT org_designations_designation_check;
ALTER TABLE org_designations ADD CONSTRAINT org_designations_designation_check
  CHECK (designation IN ('dpo', 'grievance_officer', 'escalation_contact'));

-- ===========================================================================
-- 3. SLA POLICY — "deadlines are data, not code"
--
-- The same rule FR-BRC-02 states for breach timelines, applied here: no
-- statutory or contractual interval is ever written as a number in a controller.
-- A tenant's policy is a row; the platform default is a value in one named place
-- in code (request-sla-policy.ts) used only when a tenant has not set one.
--
-- `ladder` is the escalation ladder as data too: an ordered list of
--   { level, atPercent, rung }
-- so "escalate to the DPO at 80% of the SLA" is configuration, not an `if`.
-- ===========================================================================
CREATE TABLE request_sla_policies (
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),
  request_type  text NOT NULL CHECK (request_type IN ('grievance', 'dprequest')),

  sla_seconds   int NOT NULL CHECK (sla_seconds BETWEEN 60 AND 31536000),

  -- [{"level":1,"atPercent":50,"rung":"grievance_officer"}, ...] — validated in
  -- the application (a jsonb CHECK complex enough to validate this would be a
  -- second, divergent copy of the rule).
  ladder        jsonb NOT NULL,

  updated_by    uuid REFERENCES users (id),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, request_type)
);

COMMENT ON TABLE request_sla_policies IS
  'Per-tenant, per-request-type SLA duration and escalation ladder. Deadlines '
  'are DATA (FR-BRC-02 reasoning, applied to requests): no interval is ever '
  'hardcoded in a controller. Absent row = the platform default.';

SELECT app.apply_tenant_rls('public.request_sla_policies');

-- ===========================================================================
-- 4. THE TICKET
--
-- Generic on purpose. What is here is true of ANY request from a member of the
-- public: who to reach, whether that channel is proven, where it is in the
-- lifecycle, who owns it, when it is due. What is NOT here: anything either
-- module would call its own.
--
-- WHAT IT DELIBERATELY DOES NOT STORE: any identifier of the requester in the
-- client's systems. Not a customer id, not an account number, not a
-- pseudonymised ref. The staff verdict in request_identity_verifications says
-- "yes, we matched this person" and stops there (I1).
--
-- WHAT IT DOES STORE, and why that is not a contradiction: the contact channel
-- the requester typed in themselves, plus their own words. That is not a
-- customer record lifted from the client's database — it is data a person gave
-- the platform directly, and the platform cannot send an OTP or a reply without
-- it. CLAUDE.md is explicit that grievance correspondence IS personal data and
-- that we are a Data Processor holding it; it lives here under RLS, in the
-- audit trail's retention regime, and nowhere else.
-- ===========================================================================
CREATE TABLE request_tickets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL DEFAULT app.current_tenant()
                         REFERENCES organisations (id),

  -- The discriminator, and the ONLY thing in this table that knows two kinds of
  -- request exist. It doubles as the WorkflowKind for every deadline this ticket
  -- schedules (Seam S3 already has exactly these two among its three kinds).
  request_type         text NOT NULL CHECK (request_type IN ('grievance', 'dprequest')),

  -- What the requester is told to quote. Human-shaped and unguessable-adjacent,
  -- but NOT a credential: reading a ticket needs the OTP-issued portal token.
  reference_code       text NOT NULL,

  status               text NOT NULL DEFAULT 'created'
                         CHECK (status IN ('created', 'contact_verified',
                                           'pending_identity_verification',
                                           'assigned', 'in_progress',
                                           'resolved', 'closed')),

  subject              text NOT NULL,

  contact_channel      text NOT NULL CHECK (contact_channel IN ('email', 'sms')),
  contact_value        text NOT NULL,
  contact_verified_at  timestamptz,

  -- How far up the ladder this has climbed. Deliberately NOT a status: a ticket
  -- can be in_progress AND escalated, and collapsing the two would make one
  -- unrepresentable.
  escalation_level     int NOT NULL DEFAULT 0,

  assigned_to          uuid REFERENCES users (id),

  -- The SLA as it was when the clock started — a snapshot, not a live lookup.
  -- Changing the policy tomorrow must not silently move yesterday's deadline
  -- (I4: what a ticket was judged against is itself evidence).
  sla_seconds          int,
  sla_started_at       timestamptz,
  sla_due_at           timestamptz,

  resolution           text,

  -- Provenance of the anonymous submission. An IP is personal data and is
  -- stored for the same reason the audit log stores one: a public,
  -- unauthenticated intake with no provenance is not evidence.
  submitted_ip         inet,
  submitted_user_agent text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,

  CONSTRAINT request_tickets_reference_unique UNIQUE (tenant_id, reference_code)
);

COMMENT ON TABLE request_tickets IS
  'The shared request ticket behind BOTH the Grievance Register (FR-GRV) and '
  'the Data Principal Request Tracker (FR-DPR). Generic by design: '
  'module-specific fields belong to those modules, never here. Stores the '
  'requester contact channel (needed to send an OTP and to reply) and NEVER any '
  'identifier of them in the client systems (I1).';

SELECT app.apply_tenant_rls('public.request_tickets');

CREATE INDEX request_tickets_status_idx ON request_tickets (tenant_id, status, created_at DESC);
CREATE INDEX request_tickets_type_idx ON request_tickets (tenant_id, request_type, created_at DESC);
CREATE INDEX request_tickets_assigned_idx ON request_tickets (tenant_id, assigned_to)
  WHERE assigned_to IS NOT NULL;
-- The rate limiter's durable backstop: "how many has this contact filed lately?"
CREATE INDEX request_tickets_contact_idx ON request_tickets (tenant_id, contact_value, created_at DESC);

-- ===========================================================================
-- 5. THE APPEND-ONLY TRAILS (I4)
--
-- Three tables, one rule: nothing in them is ever edited or deleted. Enforced
-- the same way audit_log and consent_events enforce it — a trigger that fires
-- for the table owner and for a superuser too, plus a REVOKE so dpdp_app could
-- not try even if the trigger were dropped. app.apply_tenant_rls() grants
-- UPDATE by default (most tables want it), so each of these takes it straight
-- back off.
--
-- These are NOT a second audit log (that would be R3). audit_log records the
-- REQUEST that caused a change — actor, correlation id, before/after, chained.
-- These record the DOMAIN CONTENT the audit log deliberately does not carry:
-- the words of a complaint, the sequence a ticket moved through, which rung was
-- notified. The audit entry is the proof it happened; this is the thing itself.
-- ===========================================================================

-- 5a. The lifecycle trail. Every transition, in order, with who and why.
CREATE TABLE request_status_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),
  ticket_id     uuid NOT NULL REFERENCES request_tickets (id),

  from_status   text,
  to_status     text NOT NULL,

  -- Who moved it. 'public_submitter' is a real, first-class actor here: the
  -- requester verifying their OTP is what moves created -> contact_verified.
  actor_type    text NOT NULL CHECK (actor_type IN ('public_submitter', 'staff', 'system')),
  actor_user_id uuid REFERENCES users (id),
  reason        text NOT NULL,

  occurred_at   timestamptz NOT NULL DEFAULT now()
);

SELECT app.apply_tenant_rls('public.request_status_events');
REVOKE UPDATE ON request_status_events FROM dpdp_app;
CREATE TRIGGER request_status_events_no_mutate
  BEFORE UPDATE OR DELETE ON request_status_events
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE INDEX request_status_events_ticket_idx
  ON request_status_events (tenant_id, ticket_id, occurred_at);

-- 5b. The correspondence trail (FR-GRV-05). Never edited, never deleted — a
--     complaint you can quietly reword afterwards is not evidence of anything.
CREATE TABLE request_correspondence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  ticket_id      uuid NOT NULL REFERENCES request_tickets (id),

  direction      text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal_note')),
  author_type    text NOT NULL CHECK (author_type IN ('public_submitter', 'staff', 'system')),
  author_user_id uuid REFERENCES users (id),
  -- What we know about an author who has no user row — the same job actor_label
  -- does in audit_log.
  author_label   text,

  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE request_correspondence IS
  'FR-GRV-05: the append-only correspondence trail on a request. The public '
  'submission itself is the first inbound entry — which is why the ticket table '
  'has no body column. Never edited, never deleted (I4).';

SELECT app.apply_tenant_rls('public.request_correspondence');
REVOKE UPDATE ON request_correspondence FROM dpdp_app;
CREATE TRIGGER request_correspondence_no_mutate
  BEFORE UPDATE OR DELETE ON request_correspondence
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE INDEX request_correspondence_ticket_idx
  ON request_correspondence (tenant_id, ticket_id, created_at);

-- 5c. The escalation trail. One row per rung actually reached.
CREATE TABLE request_escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.current_tenant()
                     REFERENCES organisations (id),
  ticket_id        uuid NOT NULL REFERENCES request_tickets (id),

  level            int NOT NULL CHECK (level >= 1),
  rung             text NOT NULL
                     CHECK (rung IN ('grievance_officer', 'dpo', 'escalation_contact')),
  trigger_reason   text NOT NULL
                     CHECK (trigger_reason IN ('sla_proximity', 'sla_breach', 'manual')),

  notified_user_id uuid REFERENCES users (id),
  notified_contact text,
  -- Whether the notification actually went out. An escalation that happened but
  -- could not be delivered is a different fact from one that was delivered, and
  -- the difference is exactly what an auditor asks about.
  notified_ok      boolean,
  reason           text,

  occurred_at      timestamptz NOT NULL DEFAULT now(),

  -- Makes escalation idempotent at the DATABASE, not in a handler's memory: a
  -- duplicate deadline delivery cannot escalate the same rung twice.
  CONSTRAINT request_escalations_level_unique UNIQUE (tenant_id, ticket_id, level)
);

SELECT app.apply_tenant_rls('public.request_escalations');
REVOKE UPDATE ON request_escalations FROM dpdp_app;
CREATE TRIGGER request_escalations_no_mutate
  BEFORE UPDATE OR DELETE ON request_escalations
  FOR EACH ROW EXECUTE FUNCTION app.forbid_mutation();
CREATE INDEX request_escalations_ticket_idx
  ON request_escalations (tenant_id, ticket_id, level);

-- ===========================================================================
-- 6. CONTACT-CHANNEL VERIFICATION (the OTP) — question 1 of the handoff
--
-- Proves ownership of a CHANNEL and nothing more. Note what is stored: a hash
-- of the code, never the code. A six-digit code next to a known ticket id would
-- take a laptop about a second to brute-force from a database dump, so the hash
-- is HMAC'd with a server-side secret that lives in the environment, not the
-- database — a dump alone yields nothing.
--
-- This table is mutable (attempts, consumed_at), unlike the trails above: it is
-- working state, not evidence. The evidence that a channel was verified is the
-- ticket status transition, which IS in an append-only trail.
-- ===========================================================================
CREATE TABLE request_contact_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant()
                 REFERENCES organisations (id),
  ticket_id    uuid NOT NULL REFERENCES request_tickets (id),

  channel      text NOT NULL CHECK (channel IN ('email', 'sms')),
  code_hash    text NOT NULL,

  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,

  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  -- Set when a resend replaces this challenge, so an old code stops working the
  -- moment a new one is sent.
  superseded_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now()
);

SELECT app.apply_tenant_rls('public.request_contact_verifications');

-- At most one live challenge per ticket. A partial unique index, so consumed
-- and superseded rows accumulate as history rather than being overwritten.
CREATE UNIQUE INDEX request_contact_verifications_one_live
  ON request_contact_verifications (tenant_id, ticket_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

-- ===========================================================================
-- 7. THE IDENTITY-VERIFICATION HANDOFF (FR-GRV-04) — question 2
--
-- The table that makes "the platform does not know who this is" a state in the
-- system rather than a claim in a document.
--
-- Read the columns for what is ABSENT. There is no customer_id, no account_ref,
-- no matched_subject. The staff member goes to their own systems, decides, and
-- comes back with a verdict and a sentence of justification. The platform
-- records that a competent human at the Data Fiduciary made the call, and when.
-- That is the whole of the platform's business here (I1).
-- ===========================================================================
CREATE TABLE request_identity_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant()
                 REFERENCES organisations (id),
  ticket_id    uuid NOT NULL REFERENCES request_tickets (id),

  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),

  -- The staff verdict. 'inconclusive' is first-class and not a failure mode:
  -- forcing a binary answer is how "we could not tell" becomes "not a customer".
  outcome      text CHECK (outcome IN ('matched', 'not_matched', 'inconclusive')),
  reason       text,

  completed_by uuid REFERENCES users (id),
  completed_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT request_identity_verifications_completed_shape CHECK (
    (status = 'pending'   AND outcome IS NULL     AND completed_by IS NULL AND completed_at IS NULL)
    OR
    (status = 'completed' AND outcome IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE request_identity_verifications IS
  'FR-GRV-04, the identity-verification HANDOFF. The platform proves only that '
  'a contact channel was reachable; matching the requester to a customer record '
  'is a TASK handed to the tenant own staff, who answer it against systems the '
  'platform never sees. Records the verdict and the justification — never a '
  'customer identifier (I1).';

SELECT app.apply_tenant_rls('public.request_identity_verifications');

-- One open task per ticket at a time.
CREATE UNIQUE INDEX request_identity_verifications_one_pending
  ON request_identity_verifications (tenant_id, ticket_id)
  WHERE status = 'pending';
CREATE INDEX request_identity_verifications_queue_idx
  ON request_identity_verifications (tenant_id, status, created_at);

-- ===========================================================================
-- 8. THE SLA / ESCALATION TIMERS — the ticket's half of Seam S3
--
-- workflow_jobs (S3) knows WHEN a deadline fires. It cannot know WHAT the
-- deadline means, and it must not: that is the request module's business. This
-- table is the join between them, and it is the only place the two vocabularies
-- meet.
--
-- WHY THE WHOLE LADDER IS SCHEDULED UP FRONT, as N independent deadlines rather
-- than one deadline that reschedules itself when it fires:
--
--   * workflow_jobs is UNIQUE (tenant_id, workflow_id, kind) — one live deadline
--     per (workflow, kind) — so N rungs need N distinct workflow ids. They are
--     derived deterministically from (ticket_id, level), so the ticket can name
--     any of its own deadlines later (to cancel them) without storing a mapping
--     it could get out of step with.
--   * A self-rescheduling chain would have to schedule its successor from the
--     WORKER process, which has no request unit of work and no tenant context —
--     so the follow-up would commit in a separate transaction from the firing.
--     Lose that one write and the ladder silently stops climbing, with no row
--     anywhere for the reconciliation ticker to notice. Scheduling every rung up
--     front means every rung is durable from the start and the S3 ticker covers
--     all of them.
--
-- The notify target is SNAPSHOTTED here at scheduling time (who the DPO was when
-- the clock started), not looked up when the deadline fires. Two reasons: the
-- worker process must not load the identity module to resolve it (that is what
-- boot-crashes a worker — see notify.module.ts), and an escalation is evidence,
-- so who it was aimed at should be the fact as it stood, not as it was later
-- rewritten.
-- ===========================================================================
CREATE TABLE request_sla_timers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  ticket_id      uuid NOT NULL REFERENCES request_tickets (id),

  level          int NOT NULL CHECK (level >= 1),
  rung           text NOT NULL
                   CHECK (rung IN ('grievance_officer', 'dpo', 'escalation_contact')),
  trigger_reason text NOT NULL CHECK (trigger_reason IN ('sla_proximity', 'sla_breach')),

  -- The id handed to WorkflowRunner.schedule(). Derived from (ticket_id, level).
  workflow_id    uuid NOT NULL,
  due_at         timestamptz NOT NULL,

  -- Snapshot of the rung holder, resolved through IdentityService when the clock
  -- started. Nullable: a tenant that has not named a DPO yet still gets a timer,
  -- and the escalation is recorded as undeliverable rather than skipped.
  notify_user_id uuid REFERENCES users (id),
  notify_contact text,

  status         text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'fired', 'cancelled')),
  fired_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT request_sla_timers_level_unique UNIQUE (tenant_id, ticket_id, level),
  CONSTRAINT request_sla_timers_workflow_unique UNIQUE (tenant_id, workflow_id)
);

COMMENT ON TABLE request_sla_timers IS
  'The request module half of Seam S3: which escalation rung each scheduled '
  'deadline means. workflow_jobs owns WHEN a deadline fires; this owns WHAT it '
  'means. The whole ladder is scheduled up front as N deadlines — see the '
  'header of this migration section for why.';

SELECT app.apply_tenant_rls('public.request_sla_timers');
CREATE INDEX request_sla_timers_ticket_idx ON request_sla_timers (tenant_id, ticket_id, level);

-- Down Migration

DROP TABLE IF EXISTS request_sla_timers;
DROP TABLE IF EXISTS request_identity_verifications;
DROP TABLE IF EXISTS request_contact_verifications;
DROP TABLE IF EXISTS request_escalations;
DROP TABLE IF EXISTS request_correspondence;
DROP TABLE IF EXISTS request_status_events;
DROP TABLE IF EXISTS request_tickets;
DROP TABLE IF EXISTS request_sla_policies;

ALTER TABLE org_designations DROP CONSTRAINT org_designations_designation_check;
ALTER TABLE org_designations ADD CONSTRAINT org_designations_designation_check
  CHECK (designation IN ('dpo', 'grievance_officer'));

DROP TRIGGER IF EXISTS organisations_sync_directory ON organisations;
DROP TRIGGER IF EXISTS organisations_portal_slug ON organisations;
DROP FUNCTION IF EXISTS app.resolve_portal_slug(text);
DROP FUNCTION IF EXISTS app.sync_org_directory();
DROP FUNCTION IF EXISTS app.organisations_set_portal_slug();
DROP TABLE IF EXISTS app.org_directory;
DROP INDEX IF EXISTS organisations_portal_slug_unique;
ALTER TABLE organisations DROP COLUMN IF EXISTS portal_slug;
DROP FUNCTION IF EXISTS app.mint_portal_slug(text, uuid);
