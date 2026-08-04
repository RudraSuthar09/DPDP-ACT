import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import { EntryPurposesRepository } from './entry-purposes.repository';
import { SystemsRepository } from './systems.repository';
import { VendorsRepository } from './vendors.repository';
import {
  SectorTemplatesRepository,
  type TemplateElement,
  type TemplateSystem,
  type TemplateVendor,
} from './sector-templates.repository';

/**
 * FR-INV-11: sector templates pre-seed a starting register for a fresh — or
 * existing — tenant: data elements (+ purposes, legal basis, retention), the
 * systems those elements live on, the vendors/recipients they reach, and the
 * links between them. The catalog itself is global/read-only
 * (SectorTemplatesRepository); applying one is an ordinary tenant-scoped,
 * audited write through the SAME repositories the guided wizard, the systems
 * form, the vendors form and the CSV import use (R3: no parallel write path),
 * so a template-seeded row is indistinguishable from a hand-typed one — same
 * table, same version 1, same actor, same subsequent versioning.
 *
 * A template is a STARTING POINT, never a locked list. Nothing it writes is
 * flagged, protected or special-cased anywhere downstream; the tenant edits,
 * tombstones and adds to it exactly as if they had typed it themselves. Applying
 * one twice simply seeds a second copy — it never overwrites or reconciles.
 */
@Injectable()
export class SectorTemplatesService {
  constructor(
    private readonly templates: SectorTemplatesRepository,
    private readonly entries: RegisterEntriesRepository,
    private readonly purposes: EntryPurposesRepository,
    private readonly systems: SystemsRepository,
    private readonly vendors: VendorsRepository,
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
   *
   * Order matters: systems and vendors are created FIRST so their new ids are
   * known by name, then each element is created and linked to the ones it
   * names. A ref naming something the template does not define is a malformed
   * catalog row, so it fails loudly rather than silently seeding an element
   * with no storage location recorded against it.
   *
   * One audit entry summarises the whole batch, same pattern as CSV import —
   * an apply is one request, and AuditContextService merges annotations per
   * request, so this is one hash-chain entry describing everything seeded.
   */
  async apply(templateId: string) {
    const ctx = this.tenantContext.getOrThrow();
    const found = await this.templates.findOneWithLatestVersion(templateId);
    if (!found) {
      throw new NotFoundException('Sector template not found.');
    }
    const elements = validateElements(found.version.elements);
    const templateSystems = validateSystems(found.version.systems);
    const templateVendors = validateVendors(found.version.vendors);

    const systemIdsByName = new Map<string, string>();
    const createdSystems: Array<{ systemId: string; name: string }> = [];
    for (const s of templateSystems) {
      const { system } = await this.systems.create(
        {
          name: s.name,
          systemType: s.systemType,
          description: s.description,
          hostingLocation: s.hostingLocation,
          accessControlNote: s.accessControlNote,
        },
        ctx.userId,
      );
      systemIdsByName.set(s.name, system.id);
      createdSystems.push({ systemId: system.id, name: s.name });
    }

    const vendorIdsByName = new Map<string, string>();
    const createdVendors: Array<{ vendorId: string; name: string }> = [];
    for (const v of templateVendors) {
      const { vendor } = await this.vendors.create(
        {
          name: v.name,
          description: v.description,
          contactEmail: v.contactEmail,
          dpaReference: v.dpaReference,
          country: v.country,
        },
        ctx.userId,
      );
      vendorIdsByName.set(v.name, vendor.id);
      createdVendors.push({ vendorId: vendor.id, name: v.name });
    }

    const created: Array<{
      entryId: string;
      category: string;
      purposeCount: number;
      systemCount: number;
      vendorCount: number;
    }> = [];
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
      for (const name of element.systemRefs) {
        const systemId = systemIdsByName.get(name);
        if (!systemId) {
          throw new InternalServerErrorException(
            `Sector template element "${element.category}" refers to system "${name}", which the template does not define.`,
          );
        }
        await this.systems.link(entry.id, systemId, ctx.userId);
      }
      for (const ref of element.vendorRefs) {
        const vendorId = vendorIdsByName.get(ref.name);
        if (!vendorId) {
          throw new InternalServerErrorException(
            `Sector template element "${element.category}" refers to vendor "${ref.name}", which the template does not define.`,
          );
        }
        await this.vendors.link(entry.id, vendorId, ref.transferNotes, ctx.userId);
      }
      created.push({
        entryId: entry.id,
        category: element.category,
        purposeCount: element.purposes.length,
        systemCount: element.systemRefs.length,
        vendorCount: element.vendorRefs.length,
      });
    }

    this.audit.annotate({
      targetType: 'inventory_sector_template_application',
      targetId: found.template.id,
      reason:
        `Applied sector template "${found.template.name}" — ${created.length} data element(s), ` +
        `${createdSystems.length} system(s), ${createdVendors.length} vendor(s) seeded as an editable starting point`,
      afterState: {
        sector: found.template.sector,
        templateId: found.template.id,
        createdEntries: created,
        createdSystems,
        createdVendors,
      },
    });

    return {
      template: { id: found.template.id, sector: found.template.sector, name: found.template.name },
      created,
      createdSystems,
      createdVendors,
    };
  }
}

/**
 * The catalog is seeded only by our own migrations, so these are defensive
 * sanity checks (fail loudly on a malformed row) rather than untrusted-input
 * validation — Postgres only guarantees the columns are well-formed JSON, not
 * that they match the interfaces here.
 *
 * `systemRefs`/`vendorRefs` are treated as OPTIONAL and default to empty: the
 * four sector templates that predate this shape carry neither, and they must
 * keep applying exactly as they did before.
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
      systemRefs: Array.isArray(e.systemRefs)
        ? e.systemRefs.map((r, j) => {
            if (typeof r !== 'string') {
              throw new InternalServerErrorException(
                `Sector template element #${i} systemRef #${j} is not a string.`,
              );
            }
            return r;
          })
        : [],
      vendorRefs: Array.isArray(e.vendorRefs)
        ? e.vendorRefs.map((r, j) => {
            const rv = r as Record<string, unknown>;
            if (typeof rv?.name !== 'string') {
              throw new InternalServerErrorException(
                `Sector template element #${i} vendorRef #${j} is malformed.`,
              );
            }
            return {
              name: rv.name,
              transferNotes: typeof rv.transferNotes === 'string' ? rv.transferNotes : null,
            };
          })
        : [],
    };
  });
}

function validateSystems(raw: unknown): TemplateSystem[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new InternalServerErrorException('Sector template systems are malformed (not an array).');
  }
  return raw.map((s, i) => {
    const sv = s as Record<string, unknown>;
    if (typeof sv?.name !== 'string' || typeof sv?.systemType !== 'string') {
      throw new InternalServerErrorException(`Sector template system #${i} is malformed.`);
    }
    return {
      name: sv.name,
      systemType: sv.systemType,
      description: typeof sv.description === 'string' ? sv.description : null,
      hostingLocation: typeof sv.hostingLocation === 'string' ? sv.hostingLocation : null,
      accessControlNote: typeof sv.accessControlNote === 'string' ? sv.accessControlNote : null,
    };
  });
}

function validateVendors(raw: unknown): TemplateVendor[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new InternalServerErrorException('Sector template vendors are malformed (not an array).');
  }
  return raw.map((v, i) => {
    const vv = v as Record<string, unknown>;
    if (typeof vv?.name !== 'string') {
      throw new InternalServerErrorException(`Sector template vendor #${i} is malformed.`);
    }
    return {
      name: vv.name,
      description: typeof vv.description === 'string' ? vv.description : null,
      contactEmail: typeof vv.contactEmail === 'string' ? vv.contactEmail : null,
      dpaReference: typeof vv.dpaReference === 'string' ? vv.dpaReference : null,
      country: typeof vv.country === 'string' ? vv.country : null,
    };
  });
}
