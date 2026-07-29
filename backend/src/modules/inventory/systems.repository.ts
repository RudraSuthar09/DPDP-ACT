import { ConflictException, Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Persistence for FR-INV-06 — the systems/assets register (where data lives)
 * — plus its link table to Data Inventory register entries. Same
 * lifecycle-table / append-only-version split as the register entry itself;
 * see 1737001000000_inventory-systems.sql for the versioned-entity-vs-plain-
 * link rationale.
 */

export interface SystemRow {
  id: string;
  status: 'active' | 'tombstoned';
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SystemVersionRow {
  id: string;
  system_id: string;
  version_number: number;
  name: string;
  system_type: string;
  description: string | null;
  hosting_location: string | null;
  created_at: Date;
  created_by: string | null;
}

export interface SystemFields {
  name: string;
  systemType: string;
  description: string | null;
  hostingLocation: string | null;
}

export interface SystemListRow {
  id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
  updated_at: Date;
  version_number: number;
  name: string;
  system_type: string;
  description: string | null;
  hosting_location: string | null;
}

export interface EntrySystemLinkRow {
  id: string;
  entry_id: string;
  system_id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
}

@Injectable()
export class SystemsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(
    fields: SystemFields,
    actorId: string | null,
  ): Promise<{ system: SystemRow; version: SystemVersionRow }> {
    return this.db.withTenant(async (client) => {
      const { rows: systemRows } = await client.query<SystemRow>(
        `INSERT INTO inventory_systems DEFAULT VALUES RETURNING *`,
      );
      const system = systemRows[0]!;

      const { rows: versionRows } = await client.query<SystemVersionRow>(
        `INSERT INTO inventory_system_versions
           (system_id, version_number, name, system_type, description, hosting_location, created_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [system.id, fields.name, fields.systemType, fields.description, fields.hostingLocation, actorId],
      );

      return { system, version: versionRows[0]! };
    });
  }

  listCurrent(includeTombstoned: boolean): Promise<SystemListRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SystemListRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (s.id)
             s.id, s.status, s.created_at, s.updated_at,
             v.version_number, v.name, v.system_type, v.description, v.hosting_location
           FROM inventory_systems s
           JOIN inventory_system_versions v ON v.system_id = s.id
           ${includeTombstoned ? '' : "WHERE s.status = 'active'"}
           ORDER BY s.id, v.version_number DESC
         ) latest
         ORDER BY latest.name`,
      );
      return rows;
    });
  }

  findOne(systemId: string): Promise<{ system: SystemRow; versions: SystemVersionRow[] } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: systemRows } = await client.query<SystemRow>(
        `SELECT * FROM inventory_systems WHERE id = $1`,
        [systemId],
      );
      const system = systemRows[0];
      if (!system) {
        return null;
      }
      const { rows: versions } = await client.query<SystemVersionRow>(
        `SELECT * FROM inventory_system_versions WHERE system_id = $1 ORDER BY version_number DESC`,
        [systemId],
      );
      return { system, versions };
    });
  }

  addVersion(
    systemId: string,
    fields: SystemFields,
    actorId: string | null,
  ): Promise<{ previous: SystemVersionRow; next: SystemVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: systemRows } = await client.query<SystemRow>(
        `SELECT * FROM inventory_systems WHERE id = $1 FOR UPDATE`,
        [systemId],
      );
      const system = systemRows[0];
      if (!system || system.status !== 'active') {
        return null;
      }

      const { rows: prevRows } = await client.query<SystemVersionRow>(
        `SELECT * FROM inventory_system_versions WHERE system_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [systemId],
      );
      const previous = prevRows[0]!;
      const nextNumber = previous.version_number + 1;

      const { rows: nextRows } = await client.query<SystemVersionRow>(
        `INSERT INTO inventory_system_versions
           (system_id, version_number, name, system_type, description, hosting_location, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [systemId, nextNumber, fields.name, fields.systemType, fields.description, fields.hostingLocation, actorId],
      );

      await client.query(`UPDATE inventory_systems SET updated_at = now() WHERE id = $1`, [systemId]);

      return { previous, next: nextRows[0]! };
    });
  }

  tombstone(systemId: string, reason: string | null, actorId: string | null): Promise<SystemRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SystemRow>(
        `UPDATE inventory_systems
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(),
                tombstoned_by = $3, updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [systemId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /** Link an entry to a system. Throws if the pair is already actively linked. */
  link(entryId: string, systemId: string, actorId: string | null): Promise<EntrySystemLinkRow> {
    return this.db.withTenant(async (client) => {
      try {
        const { rows } = await client.query<EntrySystemLinkRow>(
          `INSERT INTO inventory_entry_systems (entry_id, system_id, created_by)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [entryId, systemId, actorId],
        );
        return rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('This data element is already linked to this system.');
        }
        throw err;
      }
    });
  }

  unlink(linkId: string, reason: string | null, actorId: string | null): Promise<EntrySystemLinkRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<EntrySystemLinkRow>(
        `UPDATE inventory_entry_systems
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(), tombstoned_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [linkId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /** Systems currently linked to one entry, with their current version. */
  listForEntry(entryId: string): Promise<Array<SystemListRow & { linkId: string }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (s.id)
             l.id AS "linkId",
             s.id, s.status, s.created_at, s.updated_at,
             v.version_number, v.name, v.system_type, v.description, v.hosting_location
           FROM inventory_entry_systems l
           JOIN inventory_systems s ON s.id = l.system_id
           JOIN inventory_system_versions v ON v.system_id = s.id
           WHERE l.entry_id = $1 AND l.status = 'active'
           ORDER BY s.id, v.version_number DESC
         ) latest
         ORDER BY latest.name`,
        [entryId],
      );
      return rows;
    });
  }

  /** Entries currently linked to one system — id + current category, for data-flow joins. */
  listEntriesForSystem(
    systemId: string,
  ): Promise<Array<{ linkId: string; entryId: string; category: string }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (e.id)
             l.id AS "linkId", e.id AS "entryId", v.category
           FROM inventory_entry_systems l
           JOIN inventory_register_entries e ON e.id = l.entry_id
           JOIN inventory_register_entry_versions v ON v.entry_id = e.id
           WHERE l.system_id = $1 AND l.status = 'active'
           ORDER BY e.id, v.version_number DESC
         ) latest
         ORDER BY latest.category`,
        [systemId],
      );
      return rows;
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
