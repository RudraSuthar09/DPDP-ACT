import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface PurposeLinkRow {
  id: string;
  consent_purpose_id: string;
  consent_purpose_name: string | null;
  inventory_purpose_id: string;
  inventory_purpose_name: string | null;
  entry_category: string | null;
  origin: 'manual' | 'accepted_suggestion';
  suggestion_confidence: string | null;
  linked_at: Date;
}

/** A candidate pairing, straight from the two registers, for the suggester to
 *  score. Read here rather than in the service so all SQL stays in one file. */
export interface LinkCandidateRow {
  consent_purpose_id: string;
  consent_purpose_name: string;
  inventory_purpose_id: string;
  inventory_purpose_name: string;
  entry_category: string;
  already_linked: boolean;
}

/**
 * `consent_purpose_inventory_links` — the one table this feature owns.
 *
 * NOTE ON R2. These queries join `consent_purpose_versions` and
 * `inventory_entry_purpose_versions` to resolve NAMES for display. That is a
 * read across module boundaries and it is the deliberate exception this table
 * exists to make: the link table's entire purpose is to relate two other
 * modules' rows, and a mapping UI that showed two columns of bare UUIDs would
 * be unusable. It reads names only — never a decision, never a consent event,
 * never anything it could act on — and it writes nothing outside its own table.
 */
@Injectable()
export class PurposeLinksRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Active links only. Suggestions live nowhere — they are computed on demand
   *  and only ever persisted by being ACCEPTED, which makes them a link. */
  list(): Promise<PurposeLinkRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<PurposeLinkRow>(
        `SELECT l.id, l.consent_purpose_id, cpv.purpose_name AS consent_purpose_name,
                l.inventory_purpose_id, ipv.purpose_name AS inventory_purpose_name,
                ev.category AS entry_category,
                l.origin, l.suggestion_confidence::text, l.linked_at
           FROM consent_purpose_inventory_links l
           LEFT JOIN LATERAL (
             SELECT purpose_name FROM consent_purpose_versions
              WHERE purpose_id = l.consent_purpose_id
              ORDER BY version_number DESC LIMIT 1
           ) cpv ON true
           LEFT JOIN inventory_entry_purposes ip ON ip.id = l.inventory_purpose_id
           LEFT JOIN LATERAL (
             SELECT purpose_name FROM inventory_entry_purpose_versions
              WHERE purpose_id = l.inventory_purpose_id
              ORDER BY version_number DESC LIMIT 1
           ) ipv ON true
           LEFT JOIN LATERAL (
             SELECT category FROM inventory_register_entry_versions
              WHERE entry_id = ip.entry_id
              ORDER BY version_number DESC LIMIT 1
           ) ev ON true
          WHERE l.status = 'active'
          ORDER BY cpv.purpose_name, ipv.purpose_name`,
      );
      return rows;
    });
  }

  /** Which inventory purposes each of these consent purposes reaches. The one
   *  query Tier 1 depends on, and the reason it can never over-report: a
   *  consent purpose with no active row here contributes nothing. */
  async activeFor(consentPurposeIds: string[]): Promise<Map<string, string[]>> {
    if (consentPurposeIds.length === 0) {
      return new Map();
    }
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ consent_purpose_id: string; inventory_purpose_id: string }>(
        `SELECT consent_purpose_id, inventory_purpose_id
           FROM consent_purpose_inventory_links
          WHERE status = 'active' AND consent_purpose_id = ANY($1::uuid[])`,
        [consentPurposeIds],
      );
      const map = new Map<string, string[]>();
      for (const row of rows) {
        const list = map.get(row.consent_purpose_id) ?? [];
        list.push(row.inventory_purpose_id);
        map.set(row.consent_purpose_id, list);
      }
      return map;
    });
  }

  /**
   * Every active consent purpose crossed with every active inventory purpose,
   * flagged with whether a link already exists. The suggester scores these in
   * memory — a cross join of two small per-tenant registers, not a query the
   * database should be asked to be clever about.
   */
  listCandidates(): Promise<LinkCandidateRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<LinkCandidateRow>(
        `WITH consent AS (
           -- status is on consent_purposes (the lifecycle table); the NAME is
           -- on the latest version row. Same split as inventory's
           -- entries/_versions, so the same two-step read applies.
           SELECT p.id, cpv.purpose_name AS name
             FROM consent_purposes p
             JOIN LATERAL (
               SELECT purpose_name FROM consent_purpose_versions
                WHERE purpose_id = p.id ORDER BY version_number DESC LIMIT 1
             ) cpv ON true
            WHERE p.status = 'active'
         ), inv AS (
           SELECT ip.id, ipv.purpose_name, ev.category
             FROM inventory_entry_purposes ip
             JOIN inventory_register_entries e ON e.id = ip.entry_id AND e.status = 'active'
             JOIN LATERAL (
               SELECT purpose_name FROM inventory_entry_purpose_versions
                WHERE purpose_id = ip.id ORDER BY version_number DESC LIMIT 1
             ) ipv ON true
             JOIN LATERAL (
               SELECT category FROM inventory_register_entry_versions
                WHERE entry_id = ip.entry_id ORDER BY version_number DESC LIMIT 1
             ) ev ON true
            WHERE ip.status = 'active'
         )
         SELECT consent.id AS consent_purpose_id, consent.name AS consent_purpose_name,
                inv.id AS inventory_purpose_id, inv.purpose_name AS inventory_purpose_name,
                inv.category AS entry_category,
                EXISTS (
                  SELECT 1 FROM consent_purpose_inventory_links l
                   WHERE l.status = 'active'
                     AND l.consent_purpose_id = consent.id
                     AND l.inventory_purpose_id = inv.id
                ) AS already_linked
           FROM consent CROSS JOIN inv`,
      );
      return rows;
    });
  }

  async create(input: {
    consentPurposeId: string;
    inventoryPurposeId: string;
    origin: 'manual' | 'accepted_suggestion';
    confidence: number | null;
    linkedBy: string;
  }): Promise<{ id: string }> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO consent_purpose_inventory_links
           (consent_purpose_id, inventory_purpose_id, origin, suggestion_confidence, linked_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, consent_purpose_id, inventory_purpose_id)
           WHERE status = 'active' DO NOTHING
         RETURNING id`,
        [
          input.consentPurposeId,
          input.inventoryPurposeId,
          input.origin,
          input.confidence,
          input.linkedBy,
        ],
      );
      return rows[0] ?? { id: '' };
    });
  }

  /** Unlink = status change, never a DELETE (I4). A summary issued last month
   *  was issued under the mapping that existed then, and that has to stay
   *  readable. */
  async remove(linkId: string, removedBy: string, reason: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE consent_purpose_inventory_links
            SET status = 'removed', removed_by = $2, removed_at = now(), removal_reason = $3
          WHERE id = $1 AND status = 'active'`,
        [linkId, removedBy, reason],
      );
      return (rowCount ?? 0) > 0;
    });
  }
}
