-- Perf: the compliance dashboard's three open-count tiles (FR-DSH-01) each run
--   SELECT count(*) FROM workflow_jobs WHERE kind = $1 AND status = 'scheduled'
-- under RLS (DashboardService.summary() -> WorkflowJobsRepository.countOpenByKind,
-- called once per kind, in parallel, on every dashboard load).
--
-- workflow_jobs carries the full history of every deadline ever scheduled for
-- Breach, Grievance and DPRequest, and there is no retention job that prunes
-- 'fired'/'cancelled' rows (S3's durability requirement — a deadline is
-- evidence-adjacent, so nothing here is deleted). That means this table only
-- grows, and the two existing indexes do not serve this query well:
--   workflow_jobs_due_idx (status, run_at)       -- the untenanted ticker's index
--   workflow_jobs_tenant_idx (tenant_id, workflow_id) -- workflow_id lookups
--   workflow_jobs_unique (tenant_id, workflow_id, kind) -- the constraint
-- None puts status directly after (tenant_id, kind), so the planner picks
-- workflow_jobs_unique, walks every row for that tenant+kind, and filters
-- status row-by-row — a scan of the ENTIRE history (open, fired, and
-- cancelled alike) to answer "how many are still open". Measured against
-- 60,000 seeded rows per kind for one tenant (realistic after a few years with
-- no archival): ~28-44ms per kind, ~60,000 buffer hits each, scaling linearly
-- with total jobs ever scheduled rather than with jobs currently open.
--
-- This index puts status last so (tenant_id, kind, status = 'scheduled') is a
-- direct index condition instead of a post-scan filter — the scan touches only
-- the open rows for that tenant+kind, which is the number the counter actually
-- reports (typically a few hundred, not tens of thousands).

-- Up Migration

CREATE INDEX workflow_jobs_tenant_kind_status_idx
  ON workflow_jobs (tenant_id, kind, status);

-- Down Migration

DROP INDEX IF EXISTS workflow_jobs_tenant_kind_status_idx;
