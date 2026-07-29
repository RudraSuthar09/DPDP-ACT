import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';
import type { PiiConfidence } from './pii-classifier';

/**
 * Persistence for the Data Inventory register (FR-INV-01/08). Ordinary tenant
 * data under RLS — SELECT/INSERT/UPDATE via app.apply_tenant_rls(), no DELETE
 * grant. Content is append-only by convention: this repository INSERTs a new
 * version row on every edit and never UPDATEs or DELETEs an existing one.
 * PII classification (FR-INV-03/04) is the one field set that IS updated in
 * place on the entry row — see setPiiDecision().
 */

export type PiiDecision = 'undecided' | 'accepted' | 'rejected';

export interface RegisterEntryRow {
  id: string;
  status: 'active' | 'tombstoned';
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  pii_category: string | null;
  pii_confidence: PiiConfidence | null;
  pii_decision: PiiDecision;
  pii_decision_reason: string | null;
  pii_decided_at: Date | null;
  pii_decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RegisterEntryVersionRow {
  id: string;
  entry_id: string;
  version_number: number;
  category: string;
  description: string | null;
  /** DEPRECATED — see the migration header. NULL on every version created after Prompt 14. */
  purpose: string | null;
  storage_location: string;
  /** DEPRECATED — see the migration header. NULL on every version created after Prompt 14. */
  retention_period: string | null;
  created_at: Date;
  created_by: string | null;
}

export interface RegisterEntryFields {
  category: string;
  description: string | null;
  storageLocation: string;
}

/** One row of the register list: lifecycle + its current (latest) version. */
export interface RegisterEntryListRow {
  id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
  updated_at: Date;
  pii_category: string | null;
  pii_confidence: PiiConfidence | null;
  pii_decision: PiiDecision;
  version_number: number;
  category: string;
  description: string | null;
  purpose: string | null;
  storage_location: string;
  retention_period: string | null;
  version_created_at: Date;
  purpose_count: number;
}

@Injectable()
export class RegisterEntriesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Create an entry and its first version (version_number = 1) together. */
  create(
    fields: RegisterEntryFields,
    actorId: string | null,
  ): Promise<{ entry: RegisterEntryRow; version: RegisterEntryVersionRow }> {
    return this.db.withTenant(async (client) => {
      const { rows: entryRows } = await client.query<RegisterEntryRow>(
        `INSERT INTO inventory_register_entries DEFAULT VALUES RETURNING *`,
      );
      // INSERT ... RETURNING * always yields exactly one row.
      const entry = entryRows[0]!;

      const { rows: versionRows } = await client.query<RegisterEntryVersionRow>(
        `INSERT INTO inventory_register_entry_versions
           (entry_id, version_number, category, description, storage_location, created_by)
         VALUES ($1, 1, $2, $3, $4, $5)
         RETURNING *`,
        [entry.id, fields.category, fields.description, fields.storageLocation, actorId],
      );

      return { entry, version: versionRows[0]! };
    });
  }

  /** The register: every active (or, optionally, every) entry's current version. */
  listCurrent(includeTombstoned: boolean): Promise<RegisterEntryListRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RegisterEntryListRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (e.id)
             e.id, e.status, e.created_at, e.updated_at,
             e.pii_category, e.pii_confidence, e.pii_decision,
             v.version_number, v.category, v.description, v.purpose,
             v.storage_location, v.retention_period,
             v.created_at AS version_created_at,
             (SELECT count(*)::int FROM inventory_entry_purposes p
                WHERE p.entry_id = e.id AND p.status = 'active') AS purpose_count
           FROM inventory_register_entries e
           JOIN inventory_register_entry_versions v ON v.entry_id = e.id
           ${includeTombstoned ? '' : "WHERE e.status = 'active'"}
           ORDER BY e.id, v.version_number DESC
         ) latest
         ORDER BY latest.category, latest.created_at`,
      );
      return rows;
    });
  }

  /**
   * Counters for the compliance dashboard (FR-DSH-01): how many active data
   * elements are in the register, and how many distinct categories they fall
   * into. Same "latest version per entry" shape as listCurrent() — a
   * tombstoned entry's category does not count towards either number.
   */
  summary(): Promise<{ elements: number; categories: number }> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ elements: string; categories: string }>(
        `SELECT count(*)::text AS elements, count(DISTINCT latest.category)::text AS categories
           FROM (
             SELECT DISTINCT ON (e.id) e.id, v.category
               FROM inventory_register_entries e
               JOIN inventory_register_entry_versions v ON v.entry_id = e.id
              WHERE e.status = 'active'
              ORDER BY e.id, v.version_number DESC
           ) latest`,
      );
      return { elements: Number(rows[0]?.elements ?? 0), categories: Number(rows[0]?.categories ?? 0) };
    });
  }

  /** One entry plus its full version history, newest first (FR-INV-08). */
  findOne(
    entryId: string,
  ): Promise<{ entry: RegisterEntryRow; versions: RegisterEntryVersionRow[] } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: entryRows } = await client.query<RegisterEntryRow>(
        `SELECT * FROM inventory_register_entries WHERE id = $1`,
        [entryId],
      );
      const entry = entryRows[0];
      if (!entry) {
        return null;
      }

      const { rows: versions } = await client.query<RegisterEntryVersionRow>(
        `SELECT * FROM inventory_register_entry_versions
          WHERE entry_id = $1
          ORDER BY version_number DESC`,
        [entryId],
      );

      return { entry, versions };
    });
  }

  /**
   * Append a new version. `FOR UPDATE` on the entry row serialises concurrent
   * edits of the SAME entry so two racing requests cannot compute the same
   * next version_number (the UNIQUE (entry_id, version_number) constraint
   * would catch it anyway, but this avoids the retry). Returns null if the
   * entry doesn't exist or is tombstoned — a tombstoned entry is not editable.
   */
  addVersion(
    entryId: string,
    fields: RegisterEntryFields,
    actorId: string | null,
  ): Promise<{ previous: RegisterEntryVersionRow; next: RegisterEntryVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: entryRows } = await client.query<RegisterEntryRow>(
        `SELECT * FROM inventory_register_entries WHERE id = $1 FOR UPDATE`,
        [entryId],
      );
      const entry = entryRows[0];
      if (!entry || entry.status !== 'active') {
        return null;
      }

      const { rows: prevRows } = await client.query<RegisterEntryVersionRow>(
        `SELECT * FROM inventory_register_entry_versions
          WHERE entry_id = $1
          ORDER BY version_number DESC
          LIMIT 1`,
        [entryId],
      );
      // Every entry is created with a version 1 (see create()), so an active
      // entry always has at least one version row here.
      const previous = prevRows[0]!;
      const nextNumber = previous.version_number + 1;

      const { rows: nextRows } = await client.query<RegisterEntryVersionRow>(
        `INSERT INTO inventory_register_entry_versions
           (entry_id, version_number, category, description, storage_location, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [entryId, nextNumber, fields.category, fields.description, fields.storageLocation, actorId],
      );

      await client.query(
        `UPDATE inventory_register_entries SET updated_at = now() WHERE id = $1`,
        [entryId],
      );

      return { previous, next: nextRows[0]! };
    });
  }

  /** Soft-delete. Returns null if the entry doesn't exist or is already tombstoned. */
  tombstone(
    entryId: string,
    reason: string | null,
    actorId: string | null,
  ): Promise<RegisterEntryRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RegisterEntryRow>(
        `UPDATE inventory_register_entries
            SET status = 'tombstoned',
                tombstone_reason = $2,
                tombstoned_at = now(),
                tombstoned_by = $3,
                updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [entryId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Record a human's accept/reject decision on a PII classification
   * suggestion (FR-INV-04). Updated IN PLACE on the entry row — this is
   * compliance metadata about the entry's current content, not new content
   * itself, so it does not fork a new version (see the migration header).
   * Returns null if the entry doesn't exist or is tombstoned (a tombstoned
   * entry's classification is frozen along with everything else about it).
   */
  setPiiDecision(
    entryId: string,
    input: { category: string; confidence: PiiConfidence; decision: 'accepted' | 'rejected'; reason: string | null },
    actorId: string | null,
  ): Promise<{ previous: RegisterEntryRow; next: RegisterEntryRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: currentRows } = await client.query<RegisterEntryRow>(
        `SELECT * FROM inventory_register_entries WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [entryId],
      );
      const previous = currentRows[0];
      if (!previous) {
        return null;
      }

      const { rows: nextRows } = await client.query<RegisterEntryRow>(
        `UPDATE inventory_register_entries
            SET pii_category = $2,
                pii_confidence = $3,
                pii_decision = $4,
                pii_decision_reason = $5,
                pii_decided_at = now(),
                pii_decided_by = $6,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [entryId, input.category, input.confidence, input.decision, input.reason, actorId],
      );

      return { previous, next: nextRows[0]! };
    });
  }
}
