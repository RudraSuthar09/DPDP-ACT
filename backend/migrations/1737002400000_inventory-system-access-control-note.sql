-- Access-control policy note on a system (FR-INV-06).
--
-- A system version already records WHAT a system is (name, type) and WHERE it
-- lives (hosting_location). It had nowhere to record WHO may reach the data on
-- it — "access restricted to staff directly involved in the assignment, on a
-- need-to-know basis", "per-client login, firm-side access limited to the
-- engagement team", "mailbox password not shared". That statement is one of
-- the few things a RoPA is actually expected to carry (a general description of
-- the organisational security measures), and it is a property of the SYSTEM,
-- not of any one data element on it — so it belongs here rather than on the
-- entry or the entry-system link.
--
-- Deliberately plain nullable text, not a structured policy object: at Stage 1
-- what a firm can honestly assert is a sentence, and a sentence a human wrote
-- is better evidence than a checkbox they clicked. Nullable so every existing
-- system row stays valid and the field stays optional in the form.
--
-- On the versions table, not the lifecycle table, so revising the statement
-- forks a new version and the old wording survives as evidence (I4) — the same
-- reasoning as every other content field here.

-- Up Migration

ALTER TABLE inventory_system_versions
  ADD COLUMN access_control_note text;

COMMENT ON COLUMN inventory_system_versions.access_control_note IS
  'Free-text statement of who may access data on this system and under what '
  'policy (e.g. "restricted to staff directly involved in the assignment, '
  'need-to-know basis; access logged"). Versioned content like every other '
  'column here. Nullable — optional for every system.';

-- No GRANT needed: apply_tenant_rls granted SELECT/INSERT/UPDATE at TABLE
-- level in 1737001000000, and table-level privileges cover columns added later.

-- Down Migration

ALTER TABLE inventory_system_versions
  DROP COLUMN IF EXISTS access_control_note;
