import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * A thin writer for `consent_purpose_inventory_links` — the shared consent↔
 * inventory bridge (Prompt 32). That table is a deliberate cross-module object:
 * it relates a consent_purpose to an inventory_entry_purpose so Tier-1 Personal
 * Data Summaries can attribute categories of data to a subject's consent.
 *
 * dprequest's PurposeLinksService remains the CURATION manager (scored
 * suggestions, the review UI, unlink-with-reason). This writer exists so the
 * new consent-form builder can create a link DIRECTLY when a form row is tied to
 * a Data Inventory element — a human decision at row-creation time, origin
 * 'manual'. It is deliberately import-free of the dprequest module (which
 * imports ConsentModule; a reverse import would be circular). Both writers honour
 * the one-active-link-per-pair unique index, so they cannot conflict.
 */
@Injectable()
export class ConsentInventoryLinkRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** For a consent purpose, its linked inventory purposes that carry a STRUCTURED
   *  retention (retention_months set) — the raw material for a retention clock on
   *  a consent grant. Reads inventory tables here, an extension of the same
   *  documented cross-module bridge exception this repo already embodies (the link
   *  relates consent and inventory rows; resolving the link's inventory side is
   *  its whole job). Returns retention months + the element category + entry id
   *  for display; never a customer value. */
  linkedRetainableInventoryPurposes(
    consentPurposeId: string,
  ): Promise<Array<{ inventoryPurposeId: string; retentionMonths: number; legalBasis: string; entryId: string; category: string }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{
        inventoryPurposeId: string;
        retentionMonths: number;
        legalBasis: string;
        entryId: string;
        category: string;
      }>(
        `SELECT l.inventory_purpose_id AS "inventoryPurposeId",
                ipv.retention_months AS "retentionMonths",
                ipv.legal_basis AS "legalBasis",
                ip.entry_id AS "entryId",
                ev.category AS category
           FROM consent_purpose_inventory_links l
           JOIN inventory_entry_purposes ip ON ip.id = l.inventory_purpose_id AND ip.status = 'active'
           JOIN LATERAL (
             SELECT retention_months, legal_basis FROM inventory_entry_purpose_versions
              WHERE purpose_id = l.inventory_purpose_id ORDER BY version_number DESC LIMIT 1
           ) ipv ON true
           JOIN LATERAL (
             SELECT category FROM inventory_register_entry_versions
              WHERE entry_id = ip.entry_id ORDER BY version_number DESC LIMIT 1
           ) ev ON true
          WHERE l.consent_purpose_id = $1 AND l.status = 'active' AND ipv.retention_months IS NOT NULL`,
        [consentPurposeId],
      );
      return rows;
    });
  }

  /** Idempotently link a consent purpose to each of an element's inventory
   *  purposes. ON CONFLICT DO NOTHING against the active-pair unique index, so
   *  re-linking (or a pair dprequest already curated) is a safe no-op. Returns
   *  how many new links were created. */
  async linkPurposeToInventoryPurposes(
    consentPurposeId: string,
    inventoryPurposeIds: string[],
    linkedBy: string | null,
  ): Promise<number> {
    if (inventoryPurposeIds.length === 0) return 0;
    return this.db.withTenant(async (client) => {
      let created = 0;
      for (const inventoryPurposeId of inventoryPurposeIds) {
        const { rowCount } = await client.query(
          `INSERT INTO consent_purpose_inventory_links
             (consent_purpose_id, inventory_purpose_id, origin, linked_by)
           VALUES ($1, $2, 'manual', $3)
           ON CONFLICT (tenant_id, consent_purpose_id, inventory_purpose_id)
             WHERE status = 'active' DO NOTHING`,
          [consentPurposeId, inventoryPurposeId, linkedBy],
        );
        created += rowCount ?? 0;
      }
      return created;
    });
  }
}
