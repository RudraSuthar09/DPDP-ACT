import { Injectable } from '@nestjs/common';
import type { DprRightType } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/** A prior request of the same subject, as the Tier 1 summary lists it. */
export interface SubjectRequestRow {
  reference_code: string;
  right_type: DprRightType | null;
  status: string;
  created_at: Date;
  closed_at: Date | null;
  sla_due_at: Date | null;
}

export interface DprDetailRow {
  ticket_id: string;
  right_type: DprRightType;
  subject_ref: string | null;
  subject_ref_resolved_at: Date | null;
  subject_ref_match_count: number | null;
}

/**
 * The one table this module owns: `dprequest_details`, keyed by
 * `request_tickets.id`. Same shape and same reasoning as
 * `GrievanceCategoryRepository` — each method manages its own tenant-scoped
 * transaction, and the intake write is atomic with the ticket only because
 * `TenantDatabaseService.withTenant` joins the request's single unit of work.
 */
@Injectable()
export class DPRequestDetailsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Written once, at intake. Unlike a grievance category, a rights type is NOT
   *  a triage tag staff may correct later: the deadline the request was filed
   *  under was chosen from it, so changing it after the fact would silently
   *  re-date the statutory clock. A miscategorised request is closed and
   *  refiled, which leaves a trail; an UPDATE would not. */
  async insert(ticketId: string, rightType: DprRightType): Promise<void> {
    await this.db.withTenant(async (client) => {
      await client.query(
        `INSERT INTO dprequest_details (ticket_id, right_type) VALUES ($1, $2)`,
        [ticketId, rightType],
      );
    });
  }

  /** Record a resolved subject reference. The HEX DIGEST only — this method has
   *  no parameter for a customer id, deliberately, so there is no signature
   *  through which a raw id could reach SQL. */
  async setSubjectRef(
    ticketId: string,
    input: { subjectRef: string; matchCount: number; resolvedBy: string },
  ): Promise<void> {
    await this.db.withTenant(async (client) => {
      await client.query(
        `UPDATE dprequest_details
            SET subject_ref = $2,
                subject_ref_resolved_at = now(),
                subject_ref_resolved_by = $3,
                subject_ref_match_count = $4,
                updated_at = now()
          WHERE ticket_id = $1`,
        [ticketId, input.subjectRef, input.resolvedBy, input.matchCount],
      );
    });
  }

  async find(ticketId: string): Promise<DprDetailRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DprDetailRow>(
        `SELECT ticket_id, right_type, subject_ref, subject_ref_resolved_at,
                subject_ref_match_count
           FROM dprequest_details WHERE ticket_id = $1`,
        [ticketId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Every rights request this subject has filed before (FR-DPR-04's "prior
   * request history"), newest first.
   *
   * Joins `request_tickets` for the lifecycle facts — read-only, for a
   * projection this module owns the other half of, and never written here.
   * Only requests whose subject reference has actually been RESOLVED can
   * appear: an unresolved request is not known to be this person's, and
   * guessing would attach a stranger's request to their file.
   */
  async findBySubjectRef(subjectRef: string): Promise<SubjectRequestRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SubjectRequestRow>(
        `SELECT t.reference_code, d.right_type, t.status,
                t.created_at, t.closed_at, t.sla_due_at
           FROM dprequest_details d
           JOIN request_tickets t ON t.id = d.ticket_id
          WHERE d.subject_ref = $1
          ORDER BY t.created_at DESC`,
        [subjectRef],
      );
      return rows;
    });
  }

  /** Bulk lookup for the staff queue — one query, not N. */
  async findMany(ticketIds: string[]): Promise<Map<string, DprDetailRow>> {
    if (ticketIds.length === 0) {
      return new Map();
    }
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DprDetailRow>(
        `SELECT ticket_id, right_type, subject_ref, subject_ref_resolved_at,
                subject_ref_match_count
           FROM dprequest_details WHERE ticket_id = ANY($1::uuid[])`,
        [ticketIds],
      );
      return new Map(rows.map((r) => [r.ticket_id, r]));
    });
  }
}
