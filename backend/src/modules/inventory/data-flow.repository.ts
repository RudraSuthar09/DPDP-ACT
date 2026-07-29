import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Read-only aggregate for FR-INV-10 — elements -> purposes -> recipients, as
 * queryable linked data (not a rendered diagram; that's the frontend's job).
 * One row per (active entry) x (active purpose) x (active vendor link),
 * so a data element with 2 purposes and 1 vendor produces 2 rows; a purpose
 * with no vendor link still produces one row with vendor = null ("no
 * external recipient — internal use only"). An entry with no active purpose
 * has no "why", so it does not appear here at all.
 */
export interface DataFlowRow {
  entry_id: string;
  category: string;
  purpose_id: string;
  purpose_name: string;
  legal_basis: string;
  retention_period: string;
  vendor_id: string | null;
  vendor_name: string | null;
}

@Injectable()
export class DataFlowRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  listFlows(): Promise<DataFlowRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataFlowRow>(
        `SELECT
           e.id AS entry_id, ev.category,
           p.id AS purpose_id, pv.purpose_name, pv.legal_basis, pv.retention_period,
           vd.id AS vendor_id, vv.name AS vendor_name
         FROM inventory_register_entries e
         JOIN LATERAL (
           SELECT category FROM inventory_register_entry_versions v
            WHERE v.entry_id = e.id ORDER BY v.version_number DESC LIMIT 1
         ) ev ON true
         JOIN inventory_entry_purposes p ON p.entry_id = e.id AND p.status = 'active'
         JOIN LATERAL (
           SELECT purpose_name, legal_basis, retention_period FROM inventory_entry_purpose_versions pv2
            WHERE pv2.purpose_id = p.id ORDER BY pv2.version_number DESC LIMIT 1
         ) pv ON true
         LEFT JOIN inventory_entry_vendors link ON link.entry_id = e.id AND link.status = 'active'
         LEFT JOIN inventory_vendors vd ON vd.id = link.vendor_id AND vd.status = 'active'
         LEFT JOIN LATERAL (
           SELECT name FROM inventory_vendor_versions vv2
            WHERE vv2.vendor_id = vd.id ORDER BY vv2.version_number DESC LIMIT 1
         ) vv ON vd.id IS NOT NULL
         WHERE e.status = 'active'
         ORDER BY ev.category, pv.purpose_name, vv.name NULLS FIRST`,
      );
      return rows;
    });
  }
}
