-- FR-CON-09: the public Consent SDK needs a credential a third-party website
-- can safely embed in client-side JS. Staff JWTs cannot fill that role — a JWT
-- carries owner/dpo/compliance_officer authority, and anyone viewing page
-- source could lift it. This migration adds a narrowly-scoped, write-only
-- "publishable key" instead (Stripe publishable-key shape): one credential per
-- key, resolvable to a tenant, and good for exactly two things downstream
-- (record a consent event, withdraw one) — nothing else it could be used for
-- even if leaked, because everything it can reach still goes through the
-- existing ConsentService write path under RLS.
--
-- The hard part is the same "chicken and egg" problem login already solved:
-- resolving identity BEFORE a tenant exists, when every table's RLS policy is
-- `tenant_id = app.current_tenant()` and the GUC isn't set yet. This mirrors
-- app.resolve_login (1737000200000_identity.sql) exactly, including the part
-- that is easy to get wrong: `consent_api_keys` itself is FORCE ROW LEVEL
-- SECURITY (via app.apply_tenant_rls), and FORCE means RLS applies even to
-- the table owner — so a SECURITY DEFINER function reading consent_api_keys
-- directly would run as the owner, find no tenant GUC set, and silently see
-- ZERO rows. That is exactly why app.resolve_login does not read `users`
-- directly either: it reads `app.user_directory`, a deliberately UN-RLS'd
-- shadow table synced by trigger. app.api_key_directory below is the same
-- shape, scoped to the one thing the peephole needs to answer.

-- Up Migration

CREATE TABLE consent_api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant()
                REFERENCES organisations (id),

  -- SHA-256 of the raw key. The raw key itself is shown to staff exactly once,
  -- at creation, and never stored anywhere — this table can only ever confirm
  -- "does this hash match", never recover the key that produced it.
  key_hash    text NOT NULL,
  -- First few characters of the raw key, stored in the clear so staff can tell
  -- keys apart in a list without the value being useful for authentication.
  key_prefix  text NOT NULL,
  label       text NOT NULL,

  -- Who is accountable for this key. Also doubles as the TenantContext.userId
  -- for requests authenticated by it (PublicApiKeyMiddleware) — the audit
  -- table's actor column has a REFERENCES users(id) FK, and there is no user
  -- row for a key itself.
  created_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Tombstone, never a delete (I4). A key is revoked, not removed, so its
  -- entire usage history stays attributable.
  revoked_at  timestamptz,

  CONSTRAINT consent_api_keys_key_hash_unique UNIQUE (key_hash)
);

COMMENT ON TABLE consent_api_keys IS
  'FR-CON-09: tenant-scoped public write-only credentials for the Consent SDK. '
  'Resolvable pre-tenant via app.resolve_public_api_key() (through the '
  'app.api_key_directory shadow table below), the same shape as '
  'app.resolve_login() for users. Never stores the raw key — key_hash only.';

SELECT app.apply_tenant_rls('public.consent_api_keys');

-- ---------------------------------------------------------------------------
-- The peephole is `app.api_key_directory`: key_hash -> (tenant_id, key_id,
-- created_by, revoked_at), and NOTHING else. Same shape and same reasoning as
-- app.user_directory (1737000200000_identity.sql): it lives in the `app`
-- schema, is owned by the migration role, and dpdp_app is granted NO
-- privileges on it whatsoever. The only way through is
-- app.resolve_public_api_key(key_hash), a SECURITY DEFINER function that
-- takes an exact hash and returns at most one row of four ids.
-- ---------------------------------------------------------------------------
CREATE TABLE app.api_key_directory (
  key_hash    text PRIMARY KEY,
  key_id      uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  created_by  uuid NOT NULL,
  revoked_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.api_key_directory IS
  'key_hash -> (tenant_id, key_id, created_by, revoked_at). Deliberately NOT '
  'row-level-secured and NOT granted to dpdp_app: reachable only via '
  'app.resolve_public_api_key(). Maintained by trigger from '
  'public.consent_api_keys — never by application code. See Seam S1.';

-- NO GRANTS TO dpdp_app ON THIS TABLE. That omission is the security control,
-- same as app.user_directory.

CREATE FUNCTION app.sync_api_key_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.api_key_directory (key_hash, key_id, tenant_id, created_by, revoked_at)
    VALUES (NEW.key_hash, NEW.id, NEW.tenant_id, NEW.created_by, NEW.revoked_at);
  ELSE
    UPDATE app.api_key_directory
       SET revoked_at = NEW.revoked_at, updated_at = now()
     WHERE key_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION app.sync_api_key_directory() IS
  'Maintains app.api_key_directory from public.consent_api_keys. SECURITY '
  'DEFINER because dpdp_app cannot touch the directory directly — which is '
  'the point.';

CREATE TRIGGER consent_api_keys_sync_directory
  AFTER INSERT OR UPDATE ON consent_api_keys
  FOR EACH ROW EXECUTE FUNCTION app.sync_api_key_directory();

-- The public-SDK peephole. Exact hash match only, four ids out, nothing else —
-- no listing, no pattern matching, same shape as app.resolve_login().
CREATE FUNCTION app.resolve_public_api_key(p_key_hash text)
  RETURNS TABLE (tenant_id uuid, key_id uuid, created_by uuid, revoked_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.key_id, d.created_by, d.revoked_at
  FROM app.api_key_directory d
  WHERE d.key_hash = p_key_hash;
$fn$;

COMMENT ON FUNCTION app.resolve_public_api_key(text) IS
  'The public-SDK peephole: exact key hash -> (tenant_id, key_id, created_by, '
  'revoked_at). Mirrors app.resolve_login() — exact match only, minimal '
  'columns, no listing. Revocation is checked by the caller (revoked_at IS '
  'NOT NULL), not filtered here, so a revoked key still resolves and can be '
  'reported back as "invalid or revoked" rather than a bare lookup failure. '
  'See Seam S1 / invariant I3.';

-- Standard SECURITY DEFINER lockdown: nobody gets this by default, dpdp_app
-- gets EXECUTE and nothing else.
REVOKE ALL ON FUNCTION app.sync_api_key_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_public_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_public_api_key(text) TO dpdp_app;

-- Down Migration

DROP TRIGGER IF EXISTS consent_api_keys_sync_directory ON consent_api_keys;
DROP FUNCTION IF EXISTS app.resolve_public_api_key(text);
DROP FUNCTION IF EXISTS app.sync_api_key_directory();
DROP TABLE IF EXISTS app.api_key_directory;
DROP TABLE IF EXISTS consent_api_keys;
