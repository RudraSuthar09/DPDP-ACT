import { Injectable } from '@nestjs/common';
import type { SchemaSourceKind } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Persistence for discovered schema metadata (inventory_data_elements). Ordinary
 * tenant data — SELECT/INSERT/UPDATE under RLS, no write-gating: S4's guarantee is
 * that nothing a row VALUE could reach here in the first place, enforced by the
 * SchemaSource type (no readRows), not by locking down this table.
 *
 * Everything stored is names/types/structure. There is no column here that could
 * hold a customer record, by construction (I1).
 */

export interface DiscoveredElement {
  sourceKind: SchemaSourceKind;
  sourceRef: string;
  schemaName: string;
  tableName: string;
  columnName: string;
  dataType: string;
  nullable: boolean;
  comment: string | null;
  piiCategory: string | null;
}

export interface DataElementRow {
  id: string;
  source_kind: SchemaSourceKind;
  source_ref: string | null;
  schema_name: string;
  table_name: string;
  column_name: string;
  data_type: string;
  nullable: boolean;
  comment: string | null;
  pii_category: string | null;
  discovered_at: Date;
}

@Injectable()
export class DataElementsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Upsert discovered columns. Re-discovering a column updates its metadata in
   *  place (a later, richer source refines an earlier one) — never a duplicate. */
  upsertMany(elements: DiscoveredElement[]): Promise<number> {
    return this.db.withTenant(async (client) => {
      let count = 0;
      for (const e of elements) {
        await client.query(
          `INSERT INTO inventory_data_elements
             (source_kind, source_ref, schema_name, table_name, column_name,
              data_type, nullable, comment, pii_category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id, schema_name, table_name, column_name) DO UPDATE
             SET data_type   = EXCLUDED.data_type,
                 nullable    = EXCLUDED.nullable,
                 comment     = EXCLUDED.comment,
                 pii_category = EXCLUDED.pii_category,
                 source_kind = EXCLUDED.source_kind,
                 source_ref  = EXCLUDED.source_ref`,
          [
            e.sourceKind,
            e.sourceRef,
            e.schemaName,
            e.tableName,
            e.columnName,
            e.dataType,
            e.nullable,
            e.comment,
            e.piiCategory,
          ],
        );
        count += 1;
      }
      return count;
    });
  }

  list(): Promise<DataElementRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataElementRow>(
        `SELECT id, source_kind, source_ref, schema_name, table_name, column_name,
                data_type, nullable, comment, pii_category, discovered_at
           FROM inventory_data_elements
          ORDER BY schema_name, table_name, column_name`,
      );
      return rows;
    });
  }
}
