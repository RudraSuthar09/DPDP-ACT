-- Consent forms, new UX model: a form is a name plus a FLAT, MUTABLE list of
-- "consent rows" built on one screen — replacing the append-only
-- version/version-purposes structure from 1737002700000. Each row is a typed
-- label + a short notice sentence + an active toggle + an optional direct link
-- to a Data Inventory element; behind the scenes a row still resolves to a REAL
-- versioned consent_purpose + consent_notice_version, so proof-of-consent is
-- unchanged: every consent_event still records the exact notice_version_id.
--
-- WHY MUTABLE ROWS RATHER THAN MORE VERSIONS. The new model toggles rows (and
-- whole forms) active/inactive live, and a single tenant-wide website embed
-- reflects those toggles with no client code change. Minting a new immutable
-- form version on every toggle is the wrong shape for that. So the builder's
-- definition lives in a mutable table; the append-only guarantee that actually
-- matters for the Act — "what exact notice did this person agree to, and when" —
-- is on consent_events / consent_notice_versions, both untouched here. Each
-- submission additionally SNAPSHOTS the notice_version_id it showed per row.
--
-- The versioned purpose+notice data model (consent_purposes/_versions,
-- consent_notice_versions/_translations) is PRESERVED verbatim. Only the form's
-- own bookkeeping structure changes.

-- Up Migration

-- 1. The form's own name now lives on the form (it used to live on each version
--    title; versions are being retired below). And the live-embed switch:
--    is a form currently being served to the public? Distinct from `status`
--    (draft/published/archived) — a form can be toggled off the website without
--    being un-published/archived.
ALTER TABLE consent_forms ADD COLUMN name text NOT NULL DEFAULT 'Untitled form';
ALTER TABLE consent_forms ADD COLUMN description text;
ALTER TABLE consent_forms ADD COLUMN is_active boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN consent_forms.is_active IS
  'The live switch read by the tenant-wide website embed and the hosted link. '
  'Toggling it changes what the public sees with no client-side code change.';

-- The Prompt-39 directory trigger derived the public form title from a version
-- row; versions are gone, so redefine it to read the name straight off the form.
CREATE OR REPLACE FUNCTION app.sync_consent_form_directory() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, app, public
AS $fn$
BEGIN
  IF NEW.slug IS NOT NULL THEN
    INSERT INTO app.consent_form_directory (slug, tenant_id, form_id, title)
    VALUES (NEW.slug, NEW.tenant_id, NEW.id, NEW.name)
    ON CONFLICT (slug) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id, title = EXCLUDED.title, updated_at = now();
  END IF;
  RETURN NEW;
END
$fn$;

-- 2. The mutable flat list of consent rows — the builder edits these directly.
CREATE TABLE consent_form_rows (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL DEFAULT app.current_tenant()
                              REFERENCES organisations (id),
  form_id                   uuid NOT NULL REFERENCES consent_forms (id),

  -- The real, versioned purpose this row asks about, auto-created or reused
  -- from the row's label. The row NEVER invents a second consent identity —
  -- it is a friendly face over a genuine consent_purpose.
  consent_purpose_id        uuid NOT NULL REFERENCES consent_purposes (id),
  -- The exact notice version this row currently shows. Editing the row's notice
  -- text publishes a NEW consent_notice_version and repoints this column; old
  -- submissions keep the id they were shown (snapshotted on the answer).
  notice_version_id         uuid NOT NULL REFERENCES consent_notice_versions (id),

  -- Denormalised display copies, so rendering the public form/embed needs no
  -- join back through purpose/notice versions. Kept in step by the service.
  label                     text NOT NULL,
  notice_text               text NOT NULL,

  -- The optional direct link to a Data Inventory element. Display/intent lives
  -- here; the actual Tier-1 attribution is the consent_purpose_inventory_links
  -- row(s) the service creates from this purpose to that element's purposes
  -- (Prompt 32's mechanism, reused — not a second scheme).
  inventory_entry_id        uuid REFERENCES inventory_register_entries (id),

  active                    boolean NOT NULL DEFAULT true,
  display_order             integer NOT NULL DEFAULT 0,
  -- Rows are soft-removed (I4-consistent): a removed row stays for any
  -- submission that referenced it, it just leaves the builder + the embed.
  status                    text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'removed')),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE consent_form_rows IS
  'The mutable flat list of consent rows a form is built from (new UX model). '
  'Each resolves to a real versioned consent_purpose + consent_notice_version; '
  'proof-of-consent stays on consent_events. active/is_active toggles drive the '
  'live public embed. Soft-removed, never hard-deleted.';

SELECT app.apply_tenant_rls('public.consent_form_rows');

CREATE INDEX consent_form_rows_form_idx
  ON consent_form_rows (tenant_id, form_id, display_order);
-- One active row per (form, purpose): a form does not ask the same purpose twice.
CREATE UNIQUE INDEX consent_form_rows_form_purpose_uq
  ON consent_form_rows (tenant_id, form_id, consent_purpose_id)
  WHERE status = 'active';

CREATE TRIGGER consent_form_rows_touch_updated_at
  BEFORE UPDATE ON consent_form_rows
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- 3. Submissions snapshot which notice version each answer was shown, and no
--    longer reference a form VERSION (there are none). form_id stays.
ALTER TABLE consent_form_submission_answers
  ADD COLUMN notice_version_id uuid REFERENCES consent_notice_versions (id);

COMMENT ON COLUMN consent_form_submission_answers.notice_version_id IS
  'Snapshot of the exact notice version this row showed at submit time — the '
  'per-answer proof anchor, alongside consent_events.notice_version_id.';

ALTER TABLE consent_form_submissions DROP CONSTRAINT IF EXISTS consent_form_submissions_form_version_id_fkey;
ALTER TABLE consent_form_submissions DROP COLUMN IF EXISTS form_version_id;

-- 4. Retire the append-only version tables — superseded by consent_form_rows.
--    (Only session test data existed in them; nothing production depends on it.)
DROP TABLE IF EXISTS consent_form_version_purposes;
DROP TABLE IF EXISTS consent_form_versions;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS last_published_version_number;

-- Down Migration

ALTER TABLE consent_forms ADD COLUMN last_published_version_number integer;

CREATE TABLE consent_form_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  form_id        uuid NOT NULL REFERENCES consent_forms (id),
  version_number integer NOT NULL,
  title          text NOT NULL,
  description    text,
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, version_number)
);
SELECT app.apply_tenant_rls('public.consent_form_versions');

CREATE TABLE consent_form_version_purposes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL DEFAULT app.current_tenant() REFERENCES organisations (id),
  form_version_id    uuid NOT NULL REFERENCES consent_form_versions (id),
  consent_purpose_id uuid NOT NULL REFERENCES consent_purposes (id),
  notice_version_id  uuid NOT NULL REFERENCES consent_notice_versions (id),
  display_order      integer NOT NULL DEFAULT 0,
  UNIQUE (form_version_id, consent_purpose_id)
);
SELECT app.apply_tenant_rls('public.consent_form_version_purposes');

ALTER TABLE consent_form_submission_answers DROP COLUMN IF EXISTS notice_version_id;
ALTER TABLE consent_form_submissions ADD COLUMN form_version_id uuid;

-- Restore the Prompt-39 version-derived directory trigger.
CREATE OR REPLACE FUNCTION app.sync_consent_form_directory() RETURNS trigger
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

DROP TABLE IF EXISTS consent_form_rows;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS is_active;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS description;
ALTER TABLE consent_forms DROP COLUMN IF EXISTS name;
