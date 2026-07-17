-- Identity & Tenancy — FR-IDN-01 (org self-registration -> isolated workspace),
-- FR-IDN-02 (email + password + MFA), FR-IDN-03 (RBAC skeleton).
--
-- Everything tenant-facing here is a normal tenant table: it carries tenant_id,
-- defaults it to app.current_tenant(), and calls app.apply_tenant_rls(). Users
-- are not special — a user of tenant A is exactly as invisible to tenant B as an
-- inventory category is (I3).
--
-- ===========================================================================
-- THE ONE HARD PROBLEM IN THIS MIGRATION: the login chicken-and-egg.
--
-- Seam S1 binds every query to the tenant from the JWT. But at LOGIN there is no
-- JWT yet — that is what login mints. So "find the user with this email" cannot
-- run under a tenant context, because the tenant is precisely what we are trying
-- to discover. Three ways out, and why this one:
--
--   (a) Put users outside RLS.            -> Rejected. Voids I3 for the table
--                                           that holds password hashes.
--   (b) Make the user type the org name.  -> Rejected for Stage 1. Pushes a
--                                           platform design flaw onto the user.
--   (c) A narrow, auditable peephole.     -> Chosen, below.
--
-- The peephole is `app.user_directory`: email -> (user_id, tenant_id, status),
-- and NOTHING else. It lives in the `app` schema, it is owned by dpdp_owner, and
-- dpdp_app is granted NO privileges on it whatsoever — the app literally cannot
-- SELECT it and therefore cannot enumerate it. The only way through is
-- `app.resolve_login(email)`, a SECURITY DEFINER function that takes an exact
-- email and returns at most one row of three ids. No password hash, no name, no
-- LIKE, no listing. Everything else about authentication — verifying the
-- password, checking MFA, reading the role — happens inside runWithTenant()
-- under full RLS, exactly like every other query in the system.
--
-- The directory is maintained by a TRIGGER on `users`, not by application code,
-- so it cannot drift out of sync and no service can forget to update it.
-- `backend/test/isolation/identity-peephole.isolation-spec.ts` pins all of this.
-- ===========================================================================

-- Up Migration

-- ---------------------------------------------------------------------------
-- 1. Users — a tenant table like any other.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant()
                  REFERENCES organisations (id),

  -- Stored lowercase so lookups are exact-match (no citext extension needed on
  -- managed Postgres, no functional-index subtleties, no case-confusion login
  -- bugs). The app normalises; the CHECK guarantees it regardless of the app.
  email         text NOT NULL CHECK (email = lower(email) AND email LIKE '%@%'),
  full_name     text NOT NULL,

  -- Password (FR-IDN-02). `algo` is stored per row so a future migration to
  -- Argon2id can rehash lazily on next successful login without a flag day.
  password_hash text NOT NULL,
  password_algo text NOT NULL DEFAULT 'scrypt',

  -- RBAC (FR-IDN-03). One role per user in Stage 1; Stage 2 makes this granular
  -- (likely a user_roles join + permissions). Kept in sync with the `Role` union
  -- in @dpdp/shared — the CHECK is the enforcement, the TS type is the ergonomics.
  role          text NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('owner', 'dpo', 'compliance_officer',
                                  'grievance_officer', 'auditor', 'viewer')),

  -- Lifecycle (FR-IDN-05). NEVER hard-deleted — platform rule, and I4. Note the
  -- engine agrees: app.apply_tenant_rls() grants no DELETE to dpdp_app, so a
  -- hard delete is not merely discouraged, it is unexpressible at runtime.
  --   active    — can log in.
  --   suspended — cannot log in; reversible.
  --   removed   — tombstone. Cannot log in, never reversible in place, row and
  --               its audit trail survive forever.
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'removed')),
  status_reason text,
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES users (id),

  -- MFA / TOTP (FR-IDN-02). The secret is AES-256-GCM ciphertext, never plaintext
  -- (NFR-SEC-03); the key comes from env today and KMS later — see SecretCipher.
  -- `mfa_enrolled_at` is set only when a first code is CONFIRMED, so an abandoned
  -- enrolment never locks anyone out.
  mfa_secret_ciphertext text,
  mfa_enrolled_at       timestamptz,
  -- The last TOTP step consumed, to make a code single-use. Without this, a code
  -- observed over the shoulder (or in a phished session) is replayable for its
  -- whole window. RFC 6238 §5.2 requires exactly this.
  mfa_last_step         bigint,

  -- Online-guessing defence (login throttling).
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Email is unique per tenant here; it is ALSO unique platform-wide via the
  -- directory PK (see §4). This one keeps the invariant true even if the
  -- directory were ever relaxed to allow multi-tenant emails.
  CONSTRAINT users_email_unique_per_tenant UNIQUE (tenant_id, email)
);

COMMENT ON TABLE users IS
  'Platform users, scoped to one tenant (FR-IDN-01/02/03). Never hard-deleted: '
  'status active -> suspended -> removed (tombstone). dpdp_app holds no DELETE '
  'grant, so this is enforced by the engine, not by convention.';

SELECT app.apply_tenant_rls('public.users');

-- Login reads the row by email under a known tenant; this index serves that and
-- the per-tenant user list.
CREATE INDEX users_tenant_status_idx ON users (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 2. MFA recovery codes.
--    A TOTP rollout with no recovery path turns a lost phone into a support
--    ticket that ends in someone disabling MFA over email — i.e. the whole
--    control, defeated at its weakest moment. Codes are stored as hashes (they
--    are credentials), single-use, and burned by setting used_at (never DELETE).
-- ---------------------------------------------------------------------------
CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant()
               REFERENCES organisations (id),
  user_id    uuid NOT NULL REFERENCES users (id),
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_recovery_codes IS
  'Single-use MFA recovery codes, stored hashed. Burned by setting used_at — '
  'never deleted (I4).';

SELECT app.apply_tenant_rls('public.user_recovery_codes');

CREATE INDEX user_recovery_codes_user_idx ON user_recovery_codes (tenant_id, user_id);

-- ---------------------------------------------------------------------------
-- 3. Workspace modules — the "fully isolated workspace with all five module
--    areas" of FR-IDN-01, made concrete and inspectable.
--
--    Registration provisions one row per module area, so "the workspace has all
--    five areas" is a fact you can query and test, not a claim in a comment. It
--    is also where per-module enablement/config lands as modules grow.
-- ---------------------------------------------------------------------------
CREATE TABLE workspace_modules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  -- The five PRODUCT module areas (§ "The five modules"). The cross-cutting
  -- modules (identity/audit/notify) are platform machinery, not workspace areas,
  -- and deliberately absent.
  module         text NOT NULL
                   CHECK (module IN ('inventory', 'consent', 'breach',
                                     'grievance', 'dprequest')),
  enabled        boolean NOT NULL DEFAULT true,
  provisioned_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_modules_unique UNIQUE (tenant_id, module)
);

COMMENT ON TABLE workspace_modules IS
  'One row per product module area, provisioned at organisation sign-up '
  '(FR-IDN-01). Makes "the workspace has all five areas" a queryable fact.';

SELECT app.apply_tenant_rls('public.workspace_modules');

-- ---------------------------------------------------------------------------
-- 4. The login peephole (see the header). NOT a tenant table — deliberately,
--    and this is the only such table in the system.
-- ---------------------------------------------------------------------------
CREATE TABLE app.user_directory (
  -- Platform-wide email uniqueness is a Stage-1 simplification: one login, one
  -- workspace. To relax it later (one human, two orgs), drop this PK for a
  -- surrogate + UNIQUE (email, tenant_id), have resolve_login return every
  -- match, and make login ask which workspace when it gets more than one. The
  -- function signature below already returns SETOF, so that change does not
  -- reach the callers.
  email      text PRIMARY KEY CHECK (email = lower(email)),
  user_id    uuid NOT NULL,
  tenant_id  uuid NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.user_directory IS
  'email -> (user_id, tenant_id, status). The ONLY cross-tenant table on the '
  'platform, and the answer to "which tenant is this login?" before a JWT '
  'exists. dpdp_app has NO privileges on it: reachable only via '
  'app.resolve_login(). Maintained by trigger from public.users — never by '
  'application code. See Seam S1.';

-- NO GRANTS TO dpdp_app ON THIS TABLE. That omission is the security control;
-- it is asserted by the isolation suite so a future migration cannot quietly
-- add one.

-- Keep the directory in lockstep with users. A trigger, not a service call,
-- because a service call is something a future code path can forget to make.
CREATE FUNCTION app.sync_user_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  -- Pin search_path: a SECURITY DEFINER function without this is the classic
  -- privilege-escalation hole (caller-controlled search_path shadows a table or
  -- operator and the body runs it as the owner).
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO app.user_directory (email, user_id, tenant_id, status)
    VALUES (NEW.email, NEW.id, NEW.tenant_id, NEW.status);
  ELSE
    UPDATE app.user_directory
       SET email = NEW.email, status = NEW.status, updated_at = now()
     WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION app.sync_user_directory() IS
  'Maintains app.user_directory from public.users. SECURITY DEFINER because '
  'dpdp_app cannot touch the directory directly — which is the point.';

CREATE TRIGGER users_sync_directory
  AFTER INSERT OR UPDATE OF email, status ON users
  FOR EACH ROW EXECUTE FUNCTION app.sync_user_directory();

-- The peephole itself. Exact match only. Three ids out. Nothing else.
CREATE FUNCTION app.resolve_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, status text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.user_id, d.tenant_id, d.status
  FROM app.user_directory d
  WHERE d.email = lower(p_email);
$fn$;

COMMENT ON FUNCTION app.resolve_login(text) IS
  'The login peephole: exact email -> (user_id, tenant_id, status). Returns no '
  'credential material and cannot list or pattern-match. Everything after this '
  'runs inside runWithTenant() under RLS. See Seam S1 / invariant I3.';

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. For a
-- SECURITY DEFINER function that is never what you want: lock it down and hand
-- it back to exactly one role.
REVOKE ALL ON FUNCTION app.sync_user_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_login(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_login(text) TO dpdp_app;

-- ---------------------------------------------------------------------------
-- 5. updated_at maintenance for users (evidence hygiene, I4).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS users_touch_updated_at ON users;
DROP TRIGGER IF EXISTS users_sync_directory ON users;
DROP FUNCTION IF EXISTS app.touch_updated_at();
DROP FUNCTION IF EXISTS app.resolve_login(text);
DROP FUNCTION IF EXISTS app.sync_user_directory();
DROP TABLE IF EXISTS app.user_directory;
DROP TABLE IF EXISTS workspace_modules;
DROP TABLE IF EXISTS user_recovery_codes;
DROP TABLE IF EXISTS users;
