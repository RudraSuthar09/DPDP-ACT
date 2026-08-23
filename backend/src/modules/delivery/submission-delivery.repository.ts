import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export type SubmissionDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface SubmissionDeliveryRow {
  id: string;
  tenant_id: string;
  submission_id: string;
  form_id: string;
  status: SubmissionDeliveryStatus;
  payload_ciphertext: Buffer | null;
  payload_iv: Buffer | null;
  payload_auth_tag: Buffer | null;
  claimed_by_device_id: string | null;
  attempt_count: number;
  claimed_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'id, tenant_id, submission_id, form_id, status, payload_ciphertext, payload_iv, payload_auth_tag, ' +
  'claimed_by_device_id, attempt_count, claimed_at, delivered_at, failed_at, last_error, created_at, updated_at';

/** After this many attempts a delivery stops being retried automatically and
 *  is left in 'failed' — visible, not silently retried forever. */
const MAX_ATTEMPTS = 10;

/** A 'delivering' row whose claim is older than this is treated as abandoned
 *  (the agent crashed/lost connectivity after claiming) and becomes eligible
 *  for a fresh claim again — this is what makes "agent restart resumes work"
 *  true even for a submission it had already claimed once. */
const STALE_CLAIM_MINUTES = 5;

const CLAIMABLE_WHERE = `(status = 'pending' OR (status = 'delivering' AND claimed_at < now() - interval '${STALE_CLAIM_MINUTES} minutes'))`;

/**
 * Persistence for the submission delivery queue — see
 * submission-delivery.service.ts for the lifecycle and the encryption
 * discipline. This repository never decrypts anything; it only ever moves
 * ciphertext bytes.
 */
@Injectable()
export class SubmissionDeliveryRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(input: {
    submissionId: string;
    formId: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  }): Promise<SubmissionDeliveryRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubmissionDeliveryRow>(
        `INSERT INTO consent_form_submission_deliveries
           (submission_id, form_id, payload_ciphertext, payload_iv, payload_auth_tag)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLS}`,
        [input.submissionId, input.formId, input.ciphertext, input.iv, input.authTag],
      );
      return rows[0]!;
    });
  }

  /** Claimable rows for THIS tenant (RLS-scoped by the caller's gateway_device
   *  context) — pending, or a stale abandoned claim. Metadata only, no
   *  payload — the agent claims one at a time to actually receive it. */
  listClaimable(limit: number): Promise<Array<Pick<SubmissionDeliveryRow, 'id' | 'form_id' | 'created_at' | 'attempt_count'>>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT id, form_id, created_at, attempt_count FROM consent_form_submission_deliveries
          WHERE ${CLAIMABLE_WHERE}
          ORDER BY created_at ASC
          LIMIT $1`,
        [limit],
      );
      return rows;
    });
  }

  /** Atomic compare-and-set: only succeeds if the row was still claimable at
   *  the moment of the UPDATE (Postgres's row lock makes this safe under
   *  concurrent claims — no separate SELECT-then-UPDATE race). */
  claim(id: string, deviceId: string): Promise<SubmissionDeliveryRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubmissionDeliveryRow>(
        `UPDATE consent_form_submission_deliveries
            SET status = 'delivering', claimed_by_device_id = $2, claimed_at = now(),
                attempt_count = attempt_count + 1
          WHERE id = $1 AND ${CLAIMABLE_WHERE}
          RETURNING ${COLS}`,
        [id, deviceId],
      );
      return rows[0] ?? null;
    });
  }

  findClaimedByDevice(id: string, deviceId: string): Promise<SubmissionDeliveryRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubmissionDeliveryRow>(
        `SELECT ${COLS} FROM consent_form_submission_deliveries
          WHERE id = $1 AND claimed_by_device_id = $2 AND status = 'delivering'`,
        [id, deviceId],
      );
      return rows[0] ?? null;
    });
  }

  /** Success: nulls the ciphertext columns (the payload is deleted the moment
   *  delivery is confirmed — see the migration header) and marks DELIVERED. */
  markDelivered(id: string): Promise<SubmissionDeliveryRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubmissionDeliveryRow>(
        `UPDATE consent_form_submission_deliveries
            SET status = 'delivered', delivered_at = now(),
                payload_ciphertext = NULL, payload_iv = NULL, payload_auth_tag = NULL
          WHERE id = $1 AND status = 'delivering'
          RETURNING ${COLS}`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /** Failure: back to 'pending' for another attempt, unless MAX_ATTEMPTS is
   *  reached, in which case it is left 'failed' (still retryable manually
   *  later, but no longer picked up automatically). */
  markFailed(id: string, error: string): Promise<SubmissionDeliveryRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubmissionDeliveryRow>(
        `UPDATE consent_form_submission_deliveries
            SET status = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
                failed_at = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN now() ELSE failed_at END,
                last_error = $2
          WHERE id = $1 AND status = 'delivering'
          RETURNING ${COLS}`,
        [id, error.slice(0, 2000)],
      );
      return rows[0] ?? null;
    });
  }
}
