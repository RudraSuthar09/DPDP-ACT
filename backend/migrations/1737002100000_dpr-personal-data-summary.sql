-- FR-DPR-04/05/07 — the two-tier Personal Data Summary, fulfilment webhooks,
-- and the request register's evidence export.
--
-- ===========================================================================
-- THIS FILE IS THE PLACE I1 IS MOST TEMPTING TO BREAK, SO READ THE SHAPE FIRST
--
-- I1 says the platform never stores customer records. Everything Tier 1
-- assembles is ALREADY on the platform — inventory metadata, consent events
-- keyed by an HMAC'd ref, the tenant's own request tickets — so Tier 1 adds no
-- table at all. It is a pure read across three registers that already exist.
-- If you are looking for "where the personal data summary is stored", the
-- answer is nowhere: it is derived on every request and rendered.
--
-- Tier 2 is where actual customer VALUES exist, for the length of one HTTP
-- round trip, and the design rule is absolute: there is no column anywhere in
-- this file that can hold one. Look at dpr_fulfilments below — it has no
-- payload column, no response column, no url column. That is not an oversight
-- to be corrected later; it is the requirement, expressed as a schema that
-- makes the violation impossible rather than merely discouraged.
-- ===========================================================================

-- Up Migration

-- ===========================================================================
-- 1. THE MISSING JOIN: consent purposes <-> inventory purposes
--
-- Tier 1 must answer "which categories of YOUR data do we hold, under what
-- legal basis, for how long". Those facts live on inventory_entry_purposes
-- (legal basis, retention) hanging off inventory_register_entries (category,
-- storage location, systems, vendors). What a data principal actually consented
-- to lives on consent_events, keyed by consent_purposes.
--
-- Those two tables have never been linked. Before this migration there was no
-- FK, no shared key, and no way to get from "Ravi consented to Marketing" to
-- "Marketing processing touches these three data categories". The only prior
-- co-occurrence of the two names in this codebase is a comment.
--
-- WHY THIS IS A CURATED TABLE AND NOT A NAME MATCH. The obvious shortcut is to
-- join on purpose name at read time. It needs no table and no configuration,
-- and it is silently wrong the moment a tenant calls something "Marketing" in
-- one register and "Marketing communications" in the other — or, far worse,
-- calls two different things the same name. The output of Tier 1 is a document
-- handed to a data principal exercising a statutory right, and a fuzzy match
-- can make it assert that the organisation holds their medical history under a
-- marketing consent. A wrong answer here is not a UI glitch; it is a false
-- statement about someone's personal data, issued under the Act.
--
-- So the platform SUGGESTS (name similarity, scored) and a human ACCEPTS —
-- exactly the pattern inventory_register_entries' PII classification already
-- established: a confidence-scored suggestion, a recorded human decision, and
-- the server re-deriving rather than trusting what the client posts back. An
-- unmapped purpose is not silently dropped or silently included: Tier 1 shows
-- it in its own section, so the gap in the tenant's configuration is visible in
-- the document rather than hidden by it.
-- ===========================================================================
CREATE TABLE consent_purpose_inventory_links (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL DEFAULT app.current_tenant()
                         REFERENCES organisations (id),

  consent_purpose_id   uuid NOT NULL REFERENCES consent_purposes (id),
  inventory_purpose_id uuid NOT NULL REFERENCES inventory_entry_purposes (id),

  -- Nothing is hard-deleted (I4). Unlinking sets status='removed' and keeps the
  -- row, because "this entry WAS attributed to your marketing consent when your
  -- summary was issued in March" is a fact about a document already handed to
  -- someone.
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'removed')),

  -- How this link came to exist. 'suggested' rows are the platform's guess and
  -- are NEVER used by Tier 1 — only a human moving one to 'accepted' does that.
  origin               text NOT NULL DEFAULT 'manual'
                         CHECK (origin IN ('manual', 'accepted_suggestion')),
  -- The similarity score at the moment a suggestion was accepted, kept so a
  -- reviewer can later ask "what did the machine think, and did a human agree
  -- with a weak suggestion?" — the same reason the PII classifier keeps its.
  suggestion_confidence numeric(4, 3) CHECK (suggestion_confidence BETWEEN 0 AND 1),

  linked_by            uuid REFERENCES users (id),
  linked_at            timestamptz NOT NULL DEFAULT now(),
  removed_by           uuid REFERENCES users (id),
  removed_at           timestamptz,
  removal_reason       text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE consent_purpose_inventory_links IS
  'FR-DPR-04 — the tenant-curated bridge between a consent purpose (what a data '
  'principal agreed to) and the inventory purposes that carry legal basis, '
  'retention, systems and vendors. Deliberately curated rather than name-matched: '
  'Tier 1 output is a statutory document, and a fuzzy join can make it assert '
  'the wrong thing about someone''s data. Suggestions are scored by the platform '
  'and accepted by a human; only active rows are read by the summary.';

SELECT app.apply_tenant_rls('public.consent_purpose_inventory_links');

-- One ACTIVE link per pair; a removed link may be re-created later (which is a
-- new row, so the trail keeps both).
CREATE UNIQUE INDEX consent_purpose_inventory_links_active_uq
  ON consent_purpose_inventory_links (tenant_id, consent_purpose_id, inventory_purpose_id)
  WHERE status = 'active';

CREATE INDEX consent_purpose_inventory_links_consent_idx
  ON consent_purpose_inventory_links (tenant_id, consent_purpose_id, status);

CREATE TRIGGER consent_purpose_inventory_links_touch_updated_at
  BEFORE UPDATE ON consent_purpose_inventory_links
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ===========================================================================
-- 2. WHERE TIER 2 AND THE FULFILMENT WEBHOOKS ARE SENT
--
-- A second URL rather than reusing tenant_webhook_config.url, because the two
-- are genuinely different integrations with different obligations. The consent
-- webhook is fire-and-forget notification: the client may ignore it. A
-- fulfilment call is a REQUEST FOR ACTION with a statutory deadline attached,
-- and the client's response is the evidence the action happened. A tenant may
-- reasonably point them at different services, and one being down must not be
-- read as the other being down.
--
-- The SECRET is deliberately shared (tenant_webhook_secrets) — one signing
-- scheme, one secret to rotate, one verification routine for the client to
-- implement. Two secrets would double the rotation surface to buy nothing.
-- ===========================================================================
ALTER TABLE tenant_webhook_config
  ADD COLUMN fulfilment_url     text,
  ADD COLUMN fulfilment_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tenant_webhook_config.fulfilment_url IS
  'FR-DPR-05/07 — where signed rights-request fulfilment calls are sent '
  '(Tier 2 value retrieval, and correction/erasure/portability actions). '
  'Signed with the SAME per-tenant secret as the consent webhook: one scheme, '
  'one rotation. Null/disabled means this tenant fulfils rights requests '
  'manually, which is a legitimate configuration, not an error.';

-- ===========================================================================
-- 3. THE FULFILMENT RECORD — AND WHAT IT CANNOT HOLD
--
-- One row per fulfilment call. Read the column list as a list of REFUSALS as
-- much as a list of fields:
--
--   there is no `payload` column        (unlike webhook_deliveries, which has one)
--   there is no `response_body` column
--   there is no `delivery_url` column
--   there is no `client_reference` column
--
-- webhook_deliveries CAN store its payload because a consent-change
-- notification contains no customer values — a subject ref, a purpose id, a
-- status. A Tier 2 response contains the person's actual name, address and
-- account history. Copying that table's shape here is the single most natural
-- mistake available in this codebase, and it would put customer records in
-- Postgres under a column named `payload` that nobody would think to audit.
--
-- What IS stored is evidence ABOUT the exchange:
--   * the signature header we sent, and a hash of the exact bytes we signed —
--     together these let anyone prove later what was asked for, without the
--     request text itself being needed;
--   * a hash of the delivery URL, NOT the URL. A client-hosted link is not the
--     data, but a link is free-form and a client may well put an account number
--     in a query string; the platform cannot police that, so it does not keep
--     it. The URL is relayed to the requester in the same HTTP response that
--     produced it and then goes out of scope.
--   * the client's confirmation: status and timestamp. That is what
--     FR-DPR-07 asks be recorded for a correction or erasure, and it is all
--     that is recorded.
-- ===========================================================================
CREATE TABLE dpr_fulfilments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL DEFAULT app.current_tenant()
                          REFERENCES organisations (id),
  ticket_id             uuid NOT NULL REFERENCES request_tickets (id),

  -- What was asked of the client's system.
  kind                  text NOT NULL CHECK (kind IN (
                          'data_values', 'correction', 'erasure', 'portability'
                        )),

  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'confirmed', 'declined', 'failed')),

  -- Evidence of what we sent, without the sending being re-derivable into
  -- content. The request payload carries no customer data (ids and a subject
  -- ref only) but is hashed rather than stored for uniformity: no table in this
  -- feature holds a message body, so there is no exception to explain.
  request_signature     text NOT NULL,
  request_payload_sha256 text NOT NULL CHECK (request_payload_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  requested_by          uuid REFERENCES users (id),

  -- How the client answered. 'link' = they hosted it themselves and we passed
  -- on the address; 'relay' = we streamed their bytes through memory to the
  -- requester; 'confirmation' = an action was performed, nothing to return.
  response_kind         text CHECK (response_kind IN ('link', 'relay', 'confirmation')),
  response_status_code  int,
  -- Proves WHICH link was handed over. Cannot be turned back into the link.
  delivery_url_sha256   text CHECK (delivery_url_sha256 ~ '^[0-9a-f]{64}$'),
  link_expires_at       timestamptz,
  -- For a relay: how many bytes passed through, so "we handed over a 40 kB
  -- document at 14:02" is answerable. The bytes themselves are not kept.
  relayed_bytes         int,

  confirmed_at          timestamptz,
  failure_reason        text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dpr_fulfilments IS
  'FR-DPR-05/07 — one row per signed fulfilment call to a client system. '
  'Records the ASK (signature, payload hash) and the ANSWER (status, timestamp, '
  'response kind) and deliberately has no column capable of holding a customer '
  'value: no payload, no response body, no URL. Tier 2 values exist only in '
  'process memory for the length of one round trip and are never written here '
  'or anywhere else (I1).';

SELECT app.apply_tenant_rls('public.dpr_fulfilments');

CREATE INDEX dpr_fulfilments_ticket_idx ON dpr_fulfilments (tenant_id, ticket_id, requested_at DESC);

CREATE TRIGGER dpr_fulfilments_touch_updated_at
  BEFORE UPDATE ON dpr_fulfilments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TABLE IF EXISTS dpr_fulfilments;
ALTER TABLE tenant_webhook_config
  DROP COLUMN IF EXISTS fulfilment_url,
  DROP COLUMN IF EXISTS fulfilment_enabled;
DROP TABLE IF EXISTS consent_purpose_inventory_links;
