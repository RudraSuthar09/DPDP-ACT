import { Injectable } from '@nestjs/common';
import type { GrievanceCategory } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The one table this module owns: `grievance_details`, keyed by
 * `request_tickets.id`. Every method here manages its own tenant-scoped
 * transaction (like `RopaRepository`) rather than taking a caller-supplied
 * `PoolClient` — unlike the substrate's own repositories, nothing here needs
 * to land in the SAME transaction as a `RequestService` call to be correct,
 * EXCEPT the public intake write (see `GrievancePortalController.submit`),
 * which relies on `TenantDatabaseService.withTenant` joining the request's
 * single unit of work automatically — no explicit client-passing required for
 * that atomicity either.
 */
@Injectable()
export class GrievanceCategoryRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Set or correct a ticket's category. `setBy` is null for the anonymous
   *  portal intake write, the acting staff member's id for a recategorisation. */
  async upsert(ticketId: string, category: GrievanceCategory, setBy: string | null): Promise<void> {
    await this.db.withTenant(async (client) => {
      await client.query(
        `INSERT INTO grievance_details (ticket_id, category, set_by, set_at, updated_at)
         VALUES ($1, $2, $3, now(), now())
         ON CONFLICT (ticket_id) DO UPDATE
           SET category = EXCLUDED.category,
               set_by = EXCLUDED.set_by,
               set_at = now(),
               updated_at = now()`,
        [ticketId, category, setBy],
      );
    });
  }

  async find(ticketId: string): Promise<GrievanceCategory | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ category: GrievanceCategory }>(
        `SELECT category FROM grievance_details WHERE ticket_id = $1`,
        [ticketId],
      );
      return rows[0]?.category ?? null;
    });
  }

  /** Bulk lookup for the staff list view — one query, not N. */
  async findMany(ticketIds: string[]): Promise<Map<string, GrievanceCategory>> {
    if (ticketIds.length === 0) {
      return new Map();
    }
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ ticket_id: string; category: GrievanceCategory }>(
        `SELECT ticket_id, category FROM grievance_details WHERE ticket_id = ANY($1::uuid[])`,
        [ticketIds],
      );
      return new Map(rows.map((r) => [r.ticket_id, r.category]));
    });
  }
}
