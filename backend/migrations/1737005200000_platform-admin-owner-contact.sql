-- Platform-admin tenant picker follow-up: org NAME alone is not enough to
-- tell two client organisations apart (plenty of dev/test orgs share a name,
-- and even in production two clients can legitimately pick the same display
-- name) — the owner's EMAIL is the identifier that actually disambiguates
-- "which company is this." Add it to the same un-RLS'd app.org_directory
-- shadow table app.list_organisations() already reads (see the
-- platform-admin migration for why that table, not `organisations`/`users`
-- directly, is the only way a SECURITY DEFINER function can read this at
-- all under FORCE ROW LEVEL SECURITY).

-- Up Migration

ALTER TABLE app.org_directory ADD COLUMN owner_email text;

-- Kept in sync by a trigger on `users`, not application code — same
-- reasoning as app.sync_user_directory (identity migration): a trigger
-- cannot be forgotten by a future code path. Fires on every insert/update of
-- email or role and only acts when the row IS (or becomes) an 'owner' — if a
-- tenant ever has more than one owner, the most recently touched one wins,
-- which is fine for "a contact email to identify this client by," not a
-- precision requirement.
CREATE FUNCTION app.sync_org_directory_owner_email() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF NEW.role = 'owner' THEN
    UPDATE app.org_directory SET owner_email = NEW.email, updated_at = now() WHERE tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app.sync_org_directory_owner_email() IS
  'Maintains app.org_directory.owner_email from public.users whenever an '
  'owner row''s email or role changes. SECURITY DEFINER for the same reason '
  'app.sync_org_directory is: dpdp_app cannot write the directory directly.';

CREATE TRIGGER users_sync_org_directory_owner_email
  AFTER INSERT OR UPDATE OF email, role ON users
  FOR EACH ROW EXECUTE FUNCTION app.sync_org_directory_owner_email();

-- Backfill for owners that already existed — same NO FORCE/FORCE window the
-- platform-admin migration's own backfill used, same reason: `users` also
-- carries FORCE ROW LEVEL SECURITY, so this connection (no tenant GUC set)
-- would otherwise see none of them.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
UPDATE app.org_directory d
   SET owner_email = u.email
  FROM users u
 WHERE u.tenant_id = d.tenant_id AND u.role = 'owner';
ALTER TABLE users FORCE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION app.sync_org_directory_owner_email() FROM PUBLIC;

-- CREATE OR REPLACE cannot change a function's return TYPE (only its body),
-- and adding a column to a RETURNS TABLE list is a type change — drop and
-- recreate, same as any other return-shape change.
DROP FUNCTION app.list_organisations();
CREATE FUNCTION app.list_organisations()
  RETURNS TABLE (id uuid, name text, plan text, deployment_type text, owner_email text, created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.name, d.plan, d.deployment_type, d.owner_email, d.created_at
  FROM app.org_directory d
  WHERE d.plan IS NOT NULL
  ORDER BY d.created_at DESC;
$fn$;

REVOKE ALL ON FUNCTION app.list_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_organisations() TO dpdp_app;

-- Down Migration

DROP FUNCTION app.list_organisations();
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
REVOKE ALL ON FUNCTION app.list_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_organisations() TO dpdp_app;

DROP TRIGGER IF EXISTS users_sync_org_directory_owner_email ON users;
DROP FUNCTION IF EXISTS app.sync_org_directory_owner_email();
ALTER TABLE app.org_directory DROP COLUMN IF EXISTS owner_email;
