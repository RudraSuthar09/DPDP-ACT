-- Per-user product-tour state (FR-IDN-02 adjacent; UI onboarding).
--
-- WHY A COLUMN AND NOT A PREFERENCES TABLE. There is no per-user preference
-- mechanism anywhere in this codebase today — `notify`'s settings are
-- TENANT-level channel configuration, not user preferences, and `users` holds
-- only authentication and lifecycle facts. Rather than invent a generic
-- key/value preferences store for one boolean-ish fact (and invite every
-- future "just stash it in prefs" shortcut), this adds the narrowest thing
-- that answers the actual question: has THIS user finished with the tour?
-- When a second genuine preference appears, that is the moment to generalise —
-- not before (R1's habit of mind, applied to schema).
--
-- WHY IT IS MUTABLE IN PLACE, unlike almost everything else here. I4 governs
-- EVIDENCE — what the organisation did with personal data. Whether someone
-- clicked "Skip" on a product walkthrough is not evidence of anything; it is
-- interface state, the same kind of fact as `failed_login_attempts`,
-- `mfa_last_step` and `last_login_at`, all of which are already updated in
-- place on this table. It is deliberately NOT audited either (see
-- @NoAudit on the controller): the S5 chain is what a regulator reads, and
-- padding it with "user dismissed a tooltip" degrades the signal that makes
-- it worth reading.
--
-- 'pending' is the default, so every EXISTING user is offered the tour once on
-- their next sign-in rather than being silently opted out by the backfill.

-- Up Migration

ALTER TABLE users
  ADD COLUMN product_tour_status text NOT NULL DEFAULT 'pending'
    CHECK (product_tour_status IN ('pending', 'completed', 'skipped')),
  ADD COLUMN product_tour_updated_at timestamptz;

COMMENT ON COLUMN users.product_tour_status IS
  'Guided-tour state for this user: pending (auto-launch on next sign-in), '
  'completed (reached the last step), or skipped (dismissed). Interface '
  'state, not evidence — mutable in place and deliberately not audited. The '
  'tour is always re-launchable regardless of this value.';

COMMENT ON COLUMN users.product_tour_updated_at IS
  'When product_tour_status last changed. NULL while still pending.';

-- No GRANT needed: apply_tenant_rls granted SELECT/INSERT/UPDATE at TABLE
-- level in 1737000200000, and table-level privileges cover columns added later.

-- Down Migration

ALTER TABLE users
  DROP COLUMN IF EXISTS product_tour_updated_at,
  DROP COLUMN IF EXISTS product_tour_status;
