-- Platform admin: a credential that belongs to NO tenant, for the one
-- cross-tenant action the product genuinely needs today — issuing/viewing
-- license keys for whichever client org lost theirs (support operation, not a
-- client-facing feature). This is deliberately a SEPARATE, narrower system
-- from `users`/RBAC, not an extra role bolted onto it: a role on `users` is
-- scoped to one tenant by construction (Seam S1/I3), so "a role that can act
-- on ANY tenant" cannot be expressed there without punching a hole in RLS
-- itself. Keeping it a wholly separate table with its own token type is what
-- lets every other guarantee in the system (I3 above all) stay absolute.
--
-- Deliberately simplified versus `users` for now: password only, no MFA, no
-- lockout counter. This credential is reachable only by a URL nobody links to
-- and is meant for one or two operators during local/dev testing — not the
-- client-facing surface FR-IDN-02/03 harden. Revisit (MFA, lockout, a proper
-- admin-invite flow) before this tool is ever reachable outside localhost.
--
-- Provisioned out-of-band by scripts/create-platform-admin.mjs (owner DB
-- role), never through an API endpoint — there is no public sign-up path for
-- the platform's single most powerful credential.

-- Up Migration

CREATE TABLE platform_admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%@%'),
  password_hash text NOT NULL,
  password_algo text NOT NULL DEFAULT 'scrypt',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

COMMENT ON TABLE platform_admins IS
  'Cross-tenant operator credentials for the /admin/licenses support tool. '
  'NOT a tenant table — holds no tenant_id, carries no RLS. dpdp_app has NO '
  'direct privileges on it (same discipline as app.user_directory): reachable '
  'only through the narrow peephole functions below.';

-- NO GRANTS TO dpdp_app ON THIS TABLE — same control as app.user_directory.
-- Asserted by the isolation suite so a future migration cannot quietly add one.

-- The login peephole: exact email -> (id, password_hash, password_algo).
-- Unlike app.resolve_login (which returns ids only, because a second
-- RLS-scoped query under the now-known tenant fetches the hash), there is no
-- second step here to defer to — platform admins have no tenant to scope a
-- follow-up query under. This IS the terminal lookup, which is why it is the
-- one peephole on the platform that returns credential material at all.
CREATE FUNCTION app.resolve_platform_admin_login(p_email text)
  RETURNS TABLE (id uuid, password_hash text, password_algo text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT a.id, a.password_hash, a.password_algo
  FROM public.platform_admins a
  WHERE a.email = lower(p_email);
$fn$;

COMMENT ON FUNCTION app.resolve_platform_admin_login(text) IS
  'The platform-admin login peephole: exact email -> (id, password_hash, '
  'password_algo). Exact match only, cannot list or pattern-match.';

-- Bookkeeping only — dpdp_app can mark a successful login, nothing else.
CREATE FUNCTION app.touch_platform_admin_login(p_id uuid)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  UPDATE public.platform_admins SET last_login_at = now() WHERE id = p_id;
$fn$;

COMMENT ON FUNCTION app.touch_platform_admin_login(uuid) IS
  'Records a successful platform-admin login. The only write dpdp_app can '
  'make against platform_admins, and only through this function.';

-- The tenant picker: every client org, safe projection only (no owner email,
-- no user data — just enough to pick which org a license is being issued
-- for).
--
-- This CANNOT be `SELECT ... FROM organisations`, even inside a SECURITY
-- DEFINER function. `organisations` carries FORCE ROW LEVEL SECURITY (see
-- request-substrate migration), and FORCE applies RLS to the table OWNER too
-- — the one case it does NOT exempt is an actual Postgres superuser, which
-- `dpdp_owner` (this migration's role, and therefore every function it
-- creates) is not on managed Postgres. A SECURITY DEFINER function querying
-- `organisations` directly would just see zero rows, the same as any other
-- non-superuser caller with no tenant GUC set — not a bypass, a silent
-- no-op. (Caught live: the first version of this migration did exactly
-- that, and /admin/licenses listed no organisations at all.)
--
-- The established way around this is the one `app.org_directory` already
-- uses for the identical problem (the public portal's slug -> tenant
-- lookup): an UN-RLS'd shadow table, kept in sync by trigger, that a
-- peephole function reads instead of the real table. Extend that existing
-- directory with the columns this picker needs rather than standing up a
-- second shadow of the same table.
ALTER TABLE app.org_directory ADD COLUMN plan text;
ALTER TABLE app.org_directory ADD COLUMN deployment_type text;
ALTER TABLE app.org_directory ADD COLUMN created_at timestamptz;

CREATE OR REPLACE FUNCTION app.sync_org_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  INSERT INTO app.org_directory (portal_slug, tenant_id, name, plan, deployment_type, created_at)
  VALUES (NEW.portal_slug, NEW.id, NEW.name, NEW.plan, NEW.deployment_type, NEW.created_at)
  ON CONFLICT (portal_slug) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name, plan = EXCLUDED.plan,
        deployment_type = EXCLUDED.deployment_type, updated_at = now();
  RETURN NEW;
END
$fn$;

-- Backfill for tenants that already existed before these columns did — same
-- NO FORCE/FORCE window the original app.org_directory seed used, for the
-- same reason: without it this SELECT sees none of them either.
ALTER TABLE organisations NO FORCE ROW LEVEL SECURITY;
UPDATE app.org_directory d
   SET plan = o.plan, deployment_type = o.deployment_type, created_at = o.created_at
  FROM organisations o
 WHERE o.id = d.tenant_id;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;

-- Deliberately left NULLable, not backfilled-then-NOT-NULL: this dev
-- database's app.org_directory already carries a number of stale rows whose
-- tenant_id matches no CURRENT organisation (an org_directory upsert keys on
-- portal_slug, not tenant_id, and nothing ever deletes a directory row — see
-- its own comment). Those rows cannot be backfilled by the UPDATE above and
-- a NOT NULL constraint would make this migration fail on exactly the kind
-- of accumulated dev-only cruft it has no business caring about. Every
-- CURRENT organisation gets these columns populated — by the backfill above
-- for existing ones, and by the trigger for every org created from now on —
-- which is all app.list_organisations() needs: it filters on plan being set.
CREATE FUNCTION app.list_organisations()
  RETURNS TABLE (id uuid, name text, plan text, deployment_type text, created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.name, d.plan, d.deployment_type, d.created_at
  FROM app.org_directory d
  WHERE d.plan IS NOT NULL
  ORDER BY d.created_at DESC;
$fn$;

COMMENT ON FUNCTION app.list_organisations() IS
  'Cross-tenant organisation listing for the platform-admin tenant picker. '
  'Reads app.org_directory (un-RLS''d shadow), never organisations directly '
  '— see the ADD COLUMN block above for why. Filters out any directory row '
  'never backfilled/synced with plan/deployment_type (stale, pre-existing '
  'the columns, orphaned, or whatever else); still a safe projection only '
  '(id/name/plan/deployment_type/created_at) — no user data, no counts that '
  'could leak tenant activity.';

REVOKE ALL ON FUNCTION app.resolve_platform_admin_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.touch_platform_admin_login(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_platform_admin_login(text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.touch_platform_admin_login(uuid) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.list_organisations() TO dpdp_app;

-- licenses.created_by is `NOT NULL REFERENCES users (id)` — a platform admin
-- has no users(id) row (deliberately: it is not a tenant identity), so a
-- license issued from this tool cannot satisfy that FK. Rather than fake a
-- user row (which would make a support action show up as if some tenant
-- employee did it — a false WHO, which I4 exists to prevent), add a second,
-- equally-FK-enforced "who" column and require exactly one of the two to be
-- set, so provenance stays exact and queryable either way.
ALTER TABLE licenses ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE licenses ADD COLUMN created_by_platform_admin uuid REFERENCES platform_admins (id);
ALTER TABLE licenses ADD CONSTRAINT licenses_created_by_exactly_one CHECK (
  (created_by IS NOT NULL AND created_by_platform_admin IS NULL) OR
  (created_by IS NULL AND created_by_platform_admin IS NOT NULL)
);

COMMENT ON COLUMN licenses.created_by_platform_admin IS
  'Set instead of created_by when this license was issued from the '
  'cross-tenant /admin/licenses support tool rather than by a tenant owner/'
  'dpo. Exactly one of created_by / created_by_platform_admin is ever set.';

-- Down Migration

ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_created_by_exactly_one;
ALTER TABLE licenses DROP COLUMN IF EXISTS created_by_platform_admin;
ALTER TABLE licenses ALTER COLUMN created_by SET NOT NULL;

DROP FUNCTION IF EXISTS app.list_organisations();

-- Restore app.sync_org_directory() / app.org_directory to the shape the
-- request-substrate migration gave them, before this migration's columns.
CREATE OR REPLACE FUNCTION app.sync_org_directory() RETURNS trigger
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
ALTER TABLE app.org_directory DROP COLUMN IF EXISTS plan;
ALTER TABLE app.org_directory DROP COLUMN IF EXISTS deployment_type;
ALTER TABLE app.org_directory DROP COLUMN IF EXISTS created_at;

DROP FUNCTION IF EXISTS app.touch_platform_admin_login(uuid);
DROP FUNCTION IF EXISTS app.resolve_platform_admin_login(text);
DROP TABLE IF EXISTS platform_admins;
