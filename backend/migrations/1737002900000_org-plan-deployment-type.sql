-- Descriptive commercial/deployment metadata on the organisation record. This
-- is PURELY descriptive — it does not touch tenant_id, RLS, or anything about
-- how tenancy works (S1). It just records two facts about the tenant that the
-- product will branch on later.
--
--   plan            — the commercial plan: 'saas' | 'enterprise'.
--   deployment_type — 'hosted' (the only thing Stage 1 actually supports) |
--                     'client_server'. Defaulted to 'hosted' and left that way
--                     until the Prompt-45 discovery pass concludes anything
--                     about actually supporting a second deployment type. The
--                     column existing now, defaulted, is deliberate: it lets the
--                     UI show the fact without pretending the capability exists.

-- Up Migration

ALTER TABLE organisations
  ADD COLUMN plan text NOT NULL DEFAULT 'saas'
    CHECK (plan IN ('saas', 'enterprise'));

ALTER TABLE organisations
  ADD COLUMN deployment_type text NOT NULL DEFAULT 'hosted'
    CHECK (deployment_type IN ('hosted', 'client_server'));

COMMENT ON COLUMN organisations.plan IS
  'Commercial plan (descriptive): saas | enterprise. Defaults to saas. Not tied '
  'to tenancy, RLS, or feature-gating yet — visibility only.';
COMMENT ON COLUMN organisations.deployment_type IS
  'Deployment model (descriptive): hosted | client_server. Defaults to hosted, '
  'the only model Stage 1 supports; client_server is a placeholder pending the '
  'Prompt-45 discovery pass. Visibility only.';

-- Existing rows: the NOT NULL DEFAULT already backfilled every current org to
-- saas / hosted. Stated explicitly here so the intent is on the record.
-- (No UPDATE needed — DEFAULT applied to all existing rows on ADD COLUMN.)

-- Down Migration

ALTER TABLE organisations DROP COLUMN IF EXISTS deployment_type;
ALTER TABLE organisations DROP COLUMN IF EXISTS plan;
