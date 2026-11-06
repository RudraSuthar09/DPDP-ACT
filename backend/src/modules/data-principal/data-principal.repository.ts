import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface DataPrincipalRow {
  id: string;
  tenant_id: string;
  subject_ref: string;
  display_name: string | null;
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
   *  as a "last seen" signal.
   *
   *  `displayName` is COALESCEd, never overwritten with null: a submission
   *  with no "Customer Name" field configured (or the visitor left it blank)
   *  must not blank out a name a PREVIOUS submission already set — the name
   *  can be refreshed by a later submission that provides one, never erased
   *  by one that doesn't. */
  resolveOrCreate(subjectRef: string, displayName: string | null = null): Promise<DataPrincipalRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DataPrincipalRow>(
        `INSERT INTO data_principals (subject_ref, display_name) VALUES ($1, $2)
         ON CONFLICT ON CONSTRAINT data_principals_tenant_subject_uq
         DO UPDATE SET updated_at = now(), display_name = COALESCE($2, data_principals.display_name)
         RETURNING *`,
        [subjectRef, displayName],
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

  /** Display names for many subject refs at once, READ-ONLY — it never
   *  creates a row, unlike resolveOrCreate. Used by the submissions export,
   *  which must not bring a customer registry entry into existence as a side
   *  effect of reading a spreadsheet. Refs with no row, or with no name
   *  recorded, are simply absent from the result. */
  displayNamesBySubjectRef(subjectRefs: readonly string[]): Promise<Map<string, string>> {
    return this.db.withTenant(async (client) => {
      if (subjectRefs.length === 0) return new Map<string, string>();
      const { rows } = await client.query<{ subject_ref: string; display_name: string | null }>(
        `SELECT subject_ref, display_name FROM data_principals WHERE subject_ref = ANY($1::text[])`,
        [[...new Set(subjectRefs)]],
      );
      const out = new Map<string, string>();
      for (const r of rows) if (r.display_name) out.set(r.subject_ref, r.display_name);
      return out;
    });
  }
}
