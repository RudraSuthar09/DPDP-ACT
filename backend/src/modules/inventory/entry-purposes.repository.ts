import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Persistence for FR-INV-05 — processing purposes, legal basis, and retention,
 * one-to-many against a Data Inventory register entry. Same split and same
 * grants as RegisterEntriesRepository: `inventory_entry_purposes` is lifecycle
 * only, `inventory_entry_purpose_versions` is the append-only content history.
 * See 1737000900000_inventory-entry-purposes.sql for why this exists instead
 * of the old flat purpose/retention_period columns.
 */

export type LegalBasis = 'consent' | 'legitimate_use' | 'contract' | 'legal_obligation' | 'other';

export interface EntryPurposeRow {
  id: string;
  entry_id: string;
  status: 'active' | 'tombstoned';
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EntryPurposeVersionRow {
  id: string;
  purpose_id: string;
  version_number: number;
  purpose_name: string;
  description: string | null;
  legal_basis: LegalBasis;
  legal_basis_note: string | null;
  retention_period: string;
  retention_months: number | null;
  created_at: Date;
  created_by: string | null;
}

export interface EntryPurposeFields {
  purposeName: string;
  description: string | null;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  retentionPeriod: string;
  /** Structured, computable retention period (months). Optional companion to the
   *  free-text retentionPeriod — set it to make this purpose retention-trackable.
   *  Optional so existing callers (sector templates, CSV import) need no change. */
  retentionMonths?: number | null;
}

/** One row of a purpose list: lifecycle + its current (latest) version. */
export interface EntryPurposeListRow {
  id: string;
  entry_id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
  updated_at: Date;
  version_number: number;
  purpose_name: string;
  description: string | null;
  legal_basis: LegalBasis;
  legal_basis_note: string | null;
  retention_period: string;
  retention_months: number | null;
  version_created_at: Date;
}

@Injectable()
export class EntryPurposesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Create a purpose and its first version (version_number = 1) together. */
  create(
    entryId: string,
    fields: EntryPurposeFields,
    actorId: string | null,
  ): Promise<{ purpose: EntryPurposeRow; version: EntryPurposeVersionRow }> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<EntryPurposeRow>(
        `INSERT INTO inventory_entry_purposes (entry_id) VALUES ($1) RETURNING *`,
        [entryId],
      );
      const purpose = purposeRows[0]!;

      const { rows: versionRows } = await client.query<EntryPurposeVersionRow>(
        `INSERT INTO inventory_entry_purpose_versions
           (purpose_id, version_number, purpose_name, description, legal_basis,
            legal_basis_note, retention_period, retention_months, created_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          purpose.id,
          fields.purposeName,
          fields.description,
          fields.legalBasis,
          fields.legalBasisNote,
          fields.retentionPeriod,
          fields.retentionMonths ?? null,
          actorId,
        ],
      );

      return { purpose, version: versionRows[0]! };
    });
  }

  /** Every purpose (optionally including tombstoned) attached to one entry, current version. */
  listForEntry(entryId: string, includeTombstoned: boolean): Promise<EntryPurposeListRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<EntryPurposeListRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (p.id)
             p.id, p.entry_id, p.status, p.created_at, p.updated_at,
             v.version_number, v.purpose_name, v.description, v.legal_basis,
             v.legal_basis_note, v.retention_period,
             v.created_at AS version_created_at
           FROM inventory_entry_purposes p
           JOIN inventory_entry_purpose_versions v ON v.purpose_id = p.id
           WHERE p.entry_id = $1 ${includeTombstoned ? '' : "AND p.status = 'active'"}
           ORDER BY p.id, v.version_number DESC
         ) latest
         ORDER BY latest.created_at`,
        [entryId],
      );
      return rows;
    });
  }

  /** One purpose plus its full version history, newest first. */
  findOne(
    purposeId: string,
  ): Promise<{ purpose: EntryPurposeRow; versions: EntryPurposeVersionRow[] } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<EntryPurposeRow>(
        `SELECT * FROM inventory_entry_purposes WHERE id = $1`,
        [purposeId],
      );
      const purpose = purposeRows[0];
      if (!purpose) {
        return null;
      }

      const { rows: versions } = await client.query<EntryPurposeVersionRow>(
        `SELECT * FROM inventory_entry_purpose_versions
          WHERE purpose_id = $1
          ORDER BY version_number DESC`,
        [purposeId],
      );

      return { purpose, versions };
    });
  }

  /** Append a new version. Returns null if the purpose doesn't exist or is tombstoned. */
  addVersion(
    purposeId: string,
    fields: EntryPurposeFields,
    actorId: string | null,
  ): Promise<{ previous: EntryPurposeVersionRow; next: EntryPurposeVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: purposeRows } = await client.query<EntryPurposeRow>(
        `SELECT * FROM inventory_entry_purposes WHERE id = $1 FOR UPDATE`,
        [purposeId],
      );
      const purpose = purposeRows[0];
      if (!purpose || purpose.status !== 'active') {
        return null;
      }

      const { rows: prevRows } = await client.query<EntryPurposeVersionRow>(
        `SELECT * FROM inventory_entry_purpose_versions
          WHERE purpose_id = $1
          ORDER BY version_number DESC
          LIMIT 1`,
        [purposeId],
      );
      const previous = prevRows[0]!;
      const nextNumber = previous.version_number + 1;

      const { rows: nextRows } = await client.query<EntryPurposeVersionRow>(
        `INSERT INTO inventory_entry_purpose_versions
           (purpose_id, version_number, purpose_name, description, legal_basis,
            legal_basis_note, retention_period, retention_months, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          purposeId,
          nextNumber,
          fields.purposeName,
          fields.description,
          fields.legalBasis,
          fields.legalBasisNote,
          fields.retentionPeriod,
          fields.retentionMonths ?? null,
          actorId,
        ],
      );

      await client.query(
        `UPDATE inventory_entry_purposes SET updated_at = now() WHERE id = $1`,
        [purposeId],
      );

      return { previous, next: nextRows[0]! };
    });
  }

  /** Soft-delete. Returns null if the purpose doesn't exist or is already tombstoned. */
  tombstone(
    purposeId: string,
    reason: string | null,
    actorId: string | null,
  ): Promise<EntryPurposeRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<EntryPurposeRow>(
        `UPDATE inventory_entry_purposes
            SET status = 'tombstoned',
                tombstone_reason = $2,
                tombstoned_at = now(),
                tombstoned_by = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [purposeId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }
}
