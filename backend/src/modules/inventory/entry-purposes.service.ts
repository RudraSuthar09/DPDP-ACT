import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import {
  EntryPurposesRepository,
  type EntryPurposeFields,
  type EntryPurposeVersionRow,
} from './entry-purposes.repository';

function versionState(v: EntryPurposeVersionRow) {
  return {
    versionNumber: v.version_number,
    purposeName: v.purpose_name,
    description: v.description,
    legalBasis: v.legal_basis,
    legalBasisNote: v.legal_basis_note,
    retentionPeriod: v.retention_period,
  };
}

/**
 * Processing purposes + legal basis + retention (FR-INV-05) linked to a Data
 * Inventory register entry — one entry, many purposes, each independently
 * versioned. See entry-purposes.repository.ts for the persistence shape and
 * the migration header for why this replaced the old flat purpose/
 * retention_period columns.
 */
@Injectable()
export class EntryPurposesService {
  constructor(
    private readonly repo: EntryPurposesRepository,
    private readonly entries: RegisterEntriesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  private async requireActiveEntry(entryId: string) {
    const found = await this.entries.findOne(entryId);
    if (!found || found.entry.status !== 'active') {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }
    return found.entry;
  }

  async create(entryId: string, fields: EntryPurposeFields) {
    const ctx = this.tenantContext.getOrThrow();
    await this.requireActiveEntry(entryId);

    const { purpose, version } = await this.repo.create(entryId, fields, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_entry_purpose',
      targetId: purpose.id,
      reason: `Purpose "${fields.purposeName}" (${fields.legalBasis}) added to a data element`,
      afterState: { entryId, ...versionState(version) },
    });

    return { purpose, version };
  }

  async listForEntry(entryId: string, includeTombstoned: boolean) {
    await this.requireActiveEntry(entryId);
    return this.repo.listForEntry(entryId, includeTombstoned);
  }

  async findOne(purposeId: string) {
    const found = await this.repo.findOne(purposeId);
    if (!found) {
      throw new NotFoundException('Purpose not found.');
    }
    return found;
  }

  async update(purposeId: string, fields: EntryPurposeFields) {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.addVersion(purposeId, fields, ctx.userId);
    if (!result) {
      throw new NotFoundException('Purpose not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_entry_purpose',
      targetId: purposeId,
      reason: `Purpose "${fields.purposeName}" edited (version ${result.next.version_number})`,
      beforeState: versionState(result.previous),
      afterState: versionState(result.next),
    });

    return result.next;
  }

  async tombstone(purposeId: string, reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const purpose = await this.repo.tombstone(purposeId, reason, ctx.userId);
    if (!purpose) {
      throw new NotFoundException('Purpose not found, or it is already tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_entry_purpose',
      targetId: purposeId,
      reason: reason ?? 'Purpose removed from a data element',
      afterState: { status: 'tombstoned' },
    });

    return purpose;
  }
}
