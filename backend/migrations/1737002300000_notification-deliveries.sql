-- Real transactional email/SMS providers behind NotificationDispatcher, and the
-- evidence for the "channel status" settings screen (this prompt) — a durable
-- log of recent attempts, on the same footing as webhook_deliveries.
--
-- Before this, NotificationDispatcher's `send()` returned a result but nothing
-- kept it: a settings screen asking "is email actually delivering?" had no
-- database row to answer from, only whatever scrolled past in the process log.
-- This table is that answer, sized for a status screen, not a second audit
-- trail: it holds enough to show delivery health, and nothing a raw file
-- upload or evidence table would need to hold under I1's stricter rule.

-- Up Migration

CREATE TABLE notification_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant()
                REFERENCES organisations (id),

  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  kind        text NOT NULL CHECK (kind IN ('otp', 'escalation', 'acknowledgement', 'status_update')),
  provider    text NOT NULL,

  -- Masked at the point of writing (same masking NotificationDispatcher's log
  -- lines already use) — enough to recognise "yes, that one" on a status
  -- screen, not enough to reconstruct a contact list from the database.
  to_masked   text NOT NULL,

  delivered   boolean NOT NULL,
  error       text,

  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_deliveries IS
  'Recent email/SMS delivery attempts, for the notification channel status '
  'screen. NOT a second audit trail: no reason/actor/before-after — those '
  'attributes belong to the S5 chain when a notification is itself the '
  'business event (see request_escalations / breach_escalations). This table '
  'answers "is the channel healthy", nothing more.';

SELECT app.apply_tenant_rls('public.notification_deliveries');

CREATE INDEX notification_deliveries_recent_idx
  ON notification_deliveries (tenant_id, channel, occurred_at DESC);

-- Down Migration

DROP TABLE IF EXISTS notification_deliveries;
