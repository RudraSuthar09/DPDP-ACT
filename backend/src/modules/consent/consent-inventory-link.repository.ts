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
