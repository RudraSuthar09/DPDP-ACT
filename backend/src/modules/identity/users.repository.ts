import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { MODULE_AREAS, type ModuleArea, type Role, type UserStatus } from '@dpdp/shared';
import type { Designation } from './dto';

/**
 * Every SQL statement the identity module issues, in one file (R2: no other
 * module touches these tables — they go through IdentityService).
 *
 * Each method takes the `PoolClient` its caller obtained from
 * TenantDatabaseService, so the tenant GUC is already bound and the caller
 * controls the transaction boundary. That is what lets registration create an
 * organisation, its Owner, and its five module areas atomically — a half-built
 * workspace is not a state this system should be able to reach.
 *
 * Note what is absent: any DELETE. Users are never hard-deleted (platform rule,
 * invariant I4). dpdp_app holds no DELETE grant, so this is not restraint on our
 * part — a DELETE here would fail at runtime.
 */

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  password_hash: string;
  password_algo: string;
  role: Role;
  status: UserStatus;
  mfa_secret_ciphertext: string | null;
  mfa_enrolled_at: Date | null;
  mfa_last_step: string | null;
  failed_login_attempts: number;
  locked_until: Date | null;
}

const USER_COLUMNS = `
  id, tenant_id, email, full_name, password_hash, password_algo, role, status,
  mfa_secret_ciphertext, mfa_enrolled_at, mfa_last_step,
  failed_login_attempts, locked_until
`;

@Injectable()
export class UsersRepository {
  // --- Provisioning (FR-IDN-01) --------------------------------------------

  /**
   * The organisation row IS the tenant: tenant_id = id (see the organisations
   * migration). The id is minted by the caller and bound as the GUC before this
   * runs, so even this very first insert is subject to the same RLS policy as
   * everything else — there is no privileged provisioning path.
   */
  async insertOrganisation(client: PoolClient, tenantId: string, name: string): Promise<void> {
    await client.query('INSERT INTO organisations (id, tenant_id, name) VALUES ($1, $1, $2)', [
      tenantId,
      name,
    ]);
  }

  /**
   * Provision all five module areas (FR-IDN-01: "a fully isolated tenant
   * workspace with all five module areas"). Driven from MODULE_AREAS, so adding
   * a sixth product module provisions it for new tenants automatically.
   */
  async provisionWorkspaceModules(client: PoolClient, tenantId: string): Promise<ModuleArea[]> {
    const { rows } = await client.query<{ module: ModuleArea }>(
      `INSERT INTO workspace_modules (tenant_id, module)
       SELECT $1, unnest($2::text[])
       RETURNING module`,
      [tenantId, [...MODULE_AREAS]],
    );
    return rows.map((r) => r.module);
  }

  async listWorkspaceModules(client: PoolClient): Promise<ModuleArea[]> {
    const { rows } = await client.query<{ module: ModuleArea }>(
      'SELECT module FROM workspace_modules ORDER BY module',
    );
    return rows.map((r) => r.module);
  }

  // --- Users ---------------------------------------------------------------

  async insertUser(
    client: PoolClient,
    input: {
      tenantId: string;
      email: string;
      fullName: string;
      passwordHash: string;
      role: Role;
    },
  ): Promise<UserRow> {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (tenant_id, email, full_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLUMNS}`,
      [
        input.tenantId,
        input.email.trim().toLowerCase(),
        input.fullName.trim(),
        input.passwordHash,
        input.role,
      ],
    );
    return rows[0]!;
  }

  async findById(client: PoolClient, userId: string): Promise<UserRow | null> {
    // No tenant_id predicate, on purpose: RLS supplies it. If this ever returns
    // another tenant's user, the isolation suite has bigger news than this query.
    const { rows } = await client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async listUsers(client: PoolClient): Promise<UserRow[]> {
    const { rows } = await client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`,
    );
    return rows;
  }

  /** The user + their organisation name, for GET /auth/me. */
  async findProfile(
    client: PoolClient,
    userId: string,
  ): Promise<(UserRow & { organisation_name: string; portal_slug: string }) | null> {
    const { rows } = await client.query<
      UserRow & { organisation_name: string; portal_slug: string }
    >(
      `SELECT ${USER_COLUMNS.split(',')
        .map((c) => `u.${c.trim()}`)
        .join(', ')},
              o.name AS organisation_name,
              o.portal_slug
       FROM users u
       JOIN organisations o ON o.id = u.tenant_id
       WHERE u.id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  // --- Lifecycle (FR-IDN-05) — suspend/remove, NEVER delete ----------------

  /**
   * The only way a user's status ever changes. `removed` is a tombstone, not a
   * deletion: the row stays, its audit trail stays, and only the ability to
   * authenticate goes away. Reason and actor are recorded because a status
   * change is evidence like everything else (I4).
   */
  async setStatus(
    client: PoolClient,
    input: { userId: string; status: UserStatus; reason: string; actorId: string },
  ): Promise<UserRow | null> {
    const { rows } = await client.query<UserRow>(
      `UPDATE users
          SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [input.userId, input.status, input.reason, input.actorId],
    );
    return rows[0] ?? null;
  }

  /**
   * Change a role (FR-IDN-03). Reuses status_reason/status_changed_* as the
   * "last administrative change" columns; the audit chain is where the full
   * history of who changed what to what actually lives.
   */
  async setRole(
    client: PoolClient,
    input: { userId: string; role: Role; reason: string; actorId: string },
  ): Promise<UserRow | null> {
    const { rows } = await client.query<UserRow>(
      `UPDATE users
          SET role = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [input.userId, input.role, input.reason, input.actorId],
    );
    return rows[0] ?? null;
  }

  /** How many active Owners the tenant has — used to refuse orphaning a workspace. */
  async countActiveOwners(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE role = 'owner' AND status = 'active'`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  // --- Login bookkeeping ---------------------------------------------------

  async recordFailedLogin(
    client: PoolClient,
    userId: string,
    lockAfterAttempts: number,
    lockForSeconds: number,
  ): Promise<void> {
    // Increment and lock in ONE statement: read-then-write from the app would
    // let concurrent guesses interleave and undercount, which is precisely the
    // situation a password sprayer creates.
    await client.query(
      `UPDATE users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' seconds')::interval
                ELSE locked_until
              END
        WHERE id = $1`,
      [userId, lockAfterAttempts, String(lockForSeconds)],
    );
  }

  async recordSuccessfulLogin(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `UPDATE users
          SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [userId],
    );
  }

  // --- MFA (FR-IDN-02) -----------------------------------------------------

  /** Stash the (encrypted) secret from an enrolment that has not been proven yet. */
  async stageMfaSecret(client: PoolClient, userId: string, ciphertext: string): Promise<void> {
    // mfa_enrolled_at stays NULL until a code is confirmed, so an abandoned
    // enrolment leaves the account exactly as it was rather than locked out.
    await client.query(
      'UPDATE users SET mfa_secret_ciphertext = $2, mfa_enrolled_at = NULL, mfa_last_step = NULL WHERE id = $1',
      [userId, ciphertext],
    );
  }

  async markMfaEnrolled(client: PoolClient, userId: string, step: number): Promise<void> {
    await client.query(
      'UPDATE users SET mfa_enrolled_at = now(), mfa_last_step = $2 WHERE id = $1',
      [userId, String(step)],
    );
  }

  /**
   * Burn the TOTP step just consumed (RFC 6238 §5.2). The `mfa_last_step < $2`
   * guard makes this a compare-and-set: two requests racing with the same code
   * mean exactly one UPDATE reports a row, and the loser is rejected as a replay.
   */
  async consumeMfaStep(client: PoolClient, userId: string, step: number): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE users
          SET mfa_last_step = $2
        WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
      [userId, String(step)],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Recovery codes ------------------------------------------------------

  async replaceRecoveryCodes(
    client: PoolClient,
    input: { tenantId: string; userId: string; hashes: string[] },
  ): Promise<void> {
    // Retire the old set by burning it, not by deleting it (I4) — and there is
    // no DELETE grant to do otherwise with.
    await client.query(
      'UPDATE user_recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [input.userId],
    );
    await client.query(
      `INSERT INTO user_recovery_codes (tenant_id, user_id, code_hash)
       SELECT $1, $2, unnest($3::text[])`,
      [input.tenantId, input.userId, input.hashes],
    );
  }

  /**
   * Look up and burn a recovery code in ONE statement. `used_at IS NULL` in the
   * predicate is what makes it single-use under concurrency: two requests
   * redeeming the same code both run the UPDATE, exactly one matches a row, and
   * the loser gets `false`. A SELECT-then-UPDATE would let both through.
   */
  async consumeRecoveryCode(
    client: PoolClient,
    userId: string,
    codeHash: string,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE user_recovery_codes
          SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, codeHash],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Invitations (FR-IDN-05) — joining an EXISTING tenant -----------------

  async insertInvitation(
    client: PoolClient,
    input: {
      tenantId: string;
      email: string;
      fullName: string;
      role: Role;
      invitedBy: string;
      reason: string;
      expiresAt: Date;
    },
  ): Promise<InvitationRow> {
    const { rows } = await client.query<InvitationRow>(
      `INSERT INTO invitations (tenant_id, email, full_name, role, invited_by, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${INVITATION_COLUMNS}`,
      [
        input.tenantId,
        input.email.trim().toLowerCase(),
        input.fullName.trim(),
        input.role,
        input.invitedBy,
        input.reason,
        input.expiresAt,
      ],
    );
    return rows[0]!;
  }

  async findInvitationById(client: PoolClient, id: string): Promise<InvitationRow | null> {
    // No tenant_id predicate: RLS supplies it, same reasoning as findById(users).
    const { rows } = await client.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM invitations WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listInvitations(client: PoolClient): Promise<InvitationRow[]> {
    const { rows } = await client.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM invitations ORDER BY created_at DESC`,
    );
    return rows;
  }

  async markInvitationAccepted(
    client: PoolClient,
    invitationId: string,
    acceptedUserId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE invitations
          SET status = 'accepted', accepted_user_id = $2, accepted_at = now()
        WHERE id = $1`,
      [invitationId, acceptedUserId],
    );
  }

  async revokeInvitation(client: PoolClient, invitationId: string, revokedBy: string): Promise<InvitationRow | null> {
    const { rows } = await client.query<InvitationRow>(
      `UPDATE invitations
          SET status = 'revoked', revoked_by = $2, revoked_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${INVITATION_COLUMNS}`,
      [invitationId, revokedBy],
    );
    return rows[0] ?? null;
  }

  // --- Designations (FR-IDN-04) — the published DPO / Grievance Officer -----

  async upsertDesignation(
    client: PoolClient,
    input: { designation: Designation; userId: string; reason: string; setBy: string },
  ): Promise<DesignationRow> {
    const { rows } = await client.query<DesignationRow>(
      `INSERT INTO org_designations (designation, user_id, reason, set_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, designation) DO UPDATE
         SET user_id = EXCLUDED.user_id, reason = EXCLUDED.reason,
             set_by = EXCLUDED.set_by, set_at = now()
       RETURNING tenant_id, designation, user_id, reason, set_by, set_at`,
      [input.designation, input.userId, input.reason, input.setBy],
    );
    return rows[0]!;
  }

  async listDesignations(client: PoolClient): Promise<DesignationRow[]> {
    const { rows } = await client.query<DesignationRow>(
      'SELECT tenant_id, designation, user_id, reason, set_by, set_at FROM org_designations',
    );
    return rows;
  }
}

export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invited_by: string;
  reason: string;
  accepted_user_id: string | null;
  accepted_at: Date | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

const INVITATION_COLUMNS = `
  id, tenant_id, email, full_name, role, status, invited_by, reason,
  accepted_user_id, accepted_at, revoked_by, revoked_at, created_at, expires_at
`;

export interface DesignationRow {
  tenant_id: string;
  designation: Designation;
  user_id: string;
  reason: string;
  set_by: string;
  set_at: Date;
}
