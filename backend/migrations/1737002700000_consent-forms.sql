-- Consent forms: a tenant-authored bundle of real consent purposes, published
-- either as an embeddable widget (reusing the Prompt 24 publishable-key/SDK
-- surface) or as a hosted public link (reusing the Prompt 25 portal-slug
-- pattern). Submitting a form writes ORDINARY consent_events through the same
-- ConsentService.recordConsent() path everything else uses (R3) — this
-- migration adds no second way into that table, only the bookkeeping a staff
-- screen needs to list what was submitted, when, and through which exact form
-- wording.
--
-- VERSIONING FOLLOWS THE SAME DISCIPLINE AS EVERYTHING ELSE (I4): editing a
-- published form must never change what a past submitter actually saw and
-- agreed to. consent_form_versions is append-only; a submission stores the
-- exact form_version_id shown, and consent_form_version_purposes freezes the
-- notice_version_id each purpose pointed to AT THE TIME THAT VERSION WAS
-- SAVED — later edits to the underlying purpose's notice (Prompt 18) never
-- retroactively change what an old form version is recorded as having shown.

-- Up Migration

-- ===========================================================================
-- 1. THE FORM ITSELF — a lifecycle row (draft/published/archived) plus
-- append-only versions, same split as consent_purposes/_versions.
-- ===========================================================================
CREATE TABLE consent_forms (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL DEFAULT app.current_tenant()
                               REFERENCES organisations (id),

  status                     text NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'published', 'archived')),

  -- NULL until the first publish. Minted once (app.mint_form_slug) and never
  -- reminted on a later publish, so a link/QR code a client has already
  -- printed keeps working across edits — exactly like organisations.portal_slug.
  slug                       text,

  -- Which version is currently live for the two public routes. NULL while the
  -- form has never been published. Republishing after an edit moves this
  -- forward; it never moves backward and never touches an older version's row.
  last_published_version_number integer,

  created_by                 uuid REFERENCES users (id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE consent_forms IS
  'A tenant-authored consent form: a title/description plus an ordered set of '
  'real consent purposes, distributable as an embeddable widget or a hosted '
  'public link. Lifecycle row only — content lives in consent_form_versions.';

SELECT app.apply_tenant_rls('public.consent_forms');

CREATE UNIQUE INDEX consent_forms_slug_uq ON consent_forms (slug) WHERE slug IS NOT NULL;

CREATE TRIGGER consent_forms_touch_updated_at
  BEFORE UPDATE ON consent_forms
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE consent_form_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  form_id        uuid NOT NULL REFERENCES consent_forms (id),
  version_number integer NOT NULL,
  title          text NOT NULL,
  description    text,
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (form_id, version_number)
);

COMMENT ON TABLE consent_form_versions IS
  'Append-only content for consent_forms — one row per edit, never updated in '
  'place. A submission always names the exact row it was shown (I4).';

SELECT app.apply_tenant_rls('public.consent_form_versions');

CREATE INDEX consent_form_versions_form_idx ON consent_form_versions (tenant_id, form_id, version_number DESC);

-- Which real consent purposes a form version asks about, in what order, and —
-- the traceability anchor — which exact notice version each one pointed to
-- when this form version was saved. consent_notice_versions/_translations
-- (Prompt 18) are themselves append-only, so freezing the id here is enough:
-- that row's text can never change under it.
CREATE TABLE consent_form_version_purposes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant()
                       REFERENCES organisations (id),
  form_version_id    uuid NOT NULL REFERENCES consent_form_versions (id),
  consent_purpose_id uuid NOT NULL REFERENCES consent_purposes (id),
  notice_version_id  uuid NOT NULL REFERENCES consent_notice_versions (id),
  display_order      integer NOT NULL DEFAULT 0,

  UNIQUE (form_version_id, consent_purpose_id)
);

COMMENT ON TABLE consent_form_version_purposes IS
  'One row per question on a form version: a real consent purpose plus the '
  'exact notice_version_id it showed, frozen at save time.';

SELECT app.apply_tenant_rls('public.consent_form_version_purposes');

CREATE INDEX consent_form_version_purposes_version_idx
  ON consent_form_version_purposes (tenant_id, form_version_id, display_order);

-- ===========================================================================
-- 2. SUBMISSIONS — bookkeeping only. The consent itself is already durable in
-- consent_events by the time a submission row is written; this exists purely
-- so a staff screen can list "what came in on this form" without reverse-
-- engineering it from the event log, and so a subject's own timeline
-- (Prompt 21) can be joined to "which form" without guessing.
-- ===========================================================================
CREATE TABLE consent_form_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL DEFAULT app.current_tenant()
                    REFERENCES organisations (id),
  form_id         uuid NOT NULL REFERENCES consent_forms (id),
  form_version_id uuid NOT NULL REFERENCES consent_form_versions (id),

  -- Same HMAC subject_ref every other consent surface uses (SubjectRefHasher) —
  -- never a raw customer id, name, email or phone (I2).
  subject_ref     text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('widget', 'link')),

  submitted_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE consent_form_submissions IS
  'One row per form submission (widget or hosted link). Bookkeeping only — the '
  'actual consent is in consent_events, written via ConsentService before this '
  'row exists (R3). subject_ref is the same per-tenant HMAC everywhere else uses.';

SELECT app.apply_tenant_rls('public.consent_form_submissions');

CREATE INDEX consent_form_submissions_form_idx ON consent_form_submissions (tenant_id, form_id, submitted_at DESC);
CREATE INDEX consent_form_submissions_subject_idx ON consent_form_submissions (tenant_id, subject_ref);

CREATE TABLE consent_form_submission_answers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant()
                       REFERENCES organisations (id),
  submission_id      uuid NOT NULL REFERENCES consent_form_submissions (id),
  consent_purpose_id uuid NOT NULL REFERENCES consent_purposes (id),
  granted            boolean NOT NULL,

  -- The consent_events row this answer produced, when granted=true. NOT a
  -- foreign key: consent_events is HASH-partitioned on tenant_id with a
  -- composite (tenant_id, id) primary key, and nothing else in the schema
  -- references it either (it is an append-only log, not a lookup target) —
  -- same reasoning, same absence of an FK, as everywhere else that only ever
  -- reads consent_events by (tenant_id, subject_ref)/(tenant_id, purpose_id).
  consent_event_id   uuid,

  UNIQUE (submission_id, consent_purpose_id)
);

COMMENT ON TABLE consent_form_submission_answers IS
  'Per-purpose answer on a submission. granted=true rows carry the id of the '
  'real consent_events row ConsentService.recordConsent() wrote for them.';

SELECT app.apply_tenant_rls('public.consent_form_submission_answers');

CREATE INDEX consent_form_submission_answers_submission_idx
  ON consent_form_submission_answers (tenant_id, submission_id);

-- ===========================================================================
-- 3. THE HOSTED-LINK PEEPHOLE: slug -> (tenant, form) — the form-level sibling
-- of app.resolve_portal_slug (Prompt 25) and app.resolve_public_api_key
-- (Prompt 24). Same reasoning as both: consent_forms is FORCE ROW LEVEL
-- SECURITY, so a SECURITY DEFINER function reading it directly would run as
-- the owner with no tenant GUC set and silently return zero rows. Hence a
-- shadow table, kept in sync by trigger, exactly like app.org_directory.
--
-- THE SLUG IS AN IDENTIFIER, NOT A CREDENTIAL — same as the portal slug.
-- Resolving it only answers "which tenant, and which form, does this public
-- page render?"; it authorises nothing beyond seeing the form's own questions
-- and submitting an answer, which still has to pass the rate limiter and, like
-- every other public write, is fully audited with a NULL actor.
-- ===========================================================================
CREATE FUNCTION app.mint_form_slug(p_title text, p_id uuid) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $fn$
  SELECT COALESCE(
           NULLIF(left(trim(BOTH '-' FROM regexp_replace(lower(p_title), '[^a-z0-9]+', '-', 'g')), 40), ''),
           'form'
         )
         || '-' || left(encode(sha256(convert_to(p_id::text, 'UTF8')), 'hex'), 6);
$fn$;

COMMENT ON FUNCTION app.mint_form_slug(text, uuid) IS
  'Derives a public form slug from its title plus a 6-hex digest of its id. '
  'Called once, at first publish (never on an insert trigger — a draft form has '
  'no public slug at all). NOT a secret; the slug is NOT a credential.';

CREATE TABLE app.consent_form_directory (
  slug       text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  form_id    uuid NOT NULL,
  title      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE app.consent_form_directory IS
  'slug -> (tenant_id, form_id, title). Deliberately NOT row-level-secured and '
  'NOT granted to dpdp_app: reachable only via app.resolve_consent_form_slug(). '
  'Maintained by trigger from public.consent_forms. Sibling of app.org_directory '
  'and app.api_key_directory. See Seam S1.';

-- NO GRANTS TO dpdp_app ON THIS TABLE. The omission is the control.

CREATE FUNCTION app.sync_consent_form_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF NEW.slug IS NOT NULL THEN
    INSERT INTO app.consent_form_directory (slug, tenant_id, form_id, title)
    SELECT NEW.slug, NEW.tenant_id, NEW.id, v.title
      FROM consent_form_versions v
     WHERE v.form_id = NEW.id AND v.version_number = NEW.last_published_version_number
    ON CONFLICT (slug) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id, title = EXCLUDED.title, updated_at = now();
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER consent_forms_sync_directory
  AFTER INSERT OR UPDATE ON consent_forms
  FOR EACH ROW EXECUTE FUNCTION app.sync_consent_form_directory();

CREATE FUNCTION app.resolve_consent_form_slug(p_slug text)
  RETURNS TABLE (tenant_id uuid, form_id uuid, title text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, app
AS $fn$
  SELECT d.tenant_id, d.form_id, d.title FROM app.consent_form_directory d WHERE d.slug = p_slug;
$fn$;

COMMENT ON FUNCTION app.resolve_consent_form_slug(text) IS
  'The public-form peephole: exact slug -> (tenant_id, form_id, title). Exact '
  'match only. Resolving a slug ESTABLISHES WHICH TENANT AND FORM a public page '
  'is about; it AUTHORISES NOTHING, unlike app.resolve_public_api_key.';

REVOKE ALL ON FUNCTION app.sync_consent_form_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_consent_form_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_consent_form_slug(text) TO dpdp_app;
GRANT EXECUTE ON FUNCTION app.mint_form_slug(text, uuid) TO dpdp_app;

-- Down Migration

DROP FUNCTION IF EXISTS app.resolve_consent_form_slug(text);
DROP TRIGGER IF EXISTS consent_forms_sync_directory ON consent_forms;
DROP FUNCTION IF EXISTS app.sync_consent_form_directory();
DROP TABLE IF EXISTS app.consent_form_directory;
DROP FUNCTION IF EXISTS app.mint_form_slug(text, uuid);

DROP TABLE IF EXISTS consent_form_submission_answers;
DROP TABLE IF EXISTS consent_form_submissions;
DROP TABLE IF EXISTS consent_form_version_purposes;
DROP TABLE IF EXISTS consent_form_versions;
DROP TABLE IF EXISTS consent_forms;
