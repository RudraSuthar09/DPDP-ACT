import { ConflictException, Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Persistence for FR-INV-07 — the third-party processor/vendor register (who
 * else gets this data) — plus its link table to Data Inventory register
 * entries. Same split as systems.repository.ts; see
 * 1737001100000_inventory-vendors.sql for the rationale.
 */

export interface VendorRow {
  id: string;
  status: 'active' | 'tombstoned';
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VendorVersionRow {
  id: string;
  vendor_id: string;
  version_number: number;
  name: string;
  description: string | null;
  contact_email: string | null;
  dpa_reference: string | null;
  country: string | null;
  created_at: Date;
  created_by: string | null;
}

export interface VendorFields {
  name: string;
  description: string | null;
  contactEmail: string | null;
  dpaReference: string | null;
  country: string | null;
}

export interface VendorListRow {
  id: string;
  status: 'active' | 'tombstoned';
  created_at: Date;
  updated_at: Date;
  version_number: number;
  name: string;
  description: string | null;
  contact_email: string | null;
  dpa_reference: string | null;
  country: string | null;
}

export interface EntryVendorLinkRow {
  id: string;
  entry_id: string;
  vendor_id: string;
  transfer_notes: string | null;
  status: 'active' | 'tombstoned';
  created_at: Date;
}

@Injectable()
export class VendorsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  create(
    fields: VendorFields,
    actorId: string | null,
  ): Promise<{ vendor: VendorRow; version: VendorVersionRow }> {
    return this.db.withTenant(async (client) => {
      const { rows: vendorRows } = await client.query<VendorRow>(
        `INSERT INTO inventory_vendors DEFAULT VALUES RETURNING *`,
      );
      const vendor = vendorRows[0]!;

      const { rows: versionRows } = await client.query<VendorVersionRow>(
        `INSERT INTO inventory_vendor_versions
           (vendor_id, version_number, name, description, contact_email, dpa_reference, country, created_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [vendor.id, fields.name, fields.description, fields.contactEmail, fields.dpaReference, fields.country, actorId],
      );

      return { vendor, version: versionRows[0]! };
    });
  }

  listCurrent(includeTombstoned: boolean): Promise<VendorListRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<VendorListRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (vd.id)
             vd.id, vd.status, vd.created_at, vd.updated_at,
             v.version_number, v.name, v.description, v.contact_email, v.dpa_reference, v.country
           FROM inventory_vendors vd
           JOIN inventory_vendor_versions v ON v.vendor_id = vd.id
           ${includeTombstoned ? '' : "WHERE vd.status = 'active'"}
           ORDER BY vd.id, v.version_number DESC
         ) latest
         ORDER BY latest.name`,
      );
      return rows;
    });
  }

  findOne(vendorId: string): Promise<{ vendor: VendorRow; versions: VendorVersionRow[] } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: vendorRows } = await client.query<VendorRow>(
        `SELECT * FROM inventory_vendors WHERE id = $1`,
        [vendorId],
      );
      const vendor = vendorRows[0];
      if (!vendor) {
        return null;
      }
      const { rows: versions } = await client.query<VendorVersionRow>(
        `SELECT * FROM inventory_vendor_versions WHERE vendor_id = $1 ORDER BY version_number DESC`,
        [vendorId],
      );
      return { vendor, versions };
    });
  }

  addVersion(
    vendorId: string,
    fields: VendorFields,
    actorId: string | null,
  ): Promise<{ previous: VendorVersionRow; next: VendorVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: vendorRows } = await client.query<VendorRow>(
        `SELECT * FROM inventory_vendors WHERE id = $1 FOR UPDATE`,
        [vendorId],
      );
      const vendor = vendorRows[0];
      if (!vendor || vendor.status !== 'active') {
        return null;
      }

      const { rows: prevRows } = await client.query<VendorVersionRow>(
        `SELECT * FROM inventory_vendor_versions WHERE vendor_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [vendorId],
      );
      const previous = prevRows[0]!;
      const nextNumber = previous.version_number + 1;

      const { rows: nextRows } = await client.query<VendorVersionRow>(
        `INSERT INTO inventory_vendor_versions
           (vendor_id, version_number, name, description, contact_email, dpa_reference, country, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [vendorId, nextNumber, fields.name, fields.description, fields.contactEmail, fields.dpaReference, fields.country, actorId],
      );

      await client.query(`UPDATE inventory_vendors SET updated_at = now() WHERE id = $1`, [vendorId]);

      return { previous, next: nextRows[0]! };
    });
  }

  tombstone(vendorId: string, reason: string | null, actorId: string | null): Promise<VendorRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<VendorRow>(
        `UPDATE inventory_vendors
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(),
                tombstoned_by = $3, updated_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [vendorId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  link(
    entryId: string,
    vendorId: string,
    transferNotes: string | null,
    actorId: string | null,
  ): Promise<EntryVendorLinkRow> {
    return this.db.withTenant(async (client) => {
      try {
        const { rows } = await client.query<EntryVendorLinkRow>(
          `INSERT INTO inventory_entry_vendors (entry_id, vendor_id, transfer_notes, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [entryId, vendorId, transferNotes, actorId],
        );
        return rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('This data element is already linked to this vendor.');
        }
        throw err;
      }
    });
  }

  unlink(linkId: string, reason: string | null, actorId: string | null): Promise<EntryVendorLinkRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<EntryVendorLinkRow>(
        `UPDATE inventory_entry_vendors
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(), tombstoned_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING *`,
        [linkId, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  listForEntry(entryId: string): Promise<Array<VendorListRow & { linkId: string; transferNotes: string | null }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (vd.id)
             l.id AS "linkId", l.transfer_notes AS "transferNotes",
             vd.id, vd.status, vd.created_at, vd.updated_at,
             v.version_number, v.name, v.description, v.contact_email, v.dpa_reference, v.country
           FROM inventory_entry_vendors l
           JOIN inventory_vendors vd ON vd.id = l.vendor_id
           JOIN inventory_vendor_versions v ON v.vendor_id = vd.id
           WHERE l.entry_id = $1 AND l.status = 'active'
           ORDER BY vd.id, v.version_number DESC
         ) latest
         ORDER BY latest.name`,
        [entryId],
      );
      return rows;
    });
  }

  /** Entries currently linked to one vendor — id + current category, for data-flow joins. */
  listEntriesForVendor(
    vendorId: string,
  ): Promise<Array<{ linkId: string; entryId: string; category: string }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (e.id)
             l.id AS "linkId", e.id AS "entryId", v.category
           FROM inventory_entry_vendors l
           JOIN inventory_register_entries e ON e.id = l.entry_id
           JOIN inventory_register_entry_versions v ON v.entry_id = e.id
           WHERE l.vendor_id = $1 AND l.status = 'active'
           ORDER BY e.id, v.version_number DESC
         ) latest
         ORDER BY latest.category`,
        [vendorId],
      );
      return rows;
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
