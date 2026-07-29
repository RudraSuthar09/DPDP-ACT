import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import { EntryPurposesRepository } from './entry-purposes.repository';
import {
  SectorTemplatesRepository,
  type TemplateElement,
} from './sector-templates.repository';

/**
 * FR-INV-11: sector templates pre-seed common data elements (+ purposes,
 * legal basis, retention) for a fresh — or existing — tenant. The catalog
 * itself is global/read-only (SectorTemplatesRepository); applying one is an
 * ordinary tenant-scoped, audited write through the SAME repositories the
 * guided wizard and CSV import use (R3: no parallel write path), so a
 * template-seeded entry is indistinguishable from a manually-entered one.
 */
@Injectable()
export class SectorTemplatesService {
  constructor(
    private readonly templates: SectorTemplatesRepository,
    private readonly entries: RegisterEntriesRepository,
    private readonly purposes: EntryPurposesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  list() {
    return this.templates.listWithElementCount();
  }

  async findOne(id: string) {
    const found = await this.templates.findOneWithLatestVersion(id);
    if (!found) {
      throw new NotFoundException('Sector template not found.');
    }
    return found;
  }

  /**
   * Seed the calling tenant's register from a template's current version.
   * One data element + its purposes per template element; one audit entry
   * summarises the whole batch, same pattern as CSV import.
   */
  async apply(templateId: string) {
    const ctx = this.tenantContext.getOrThrow();
    const found = await this.templates.findOneWithLatestVersion(templateId);
    if (!found) {
      throw new NotFoundException('Sector template not found.');
    }
    const elements = validateElements(found.version.elements);

    const created: Array<{ entryId: string; category: string; purposeCount: number }> = [];
    for (const element of elements) {
      const { entry } = await this.entries.create(
        {
          category: element.category,
          description: element.description,
          storageLocation: element.storageLocation,
        },
        ctx.userId,
      );
      for (const purpose of element.purposes) {
        await this.purposes.create(
          entry.id,
          {
            purposeName: purpose.purposeName,
            description: null,
            legalBasis: purpose.legalBasis,
            legalBasisNote: purpose.legalBasisNote,
            retentionPeriod: purpose.retentionPeriod,
          },
          ctx.userId,
        );
      }
      created.push({ entryId: entry.id, category: element.category, purposeCount: element.purposes.length });
    }

    this.audit.annotate({
      targetType: 'inventory_sector_template_application',
      targetId: found.template.id,
      reason: `Applied sector template "${found.template.name}" — ${created.length} data element(s) seeded`,
      afterState: { sector: found.template.sector, templateId: found.template.id, createdEntries: created },
    });

    return { template: { id: found.template.id, sector: found.template.sector, name: found.template.name }, created };
  }
}

/**
 * The catalog is seeded only by our own migrations, so this is a defensive
 * sanity check (fail loudly on a malformed row) rather than untrusted-input
 * validation — Postgres only guarantees `elements` is well-formed JSON, not
 * that it matches TemplateElement[].
 */
function validateElements(raw: unknown): TemplateElement[] {
  if (!Array.isArray(raw)) {
    throw new InternalServerErrorException('Sector template elements are malformed (not an array).');
  }
  return raw.map((el, i) => {
    if (
      typeof el !== 'object' ||
      el === null ||
      typeof (el as Record<string, unknown>).category !== 'string' ||
      typeof (el as Record<string, unknown>).storageLocation !== 'string' ||
      !Array.isArray((el as Record<string, unknown>).purposes)
    ) {
      throw new InternalServerErrorException(`Sector template element #${i} is malformed.`);
    }
    const e = el as Record<string, unknown>;
    return {
      category: e.category as string,
      description: typeof e.description === 'string' ? e.description : null,
      storageLocation: e.storageLocation as string,
      purposes: (e.purposes as unknown[]).map((p) => {
        const pv = p as Record<string, unknown>;
        return {
          purposeName: pv.purposeName as string,
          legalBasis: pv.legalBasis as TemplateElement['purposes'][number]['legalBasis'],
          legalBasisNote: typeof pv.legalBasisNote === 'string' ? pv.legalBasisNote : null,
          retentionPeriod: pv.retentionPeriod as string,
        };
      }),
    };
  });
}
