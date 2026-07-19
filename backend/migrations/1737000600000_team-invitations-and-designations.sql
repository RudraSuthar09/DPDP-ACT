-- Team invitations (FR-IDN-05) and DPO/Grievance Officer designation (FR-IDN-04).
--
-- Two small, ordinary tenant tables — neither needs write-gating like the seam
-- tables (S2/S3/S5): they are team bookkeeping, not evidence chains, so the
-- standard app.apply_tenant_rls() (SELECT/INSERT/UPDATE for dpdp_app) is enough.
-- The audit interceptor still records every mutation through them (S5); nothing
-- here is exempt from that.
--
-- invitations — how someone joins an EXISTING tenant, as opposed to
--   POST /auth/register, which always mints a NEW one. A pending invite is a
--   bearer JWT (see backend/src/tenancy/jwt.ts, typ='invite') naming this row's
--   id, the tenant, the email, and the offered role; the row is what makes that
--   token revocable (accept always re-checks status='pending' here) even though
--   the token itself is unrevokable ephemeral bearer material, exactly like the
--   existing MFA challenge/enrolment tokens. No token secret is stored — nothing
--   to hash, because the JWT signature already prevents forgery.
--
-- org_designations — "who is THE DPO / THE Grievance Officer for this tenant",
--   for the public portal to display later. Deliberately separate from `role`:
--   role is an RBAC permission level (several people could hold role='dpo' in
--   principle), designation is a single named point of contact per tenant per
--   kind. One row per (tenant, designation) — assigning again replaces it.

-- Up Migration

CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.current_tenant()
                      REFERENCES organisations (id),

  email             text NOT NULL CHECK (email = lower(email) AND email LIKE '%@%'),
  full_name         text NOT NULL,
  role              text NOT NULL
                      CHECK (role IN ('owner', 'dpo', 'compliance_officer',
                                      'grievance_officer', 'auditor', 'viewer')),

  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),

  invited_by        uuid NOT NULL REFERENCES users (id),
  reason            text NOT NULL,

  accepted_user_id  uuid REFERENCES users (id),
  accepted_at       timestamptz,
  revoked_by        uuid REFERENCES users (id),
  revoked_at        timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

COMMENT ON TABLE invitations IS
  'Team invitations (FR-IDN-05): how a person joins an EXISTING tenant. Accepted '
  'via POST /auth/invitations/accept, which creates the user under THIS '
  'tenant_id — never a new one. No token secret is stored (the bearer JWT is '
  'self-verifying); this row is what makes acceptance re-checkable and revocable.';

SELECT app.apply_tenant_rls('public.invitations');

-- Only one LIVE invite per email per tenant — re-inviting after acceptance or
-- revocation is fine (a new row), a second pending invite to the same address
-- while one is outstanding is not (a partial index, not a plain UNIQUE, is what
-- lets accepted/revoked/expired rows for the same email coexist).
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON invitations (tenant_id, email)
  WHERE status = 'pending';

CREATE INDEX invitations_tenant_status_idx ON invitations (tenant_id, status);

CREATE TABLE org_designations (
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant()
                 REFERENCES organisations (id),
  designation  text NOT NULL CHECK (designation IN ('dpo', 'grievance_officer')),
  user_id      uuid NOT NULL REFERENCES users (id),
  reason       text NOT NULL,
  set_by       uuid NOT NULL REFERENCES users (id),
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, designation)
);

COMMENT ON TABLE org_designations IS
  'FR-IDN-04: which team member is the published DPO / Grievance Officer for '
  'this tenant — the fact the (future) public portal page reads. Distinct from '
  'RBAC role: this is a single named point of contact, not a permission level.';

SELECT app.apply_tenant_rls('public.org_designations');

-- Down Migration

DROP TABLE IF EXISTS org_designations;
DROP TABLE IF EXISTS invitations;
