-- Central DPDP Storage — automatic synchronization phase: a third storage
-- provider, 'server'.
--
-- 'local' (SaaS, browser File System Access API) and 'gateway' (Enterprise,
-- reached through an enrolled Gateway device) already exist. Neither lets
-- the BACKEND/WORKER PROCESS itself read/write a filesystem path directly.
-- 'server' is that third, additive case: an Enterprise deployment where the
-- backend/worker container has direct, continuous access to a configured
-- server-side directory (e.g. a bind-mounted host path) — no Gateway
-- involved at all. It reuses the existing `root_path` column (already
-- present, previously meaningful only as a display hint) as the real,
-- non-secret filesystem path the worker resolves with Node `fs/promises`.
--
-- This does NOT touch gateway_devices, the Gateway control plane, or
-- anything in storage-gateway.*/gateway-storage.* — 'gateway' is completely
-- unchanged.

-- Up Migration

ALTER TABLE storage_roots DROP CONSTRAINT IF EXISTS storage_roots_provider_check;
ALTER TABLE storage_roots
  ADD CONSTRAINT storage_roots_provider_check CHECK (provider IN ('local', 'gateway', 'server'));

ALTER TABLE storage_roots DROP CONSTRAINT IF EXISTS storage_roots_provider_binding;
ALTER TABLE storage_roots
  ADD CONSTRAINT storage_roots_provider_binding CHECK (
    (provider = 'gateway' AND gateway_device_id IS NOT NULL)
    OR (provider = 'local' AND gateway_device_id IS NULL)
    OR (provider = 'server' AND gateway_device_id IS NULL AND root_path IS NOT NULL)
  );

COMMENT ON COLUMN storage_roots.provider IS
  'local = SaaS (browser File System Access API). gateway = Enterprise via an '
  'enrolled Gateway device. server = Enterprise via a filesystem path the '
  'backend/worker process itself can read/write directly (no Gateway).';
COMMENT ON COLUMN storage_roots.root_path IS
  'For local/gateway: a non-secret display hint resolved by the client. For '
  'server: the REAL filesystem path the worker synchronizes to directly '
  '(e.g. a bind-mounted host directory) — still never a credential.';

-- Cross-tenant scheduler peephole (mirrors app.workflow_due_all, S3) — the
-- Enterprise storage sync worker needs to know WHICH tenants have an active
-- 'server' root before it can sweep them, and that question cannot be asked
-- under any one tenant's RLS. Returns ids + the non-secret path only (I1) —
-- no business data, no customer data.
--
-- storage_roots is FORCE ROW LEVEL SECURITY (app.apply_tenant_rls), which
-- means even the table owner is subject to `tenant_id = app.current_tenant()`
-- — a SECURITY DEFINER function reading it directly would run AS the owner,
-- find no tenant GUC, and see nothing. workflow_due_all's `workflow_sweep`
-- policy is the exact precedent for the fix: an EXTRA, PERMISSIVE, SELECT-
-- only policy scoped to dpdp_owner alone, `USING (true)`. dpdp_app (the
-- runtime role, everything else in the app) never matches it — this only
-- widens what the table owner's role can see, and dpdp_owner is already the
-- role every migration and the pg-boss engine connect as.
CREATE POLICY storage_server_roots_sweep ON storage_roots
  FOR SELECT TO dpdp_owner
  USING (true);

CREATE FUNCTION app.storage_server_roots_active()
  RETURNS TABLE (tenant_id uuid, storage_root_id uuid, root_path text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  RETURN QUERY
    SELECT r.tenant_id, r.id, r.root_path
    FROM storage_roots r
    WHERE r.provider = 'server' AND r.status = 'active' AND r.root_path IS NOT NULL;
END
$fn$;

COMMENT ON FUNCTION app.storage_server_roots_active IS
  'Scheduler peephole for the Enterprise storage sync worker: which tenants '
  'have an active server-provider storage root, and its path. Ids + a non-'
  'secret path only (I1) — the sibling of app.workflow_due_all for S3.';

REVOKE ALL ON FUNCTION app.storage_server_roots_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.storage_server_roots_active() TO dpdp_app;

-- Down Migration

DROP FUNCTION IF EXISTS app.storage_server_roots_active();
DROP POLICY IF EXISTS storage_server_roots_sweep ON storage_roots;

ALTER TABLE storage_roots DROP CONSTRAINT IF EXISTS storage_roots_provider_binding;
ALTER TABLE storage_roots
  ADD CONSTRAINT storage_roots_provider_binding CHECK (
    (provider = 'gateway' AND gateway_device_id IS NOT NULL)
    OR (provider = 'local' AND gateway_device_id IS NULL)
  );

ALTER TABLE storage_roots DROP CONSTRAINT IF EXISTS storage_roots_provider_check;
ALTER TABLE storage_roots
  ADD CONSTRAINT storage_roots_provider_check CHECK (provider IN ('local', 'gateway'));
