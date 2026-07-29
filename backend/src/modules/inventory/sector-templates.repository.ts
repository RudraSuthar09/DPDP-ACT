import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';
import type { LegalBasis } from './entry-purposes.repository';

/**
 * Read access to the sector template catalog (FR-INV-11). Deliberately NOT
 * behind RLS/tenant scoping — see 1737001200000_inventory-sector-templates.sql
 * for why. Applying a template (writing entries/purposes for the CALLING
 * tenant) is handled by SectorTemplatesService, which uses the ordinary
 * tenant-scoped repositories for that part.
 */

export type SectorTemplateSector = 'healthcare' | 'retail' | 'edtech' | 'fintech';

export interface SectorTemplateRow {
  id: string;
  sector: SectorTemplateSector;
  name: string;
  created_at: Date;
}

export interface TemplateElementPurpose {
  purposeName: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  retentionPeriod: string;
}

export interface TemplateElement {
  category: string;
  description: string | null;
  storageLocation: string;
  purposes: TemplateElementPurpose[];
}

export interface SectorTemplateVersionRow {
  id: string;
  template_id: string;
  version_number: number;
  elements: TemplateElement[];
  created_at: Date;
}

@Injectable()
export class SectorTemplatesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Every template with its current (latest) version's element count. */
  listWithElementCount(): Promise<Array<SectorTemplateRow & { elementCount: number }>> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (t.id)
             t.id, t.sector, t.name, t.created_at,
             jsonb_array_length(v.elements) AS "elementCount"
           FROM inventory_sector_templates t
           JOIN inventory_sector_template_versions v ON v.template_id = t.id
           ORDER BY t.id, v.version_number DESC
         ) latest
         ORDER BY latest.sector`,
      );
      return rows;
    });
  }

  findOneWithLatestVersion(
    templateId: string,
  ): Promise<{ template: SectorTemplateRow; version: SectorTemplateVersionRow } | null> {
    return this.db.withTenant(async (client) => {
      const { rows: templateRows } = await client.query<SectorTemplateRow>(
        `SELECT * FROM inventory_sector_templates WHERE id = $1`,
        [templateId],
      );
      const template = templateRows[0];
      if (!template) {
        return null;
      }
      const { rows: versionRows } = await client.query<SectorTemplateVersionRow>(
        `SELECT * FROM inventory_sector_template_versions
          WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1`,
        [templateId],
      );
      const version = versionRows[0];
      if (!version) {
        return null;
      }
      return { template, version };
    });
  }
}
