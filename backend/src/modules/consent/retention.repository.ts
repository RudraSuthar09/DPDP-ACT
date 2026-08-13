import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface RetentionRecordRow {
  id: string;
  subject_ref: string;
  inventory_purpose_id: string;
  consent_purpose_id: string | null;
  basis: string;
  source: 'consent_grant' | 'manual_collection';
  start_at: Date;
  retention_months_snapshot: number;
  retention_end: Date;
  status: 'active' | 'reviewed';
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  expired_flagged_at: Date | null;
  created_at: Date;
}

/** A retention record joined to the display facts a staff drill-down needs
 *  (element category + purpose name) — all pseudonymised/metadata, never a value. */
export interface RetentionRecordView extends RetentionRecordRow {
  entry_category: string | null;
  inventory_purpose_name: string | null;
}

@Injectable()
export class RetentionRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Create a retention record, unless one already exists for this
   *  (subject_ref, inventory purpose) — the clock is not restarted (I4). Returns
   *  the row if newly created, else null. */
  create(input: {
    subjectRef: string;
    inventoryPurposeId: string;
    consentPurposeId: string | null;
    basis: string;
    source: 'consent_grant' | 'manual_collection';
    startAt: string;
    retentionMonths: number;
    createdBy: string | null;
  }): Promise<RetentionRecordRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RetentionRecordRow>(
        `INSERT INTO retention_records
           (subject_ref, inventory_purpose_id, consent_purpose_id, basis, source,
            start_at, retention_months_snapshot, retention_end, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 ($6::timestamptz + make_interval(months => $7::int)), $8)
         ON CONFLICT (tenant_id, subject_ref, inventory_purpose_id) DO NOTHING
         RETURNING *`,
        [
          input.subjectRef,
          input.inventoryPurposeId,
          input.consentPurposeId,
          input.basis,
          input.source,
          input.startAt,
          input.retentionMonths,
          input.createdBy,
        ],
      );
      return rows[0] ?? null;
    });
  }

  findOne(id: string): Promise<RetentionRecordRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RetentionRecordRow>('SELECT * FROM retention_records WHERE id = $1', [id]);
      return rows[0] ?? null;
    });
  }

  /** Counts for the dashboard. `windowDays` defines "approaching". */
  summary(windowDays: number): Promise<{ approaching: number; past: number }> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ approaching: string; past: string }>(
        `SELECT
           count(*) FILTER (
             WHERE status = 'active' AND retention_end > now()
               AND retention_end <= now() + make_interval(days => $1::int)
           ) AS approaching,
           count(*) FILTER (WHERE status = 'active' AND retention_end <= now()) AS past
         FROM retention_records`,
        [windowDays],
      );
      return { approaching: Number(rows[0]!.approaching), past: Number(rows[0]!.past) };
    });
  }

  /** The drill-down list. `filter`: 'approaching' | 'past' | 'all'. Pseudonymised
   *  references + metadata only. */
  list(filter: 'approaching' | 'past' | 'all', windowDays: number): Promise<RetentionRecordView[]> {
    const where =
      filter === 'past'
        ? "r.status = 'active' AND r.retention_end <= now()"
        : filter === 'approaching'
          ? "r.status = 'active' AND r.retention_end > now() AND r.retention_end <= now() + make_interval(days => $1::int)"
          : 'true';
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RetentionRecordView>(
        `SELECT r.*,
                ev.category AS entry_category,
                ipv.purpose_name AS inventory_purpose_name
           FROM retention_records r
           JOIN inventory_entry_purposes ip ON ip.id = r.inventory_purpose_id
           LEFT JOIN LATERAL (
             SELECT purpose_name FROM inventory_entry_purpose_versions
              WHERE purpose_id = r.inventory_purpose_id ORDER BY version_number DESC LIMIT 1
           ) ipv ON true
           LEFT JOIN LATERAL (
             SELECT category FROM inventory_register_entry_versions
              WHERE entry_id = ip.entry_id ORDER BY version_number DESC LIMIT 1
           ) ev ON true
          WHERE ${where}
          ORDER BY r.retention_end ASC`,
        filter === 'approaching' ? [windowDays] : [],
      );
      return rows;
    });
  }

  markReviewed(id: string, reviewedBy: string | null, note: string | null): Promise<RetentionRecordRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RetentionRecordRow>(
        `UPDATE retention_records
            SET status = 'reviewed', reviewed_by = $2, reviewed_at = now(), review_note = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [id, reviewedBy, note],
      );
      return rows[0] ?? null;
    });
  }

  /** Called by the fired retention deadline (worker) on the worker's own client:
   *  a durable marker that the clock ran out, set regardless of anyone viewing
   *  the dashboard. Never changes retention_end (I4). */
  flagExpired(client: import('pg').PoolClient, retentionRecordId: string): Promise<void> {
    return client
      .query(
        `UPDATE retention_records SET expired_flagged_at = now()
          WHERE id = $1 AND expired_flagged_at IS NULL`,
        [retentionRecordId],
      )
      .then(() => undefined);
  }
}
