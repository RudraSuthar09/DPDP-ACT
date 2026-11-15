-- Read-only listing of platform administrators for the internal admin
-- portal's "Admin users" page (/admin/admins).
--
-- dpdp_app still has NO grant on public.platform_admins (see the
-- platform-admin migration): this adds one more narrow SECURITY DEFINER
-- peephole beside app.resolve_platform_admin_login / touch_platform_admin_login
-- / list_organisations. It returns a SAFE PROJECTION ONLY -- id, email,
-- created_at, last_login_at. Never password_hash or password_algo. It takes
-- no arguments, so it cannot be used to probe anything; it cannot write.
--
-- No table, column or data change.

-- Up Migration

CREATE FUNCTION app.list_platform_admins()
  RETURNS TABLE (id uuid, email text, created_at timestamptz, last_login_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT a.id, a.email, a.created_at, a.last_login_at
  FROM public.platform_admins a
  ORDER BY a.created_at;
$fn$;

COMMENT ON FUNCTION app.list_platform_admins() IS
  'Platform-admin portal listing: id, email, created_at, last_login_at only '
  '(never credential material). Called only behind PlatformAdminGuard.';

REVOKE ALL ON FUNCTION app.list_platform_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_platform_admins() TO dpdp_app;

-- Down Migration

DROP FUNCTION IF EXISTS app.list_platform_admins();
