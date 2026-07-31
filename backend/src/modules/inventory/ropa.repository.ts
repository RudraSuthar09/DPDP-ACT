import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';
import type { LegalBasis } from './entry-purposes.repository';
import type { PiiConfidence } from './pii-classifier';

/**
 * Read-only aggregate for FR-INV-09 — the Record of Processing Activities.
 * Pulls the full current state of the register in ONE round trip: every
 * ACTIVE (non-tombstoned) data element, its current version, its current PII
 * classification decision, and every currently-active purpose/system/vendor
 * linked to it (each at ITS OWN current version), nested as JSON arrays via
 * LATERAL + jsonb_agg rather than a flat cross-join (unlike DataFlowRepository,
 * which deliberately flattens for a linked-table UI — this is a document
 * export, so one row per element, with children nested, is the right shape).
 *
 * Tombstoned entries, tombstoned purposes/systems/vendors, and removed links
 * are excluded by construction (every join/subquery filters status = 'active')
 * — there is no "include tombstoned" flag here, unlike the register list:
 * FR-INV-09 asks what is CURRENTLY true, not the full history.
 */
export interface RopaPurpose {
  /** The `inventory_entry_purposes` row id. Carried so the DPR Personal Data
   *  Summary can attribute an entry to a data principal by ID through the
   *  curated purpose links — never by matching purpose NAMES, which is the one
   *  shortcut that would let a statutory document claim the wrong thing. */
  purposeId: string;
  purposeName: string;
  description: string | null;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  retentionPeriod: string;
}
export interface RopaSystem {
  name: string;
  systemType: string;
  hostingLocation: string | null;
}
export interface RopaVendor {
  name: string;
  country: string | null;
  transferNotes: string | null;
}

export interface RopaEntryRow {
  id: string;
  category: string;
  description: string | null;
  storage_location: string;
  pii_category: string | null;
  pii_confidence: PiiConfidence | null;
  pii_decision: 'undecided' | 'accepted' | 'rejected';
  purposes: RopaPurpose[];
  systems: RopaSystem[];
  vendors: RopaVendor[];
}

@Injectable()
export class RopaRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  listActiveEntries(): Promise<RopaEntryRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<RopaEntryRow>(
        `SELECT
           e.id, ev.category, ev.description, ev.storage_location,
           e.pii_category, e.pii_confidence, e.pii_decision,
           COALESCE(purposes.data, '[]'::jsonb) AS purposes,
           COALESCE(systems.data, '[]'::jsonb) AS systems,
           COALESCE(vendors.data, '[]'::jsonb) AS vendors
         FROM inventory_register_entries e
         JOIN LATERAL (
           SELECT category, description, storage_location
           FROM inventory_register_entry_versions v
           WHERE v.entry_id = e.id ORDER BY v.version_number DESC LIMIT 1
         ) ev ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'purposeId', p.id,
             'purposeName', pv.purpose_name, 'description', pv.description,
             'legalBasis', pv.legal_basis, 'legalBasisNote', pv.legal_basis_note,
             'retentionPeriod', pv.retention_period
           ) ORDER BY pv.purpose_name) AS data
           FROM inventory_entry_purposes p
           JOIN LATERAL (
             SELECT purpose_name, description, legal_basis, legal_basis_note, retention_period
             FROM inventory_entry_purpose_versions pv2
             WHERE pv2.purpose_id = p.id ORDER BY pv2.version_number DESC LIMIT 1
           ) pv ON true
           WHERE p.entry_id = e.id AND p.status = 'active'
         ) purposes ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'name', sv.name, 'systemType', sv.system_type, 'hostingLocation', sv.hosting_location
           ) ORDER BY sv.name) AS data
           FROM inventory_entry_systems l
           JOIN inventory_systems s ON s.id = l.system_id AND s.status = 'active'
           JOIN LATERAL (
             SELECT name, system_type, hosting_location
             FROM inventory_system_versions sv2
             WHERE sv2.system_id = s.id ORDER BY sv2.version_number DESC LIMIT 1
           ) sv ON true
           WHERE l.entry_id = e.id AND l.status = 'active'
         ) systems ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object(
             'name', vv.name, 'country', vv.country, 'transferNotes', l.transfer_notes
           ) ORDER BY vv.name) AS data
           FROM inventory_entry_vendors l
           JOIN inventory_vendors vd ON vd.id = l.vendor_id AND vd.status = 'active'
           JOIN LATERAL (
             SELECT name, country
             FROM inventory_vendor_versions vv2
             WHERE vv2.vendor_id = vd.id ORDER BY vv2.version_number DESC LIMIT 1
           ) vv ON true
           WHERE l.entry_id = e.id AND l.status = 'active'
         ) vendors ON true
         WHERE e.status = 'active'
         ORDER BY ev.category`,
      );
      return rows;
    });
  }
}
