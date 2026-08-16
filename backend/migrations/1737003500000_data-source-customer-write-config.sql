-- Phase 3H-1: the CENTRAL source of truth for whether/what DPDP-mediated flows
-- may write back to a client's connected Enterprise SQL source. Previously
-- these existed ONLY as agent-local `GatewaySourceConfig` options (the client's
-- own operator config, invisible to and unmanaged by this platform) — see
-- agent/src/connectors/registry.ts `identityColumn`/`allowCustomerCreate`/
-- `writableColumns`. This migration gives identity_column's existing sibling
-- settings the same central, tenant-configured, audited home identity_column
-- already has (1737003100000_data-sources.sql).
--
-- WHAT THIS DOES NOT DO: it does not make the agent trust these values instead
-- of its own local config — the agent re-validates identity/writable-column/
-- creation-allowed independently on every call (defence in depth, unchanged).
-- This is the CENTRAL, staff-facing configuration surface the frontend consults
-- before even attempting a write, so a client can explicitly set (and audit)
-- these decisions through the DPDP UI instead of an operator-only config file.

-- Up Migration

ALTER TABLE data_sources
  ADD COLUMN allow_customer_create boolean NOT NULL DEFAULT false;

ALTER TABLE data_sources
  ADD COLUMN writable_columns text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN data_sources.allow_customer_create IS
  'Phase 3H-1: whether DPDP-mediated flows (e.g. the staff-assisted consent '
  'flow) may create a NEW customer record in this source when identity '
  'resolution finds no match. Defaults false (fail closed) — creation must be '
  'explicitly enabled per source. Mirrors, and is independent of, the agent''s '
  'own local allowCustomerCreate config; both are enforced.';

COMMENT ON COLUMN data_sources.writable_columns IS
  'Phase 3H-1: the explicit, client-chosen allowlist of column NAMES ONLY '
  '(never values) that DPDP-mediated flows may write for this source. Empty by '
  'default — nothing is writable until a human explicitly adds a column here. '
  'Never auto-populated from discovered columns/suggestions (I1/no inference). '
  'Mirrors, and is independent of, the agent''s own local writableColumns '
  'config; both are enforced.';

-- Down Migration

ALTER TABLE data_sources DROP COLUMN IF EXISTS writable_columns;
ALTER TABLE data_sources DROP COLUMN IF EXISTS allow_customer_create;
