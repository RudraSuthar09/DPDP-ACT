import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import { VendorsRepository, type VendorFields, type VendorVersionRow } from './vendors.repository';

function versionState(v: VendorVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.name,
    description: v.description,
    contactEmail: v.contact_email,
    dpaReference: v.dpa_reference,
    country: v.country,
  };
}

/** Third-party processor/vendor register (FR-INV-07) — who else receives this data. */
@Injectable()
export class VendorsService {
  constructor(
    private readonly repo: VendorsRepository,
    private readonly entries: RegisterEntriesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async create(fields: VendorFields) {
    const ctx = this.tenantContext.getOrThrow();
    const { vendor, version } = await this.repo.create(fields, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_vendor',
      targetId: vendor.id,
      reason: `Vendor "${fields.name}" added to the vendor register`,
      afterState: versionState(version),
    });

    return { vendor, version };
  }

  list(includeTombstoned: boolean) {
    return this.repo.listCurrent(includeTombstoned);
  }

  async findOne(id: string) {
    const found = await this.repo.findOne(id);
    if (!found) {
      throw new NotFoundException('Vendor not found.');
    }
    const linkedEntries = await this.repo.listEntriesForVendor(id);
    return { ...found, linkedEntries };
  }

  async update(id: string, fields: VendorFields) {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.addVersion(id, fields, ctx.userId);
    if (!result) {
      throw new NotFoundException('Vendor not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_vendor',
      targetId: id,
      reason: `Vendor "${fields.name}" edited (version ${result.next.version_number})`,
      beforeState: versionState(result.previous),
      afterState: versionState(result.next),
    });

    return result.next;
  }

  async tombstone(id: string, reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const vendor = await this.repo.tombstone(id, reason, ctx.userId);
    if (!vendor) {
      throw new NotFoundException('Vendor not found, or it is already tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_vendor',
      targetId: id,
      reason: reason ?? 'Vendor removed from the register',
      afterState: { status: 'tombstoned' },
    });

    return vendor;
  }

  private async requireActiveEntry(entryId: string) {
    const found = await this.entries.findOne(entryId);
    if (!found || found.entry.status !== 'active') {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }
  }

  private async requireActiveVendor(vendorId: string) {
    const found = await this.repo.findOne(vendorId);
    if (!found || found.vendor.status !== 'active') {
      throw new NotFoundException('Vendor not found, or it has been tombstoned.');
    }
    return found;
  }

  async link(entryId: string, vendorId: string, transferNotes: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    await this.requireActiveEntry(entryId);
    const { versions } = await this.requireActiveVendor(vendorId);
    const link = await this.repo.link(entryId, vendorId, transferNotes, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_entry_vendor_link',
      targetId: link.id,
      reason: `Data element linked to vendor "${versions[0]!.name}"`,
      afterState: { entryId, vendorId, transferNotes },
    });

    return link;
  }

  async unlink(linkId: string, reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const link = await this.repo.unlink(linkId, reason, ctx.userId);
    if (!link) {
      throw new NotFoundException('Link not found, or it is already removed.');
    }

    this.audit.annotate({
      targetType: 'inventory_entry_vendor_link',
      targetId: linkId,
      reason: reason ?? 'Vendor unlinked from data element',
      afterState: { status: 'tombstoned' },
    });

    return link;
  }

  listForEntry(entryId: string) {
    return this.repo.listForEntry(entryId);
  }
}
