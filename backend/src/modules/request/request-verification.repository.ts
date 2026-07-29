import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ContactChannel, IdentityVerificationOutcome } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The two verifications, which answer two questions that must never be confused
 * (FR-GRV-04):
 *
 *   request_contact_verifications   — "did this channel receive our code?"
 *                                     The platform answers this itself.
 *   request_identity_verifications  — "is this person your customer?"
 *                                     Only the tenant's staff may answer this,
 *                                     against records the platform never sees.
 *
 * They share a file because the handoff between them is the point: contact
 * verification succeeding is exactly what CREATES the identity-verification
 * task. Keeping them apart would let someone add a path that opens a ticket for
 * work without the channel ever having been proved.
 */

export interface ContactVerificationRow {
  id: string;
  ticket_id: string;
  channel: ContactChannel;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export interface IdentityVerificationRow {
  id: string;
  ticket_id: string;
  status: 'pending' | 'completed';
  outcome: IdentityVerificationOutcome | null;
  reason: string | null;
  completed_by: string | null;
  completed_at: Date | null;
  created_at: Date;
}

@Injectable()
export class RequestVerificationRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- contact channel (the OTP) -------------------------------------------

  /**
   * Issue a challenge, superseding any live one for the ticket.
   *
   * Superseding matters: without it, a resend would leave two valid codes and
   * double an attacker's chances per guess, and the partial unique index would
   * reject the insert anyway. An old code stops working the instant a new one is
   * sent — which is also what a requester expects when they click "resend".
   */
  async issueChallenge(
    client: PoolClient,
    input: { ticketId: string; channel: ContactChannel; codeHash: string; expiresAt: Date },
  ): Promise<ContactVerificationRow> {
    await client.query(
      `UPDATE request_contact_verifications
          SET superseded_at = now()
        WHERE ticket_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [input.ticketId],
    );
    const { rows } = await client.query<ContactVerificationRow>(
      `INSERT INTO request_contact_verifications (ticket_id, channel, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, ticket_id, channel, code_hash, attempts, max_attempts,
                 expires_at, consumed_at, created_at`,
      [input.ticketId, input.channel, input.codeHash, input.expiresAt.toISOString()],
    );
    return rows[0]!;
  }

  async findLiveChallenge(
    client: PoolClient,
    ticketId: string,
  ): Promise<ContactVerificationRow | null> {
    const { rows } = await client.query<ContactVerificationRow>(
      `SELECT id, ticket_id, channel, code_hash, attempts, max_attempts,
              expires_at, consumed_at, created_at
         FROM request_contact_verifications
        WHERE ticket_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`,
      [ticketId],
    );
    return rows[0] ?? null;
  }

  /**
   * Count one wrong guess.
   *
   * MUST be called on a DETACHED transaction (TenantDatabaseService
   * .withTenantIdDetached), never on the request's unit of work. A wrong code
   * makes the handler throw; the audit interceptor then rolls the request
   * transaction back — and would roll back this increment with it. The attempt
   * ceiling would never be reached, brute-force protection would be silently
   * absent, and every happy-path test would still pass. This is the identical
   * trap the failed-login counter documents in database.service.ts, and it is
   * worth stating twice because it fails invisibly both times.
   */
  async recordFailedAttempt(client: PoolClient, challengeId: string): Promise<number> {
    const { rows } = await client.query<{ attempts: number }>(
      `UPDATE request_contact_verifications
          SET attempts = attempts + 1
        WHERE id = $1
        RETURNING attempts`,
      [challengeId],
    );
    return rows[0]?.attempts ?? 0;
  }

  async consumeChallenge(client: PoolClient, challengeId: string): Promise<void> {
    await client.query(
      `UPDATE request_contact_verifications SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL`,
      [challengeId],
    );
  }

  /** Burn a challenge that ran out of attempts, so the code cannot be tried again
   *  after the ceiling is hit. Also detached — same reason as the counter. */
  async burnChallenge(client: PoolClient, challengeId: string): Promise<void> {
    await client.query(
      `UPDATE request_contact_verifications SET superseded_at = now()
        WHERE id = $1 AND superseded_at IS NULL`,
      [challengeId],
    );
  }

  // --- the identity handoff (FR-GRV-04) ------------------------------------

  /** Open the task that hands the question to the tenant's own staff. */
  async openIdentityTask(client: PoolClient, ticketId: string): Promise<IdentityVerificationRow> {
    const { rows } = await client.query<IdentityVerificationRow>(
      `INSERT INTO request_identity_verifications (ticket_id)
       VALUES ($1)
       RETURNING id, ticket_id, status, outcome, reason, completed_by, completed_at, created_at`,
      [ticketId],
    );
    return rows[0]!;
  }

  async findPendingIdentityTask(
    client: PoolClient,
    ticketId: string,
  ): Promise<IdentityVerificationRow | null> {
    const { rows } = await client.query<IdentityVerificationRow>(
      `SELECT id, ticket_id, status, outcome, reason, completed_by, completed_at, created_at
         FROM request_identity_verifications
        WHERE ticket_id = $1 AND status = 'pending'`,
      [ticketId],
    );
    return rows[0] ?? null;
  }

  /**
   * Record the staff verdict.
   *
   * Note the parameters: an outcome, a reason, and who decided. There is
   * deliberately nowhere to put a customer id, an account number, or a
   * pseudonymised subject ref — the verifier looked the person up in their own
   * systems and the answer stays there. If a future caller needs to pass one of
   * those, the correct response is to refuse, not to add a column (I1).
   */
  async completeIdentityTask(
    client: PoolClient,
    input: {
      taskId: string;
      outcome: IdentityVerificationOutcome;
      reason: string;
      completedBy: string;
    },
  ): Promise<IdentityVerificationRow | null> {
    const { rows } = await client.query<IdentityVerificationRow>(
      `UPDATE request_identity_verifications
          SET status = 'completed', outcome = $2, reason = $3,
              completed_by = $4, completed_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, ticket_id, status, outcome, reason, completed_by, completed_at, created_at`,
      [input.taskId, input.outcome, input.reason, input.completedBy],
    );
    return rows[0] ?? null;
  }

  /** The staff work queue: every open handoff task, oldest first. */
  listIdentityTasks(status: 'pending' | 'completed', limit: number) {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<
        IdentityVerificationRow & {
          reference_code: string;
          contact_channel: ContactChannel;
          contact_value: string;
          contact_verified_at: Date | null;
        }
      >(
        `SELECT v.id, v.ticket_id, v.status, v.outcome, v.reason, v.completed_by,
                v.completed_at, v.created_at,
                t.reference_code, t.contact_channel, t.contact_value, t.contact_verified_at
           FROM request_identity_verifications v
           JOIN request_tickets t ON t.id = v.ticket_id
          WHERE v.status = $1
          ORDER BY v.created_at
          LIMIT $2`,
        [status, limit],
      );
      return rows;
    });
  }
}
