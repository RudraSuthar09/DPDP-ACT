import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ConsentStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Every SQL statement the consent module issues that is NOT an event append.
 *
 * Appends do not live here — they go through the EventSink (S2), which is the
 * whole point of the seam. This file holds the ordinary reads and the consent
 * PURPOSE definitions (FR-CON-01), which are plain tenant metadata, not events.
 * No other module touches these tables (R2): they call ConsentService.
 */

export interface ConsentPurposeRow {
  id: string;
  name: string;
}

export interface ConsentEventRow {
  id: string;
  subject_ref: string;
  purpose_id: string;
  purpose_name: string | null;
  status: ConsentStatus;
  notice_version_id: string;
  occurred_at: Date;
  recorded_at: Date;
  source: string;
  evidence_hash: string;
}

@Injectable()
export class ConsentRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- purposes (FR-CON-01) — ordinary tenant metadata ----------------------

  createPurpose(name: string): Promise<ConsentPurposeRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentPurposeRow>(
        'INSERT INTO consent_purposes (name) VALUES ($1) RETURNING id, name',
        [name],
      );
      return rows[0]!;
    });
  }

  listPurposes(): Promise<ConsentPurposeRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentPurposeRow>(
        'SELECT id, name FROM consent_purposes ORDER BY name',
      );
      return rows;
    });
  }

  async findPurpose(client: PoolClient, purposeId: string): Promise<ConsentPurposeRow | null> {
    const { rows } = await client.query<ConsentPurposeRow>(
      'SELECT id, name FROM consent_purposes WHERE id = $1',
      [purposeId],
    );
    return rows[0] ?? null;
  }

  // --- event reads (FR-CON-08 proof-of-consent) -----------------------------

  /** A subject's event history, newest first. RLS scopes it to the tenant. */
  history(subjectRef: string, purposeId: string | null, limit: number): Promise<ConsentEventRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentEventRow>(
        `SELECT e.id, e.subject_ref, e.purpose_id, p.name AS purpose_name, e.status,
                e.notice_version_id, e.occurred_at, e.recorded_at, e.source, e.evidence_hash
           FROM consent_events e
           LEFT JOIN consent_purposes p ON p.id = e.purpose_id
          WHERE e.subject_ref = $1
            AND ($2::uuid IS NULL OR e.purpose_id = $2)
          ORDER BY e.occurred_at DESC, e.recorded_at DESC
          LIMIT $3`,
        [subjectRef, purposeId, limit],
      );
      return rows;
    });
  }

  /**
   * The subject's CURRENT consent per purpose: the latest event for each purpose
   * by valid-time. Because the store is append-only, "current" is a query, never
   * a mutable column — which is exactly what lets the same data also answer "what
   * was true on 3rd March?" (add an `occurred_at <= $2` filter). FR-CON-05.
   */
  currentStatus(subjectRef: string): Promise<ConsentEventRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<ConsentEventRow>(
        `SELECT DISTINCT ON (e.purpose_id)
                e.id, e.subject_ref, e.purpose_id, p.name AS purpose_name, e.status,
                e.notice_version_id, e.occurred_at, e.recorded_at, e.source, e.evidence_hash
           FROM consent_events e
           LEFT JOIN consent_purposes p ON p.id = e.purpose_id
          WHERE e.subject_ref = $1
          ORDER BY e.purpose_id, e.occurred_at DESC, e.recorded_at DESC`,
        [subjectRef],
      );
      return rows;
    });
  }
}
