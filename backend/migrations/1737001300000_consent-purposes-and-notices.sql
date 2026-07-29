-- Consent purposes, upgraded to a proper versioned/tombstoned entity, plus
-- Notice management (FR-CON-01/02).
--
-- CONTEXT — do not re-derive this from scratch, read it:
-- `consent_purposes` has existed since Prompt 1 as one of the two "trivial
-- tenant-scoped tables" that proved the Seam S1 RLS pattern (see
-- 1737000100000_organisations-and-tenant-tables.sql) — id/tenant_id/name/
-- created_at, nothing else. Seam S2 (1737000400000_seams-s2-s3-s4.sql) then
-- put a REAL foreign key on it: `consent_events.purpose_id REFERENCES
-- consent_purposes (id)`. That FK, the EventSink (`app.consent_append`), and
-- the `consent_events` table itself are NOT touched by this migration — this
-- migration only ADDS lifecycle columns to consent_purposes (its `id` and
-- every existing row survive untouched) and ADDS new tables alongside it.
-- Nothing here can break a consent event that already references a purpose.
--
-- Same split used everywhere else in this codebase (inventory_register_entries
-- /_versions, inventory_entry_purposes/_versions): a lifecycle table
-- (active/tombstoned, never hard-deleted — I4) plus an append-only content
-- table. `consent_purposes` BECOMES the lifecycle table (its old flat `name`
-- column is frozen/deprecated, same treatment as inventory's deprecated
-- columns); `consent_purpose_versions` is the new content history.
--
-- Notices (FR-CON-02) are a new one-to-many-many-more concept on top: one
-- purpose has many notice VERSIONS over time (append-only, an edit creates a
-- new version), and each version has many per-language TRANSLATIONS (DPDP
-- Eighth Schedule languages + English). A notice version is never itself
-- edited after creation — there is no lifecycle/tombstone table for it, the
-- same way inventory_register_entry_versions has none: superseding IS the
-- edit. `consent_notice_versions.id` is deliberately a plain, stable UUID —
-- this is the "notice_version_id" Prompt 20's consent ingest will eventually
-- validate against and stamp onto every consent_events row. That column on
-- consent_events stays exactly as it is today (free text, untouched here);
-- wiring the two together is Prompt 20's job, not this one's.

-- Up Migration

-- --- consent_purposes: trivial table -> lifecycle table ---------------------

ALTER TABLE consent_purposes
  ADD COLUMN status           text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'tombstoned')),
  ADD COLUMN tombstone_reason text,
  ADD COLUMN tombstoned_at    timestamptz,
  ADD COLUMN tombstoned_by    uuid REFERENCES users (id),
  ADD COLUMN updated_at       timestamptz NOT NULL DEFAULT now();

ALTER TABLE consent_purposes ALTER COLUMN name DROP NOT NULL;

COMMENT ON COLUMN consent_purposes.name IS
  'DEPRECATED (FR-CON-01): frozen historical value from before purposes were '
  'versioned. New rows leave this NULL — the current name lives on '
  'consent_purpose_versions, exactly like inventory_register_entries.category '
  'was superseded by its _versions table. Never rewritten (I4).';

COMMENT ON TABLE consent_purposes IS
  'FR-CON-01: one row per consent purpose (e.g. "marketing email"). Lifecycle '
  'only (active/tombstoned) — content lives in consent_purpose_versions. '
  'consent_events.purpose_id REFERENCES this table''s id (Seam S2); that FK '
  'and the id column are untouched by this migration.';

CREATE INDEX consent_purposes_tenant_status_idx
  ON consent_purposes (tenant_id, status);

CREATE TABLE consent_purpose_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  purpose_id     uuid NOT NULL REFERENCES consent_purposes (id),
  version_number integer NOT NULL CHECK (version_number > 0),

  purpose_name   text NOT NULL,
  description    text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users (id),

  CONSTRAINT consent_purpose_versions_unique UNIQUE (purpose_id, version_number)
);

COMMENT ON TABLE consent_purpose_versions IS
  'FR-CON-01: append-only content history for one consent purpose, same '
  'pattern as inventory_register_entry_versions. An edit INSERTs a new row; '
  'application code never UPDATEs or DELETEs an existing one.';

-- Backfill: every purpose created before this migration gets a v1 version
-- carrying its old flat `name` forward, so listPurposes()/findPurpose() (now
-- reading through the version join) keep seeing every purpose that already
-- exists — including ones consent_events already reference via purpose_id.
-- Skipping this would silently 404 a live consent purpose (and anything
-- naively re-checking it) the moment this migration lands.
--
-- consent_purposes has FORCE ROW LEVEL SECURITY (from apply_tenant_rls,
-- Prompt 1) and this migration runs as the table OWNER, which FORCE makes
-- subject to RLS same as anyone else — so a plain cross-tenant SELECT here
-- would silently return zero rows (app.current_tenant() is unset mid-
-- migration), not an error. Toggle FORCE off for exactly this one statement,
-- restore it immediately after. consent_purpose_versions itself gets its RLS
-- policy applied only AFTER this backfill (below), so the INSERT below is
-- unrestricted too.
ALTER TABLE consent_purposes NO FORCE ROW LEVEL SECURITY;

INSERT INTO consent_purpose_versions (tenant_id, purpose_id, version_number, purpose_name, created_at)
SELECT tenant_id, id, 1, name, created_at
  FROM consent_purposes
 WHERE name IS NOT NULL;

ALTER TABLE consent_purposes FORCE ROW LEVEL SECURITY;

SELECT app.apply_tenant_rls('public.consent_purpose_versions');

CREATE INDEX consent_purpose_versions_current_idx
  ON consent_purpose_versions (purpose_id, version_number DESC);

-- --- Notices (FR-CON-02) -----------------------------------------------------

CREATE TABLE consent_notice_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant()
                   REFERENCES organisations (id),
  purpose_id     uuid NOT NULL REFERENCES consent_purposes (id),
  version_number integer NOT NULL CHECK (version_number > 0),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid REFERENCES users (id),

  CONSTRAINT consent_notice_versions_unique UNIQUE (purpose_id, version_number)
);

COMMENT ON TABLE consent_notice_versions IS
  'FR-CON-02: one row per published notice version for a purpose. Append-only '
  '— editing a notice INSERTs a new version, never rewrites this one (I4), '
  'same pattern as consent_purpose_versions. This id is the first-class, '
  'referenceable notice_version_id designed for Prompt 20''s consent ingest '
  'to stamp onto consent_events.notice_version_id (that column stays free '
  'text today; validating/linking it is Prompt 20''s job, not this one''s).';

SELECT app.apply_tenant_rls('public.consent_notice_versions');

CREATE INDEX consent_notice_versions_current_idx
  ON consent_notice_versions (purpose_id, version_number DESC);

CREATE TABLE consent_notice_translations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),
  notice_version_id uuid NOT NULL REFERENCES consent_notice_versions (id),

  -- DPDP Act Eighth Schedule languages, plus English (Section 3's notice
  -- requirement: "English or any language specified in the Eighth Schedule").
  -- Codes: ISO 639 where one exists; ISO 15924/common abbreviations for the
  -- three that lack a widely-used ISO 639-1 code (bodo/dogri/santali).
  language          text NOT NULL
                      CHECK (language IN (
                        'en', 'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'kn', 'ks',
                        'kok', 'mai', 'ml', 'mni', 'mr', 'ne', 'or', 'pa', 'sa',
                        'sat', 'sd', 'ta', 'te', 'ur'
                      )),
  body              text NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consent_notice_translations_unique UNIQUE (notice_version_id, language)
);

COMMENT ON TABLE consent_notice_translations IS
  'FR-CON-02: per-language notice text for one immutable notice version. '
  'Never updated after creation — a correction is a new notice VERSION (all '
  'its translations together), not an edit of a single language row (I4).';

SELECT app.apply_tenant_rls('public.consent_notice_translations');

CREATE INDEX consent_notice_translations_version_idx
  ON consent_notice_translations (notice_version_id);

-- Down Migration

DROP TABLE IF EXISTS consent_notice_translations;
DROP TABLE IF EXISTS consent_notice_versions;
DROP TABLE IF EXISTS consent_purpose_versions;

ALTER TABLE consent_purposes
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS tombstone_reason,
  DROP COLUMN IF EXISTS tombstoned_at,
  DROP COLUMN IF EXISTS tombstoned_by,
  DROP COLUMN IF EXISTS updated_at;

ALTER TABLE consent_purposes ALTER COLUMN name SET NOT NULL;

DROP INDEX IF EXISTS consent_purposes_tenant_status_idx;
