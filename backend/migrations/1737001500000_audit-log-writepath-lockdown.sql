-- Seam S5 write-path lockdown (R3) — the one migration 1737000500000 missed.
--
-- WHAT THIS FIXES, and why it matters more than the two it follows:
--
-- 1737000500000_seam-writepath-lockdown.sql closed an out-of-band default
-- privilege — `ALTER DEFAULT PRIVILEGES FOR ROLE dpdp_owner IN SCHEMA public
-- GRANT INSERT, SELECT, UPDATE ON TABLES TO dpdp_app` — that had silently
-- re-granted dpdp_app write access to every public table. It neutralised the
-- default and revoked writes on `consent_events` (S2) and `workflow_jobs` (S3).
--
-- It did NOT revoke them on `audit_log` (S5), which was created one migration
-- EARLIER and had therefore already picked up the same stray grant. So the audit
-- log — the seam whose own module header says its retrofit cost is "impossible",
-- the table the entire product's evidentiary claim rests on — was left with
-- INSERT and UPDATE granted to the runtime role, while its two less critical
-- siblings were locked down.
--
-- Observed on the live database before this migration:
--     audit_log       INSERT, SELECT, UPDATE   <-- the hole
--     consent_events  SELECT
--     workflow_jobs   SELECT
--
-- The audit module's design says the interceptor is the ONLY writer and that
-- `app.audit_append` (SECURITY DEFINER) is the only path in. With INSERT granted
-- directly, any service could have forged an entry — choosing what to record and
-- what to omit, which is precisely the discretion an append-only log exists to
-- remove. The row triggers (audit_log_no_update / _no_truncate) still stood, so
-- editing history was blocked; but FORGING it was one INSERT away.
--
-- Found by the cross-tenant isolation suite (NFR-SEC-05, R5), which was red on
-- all eight of its audit-chain assertions for exactly this reason. That is the
-- suite doing its job — and the reason R5 says never to skip it.
--
-- Idempotent: a no-op on a database that never carried the stray default.

-- Up Migration

-- SELECT stays: the audit VIEWER (FR-AUD-03/04) reads this table directly under
-- RLS. Everything else goes, so the only way in is app.audit_append, called by
-- the one interceptor.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log FROM dpdp_app;

-- Down Migration

-- Faithful revert only. Running this re-opens the R3 hole deliberately; there is
-- no reason to do it except to revert this migration wholesale.
GRANT INSERT, UPDATE ON audit_log TO dpdp_app;
