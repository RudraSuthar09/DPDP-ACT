-- Platform-admin approval gate: a license — however it was issued (auto at
-- registration, by a tenant's own owner/dpo, or from the /admin/licenses
-- tool itself) — must be explicitly approved by a platform admin before it
-- can activate an installation (POST /installations). This is a deliberate
-- product decision: every client's FIRST activation goes through a human
-- review, not an automatic self-service step. See licensing-policy.ts's
-- evaluateLicenseForActivation, which is the single enforcement point this
-- gate hooks into — the frontend never decides whether a license may
-- activate, same discipline as everything else in that function.
--
-- A SEPARATE dimension from `status`: `status` tracks the activation
-- lifecycle (pending -> active -> expired/revoked), `approved_at` tracks
-- whether a human has signed off on this entitlement at all. A license can
-- be `status = 'pending'` AND unapproved (the common case right after
-- issuance), or `status = 'pending'` and approved (waiting on the client to
-- actually activate) — those are different facts and neither implies the
-- other.

-- Up Migration

ALTER TABLE licenses ADD COLUMN approved_at timestamptz;
ALTER TABLE licenses ADD COLUMN approved_by_platform_admin uuid REFERENCES platform_admins (id);

COMMENT ON COLUMN licenses.approved_at IS
  'Platform-admin approval gate (see migration header): NULL = awaiting '
  'approval, cannot activate an installation regardless of status/expiry. '
  'Set only via POST /platform-admin/.../licenses/:id/approve.';
COMMENT ON COLUMN licenses.approved_by_platform_admin IS
  'Which platform admin approved this license. NULL for licenses '
  'grandfathered in by this migration (approved_at backfilled, no real '
  'approver to record) — never NULL for one approved through the tool.';

-- Grandfather in every license that already existed: this gate applies only
-- to licenses issued from here on, never retroactively to installations that
-- are already running. NO FORCE/FORCE window required — `licenses` carries
-- FORCE ROW LEVEL SECURITY, so without it this UPDATE silently matches zero
-- rows on a connection with no tenant GUC set (same trap hit twice already
-- in the platform-admin migrations; see their comments).
ALTER TABLE licenses NO FORCE ROW LEVEL SECURITY;
UPDATE licenses SET approved_at = now() WHERE approved_at IS NULL;
ALTER TABLE licenses FORCE ROW LEVEL SECURITY;

-- Down Migration

ALTER TABLE licenses DROP COLUMN IF EXISTS approved_by_platform_admin;
ALTER TABLE licenses DROP COLUMN IF EXISTS approved_at;
