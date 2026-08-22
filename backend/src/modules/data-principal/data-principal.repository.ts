import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface DataPrincipalRow {
  id: string;
  tenant_id: string;
  subject_ref: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * The customer/data-principal identity registry (1737004700000_data-principals.sql).
 * One row per (tenant, subject_ref) — resolved via upsert, never a second
 * write path. See DataPrincipalService for the "why" of this table's existence.
 */
@Injectable()
export class DataPrincipalRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Find-or-create in one atomic statement — the SAME subject_ref always
   *  resolves to the SAME row, whether this is the first time it's been seen
   *  or the hundredth. `updated_at` is touched on a repeat resolution purely
   *  as a "last seen" signal — nothing else about the row changes. */
  resolveOrCreate(subjectRef: string): Promise<DataPrincipalRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataPrincipalRow>(
        `INSERT INTO data_principals (subject_ref) VALUES ($1)
         ON CONFLICT ON CONSTRAINT data_principals_tenant_subject_uq
         DO UPDATE SET updated_at = now()
         RETURNING *`,
        [subjectRef],
      );
      return rows[0]!;
    });
  }

  findBySubjectRef(subjectRef: string): Promise<DataPrincipalRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataPrincipalRow>(
        `SELECT * FROM data_principals WHERE subject_ref = $1`,
        [subjectRef],
      );
      return rows[0] ?? null;
    });
  }
}
