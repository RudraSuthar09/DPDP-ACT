-- Seam write-path lockdown (R3) — make "nothing else can INSERT" actually true.
--
-- The append-only seam tables are meant to be SELECT-only for the runtime role
-- (dpdp_app), so the ONLY write path is a SECURITY DEFINER function:
--   * consent_events  (S2)  ← app.consent_append
--   * workflow_jobs   (S3)  ← app.workflow_schedule / _cancel / _mark_fired / _mark_failed
--
-- Their migrations deliberately GRANT SELECT only. But this database carries an
-- out-of-band default privilege — set outside the migration set, observed as
--   `ALTER DEFAULT PRIVILEGES FOR ROLE dpdp_owner IN SCHEMA public
--    GRANT INSERT, SELECT, UPDATE ON TABLES TO dpdp_app;`
-- which silently re-granted dpdp_app INSERT/UPDATE on every new public table,
-- INCLUDING these two. That reopened the exact hole R3 exists to close: a service
-- could `INSERT INTO consent_events` directly, bypassing the sink and its
-- pseudonymisation / idempotency / notice-pinning.
--
-- This migration closes it two ways, and is idempotent (a no-op on a clean DB
-- that never had the stray default privilege):
--   1. Stop the bleeding: neutralise the default so FUTURE tables owned by
--      dpdp_owner do not auto-grant writes to dpdp_app. Tables that legitimately
--      need writes call app.apply_tenant_rls(), which GRANTs explicitly — so this
--      changes nothing for them; it only removes an implicit grant nothing relies on.
--   2. Fix the tables already affected: REVOKE INSERT/UPDATE on the two append-only
--      seam tables (and the consent_events leaf partitions) from dpdp_app. SELECT
--      stays — the read paths need it. The only writer remains the definer function.
--
-- After this, the isolation/write-path guarantee is enforced by the ENGINE, not by
-- a grant that a stray ALTER DEFAULT PRIVILEGES can quietly undo.

-- Up Migration

-- 1. Neutralise the harmful default for future tables (write privileges only;
--    a default SELECT is harmless and apply_tenant_rls re-grants writes anyway).
ALTER DEFAULT PRIVILEGES FOR ROLE dpdp_owner IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM dpdp_app;

-- 2a. consent_events (S2): SELECT-only. Writes go through app.consent_append.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON consent_events FROM dpdp_app;
DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON consent_events_p%s FROM dpdp_app', i);
  END LOOP;
END
$$;

-- 2b. workflow_jobs (S3): SELECT-only. Writes go through app.workflow_* functions.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON workflow_jobs FROM dpdp_app;

-- Down Migration

-- Restore the prior (over-broad) state, so `migrate down` is faithful. Note this
-- re-opens the R3 hole by design of a down-migration; you would only run it to
-- revert this migration wholesale.
GRANT INSERT, UPDATE ON consent_events TO dpdp_app;
DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format('GRANT INSERT, UPDATE ON consent_events_p%s TO dpdp_app', i);
  END LOOP;
END
$$;
GRANT INSERT, UPDATE ON workflow_jobs TO dpdp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dpdp_owner IN SCHEMA public
  GRANT INSERT, UPDATE ON TABLES TO dpdp_app;
