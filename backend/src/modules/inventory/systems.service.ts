import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RegisterEntriesRepository } from './register-entries.repository';
import { SystemsRepository, type SystemFields, type SystemVersionRow } from './systems.repository';

function versionState(v: SystemVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.name,
    systemType: v.system_type,
    description: v.description,
    hostingLocation: v.hosting_location,
    accessControlNote: v.access_control_note,
  };
}

/** Systems/assets register (FR-INV-06) — where data lives, linkable to register entries. */
@Injectable()
export class SystemsService {
  constructor(
    private readonly repo: SystemsRepository,
    private readonly entries: RegisterEntriesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async create(fields: SystemFields) {
    const ctx = this.tenantContext.getOrThrow();
    const { system, version } = await this.repo.create(fields, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_system',
      targetId: system.id,
      reason: `System "${fields.name}" added to the systems register`,
      afterState: versionState(version),
    });

    return { system, version };
  }

  list(includeTombstoned: boolean) {
    return this.repo.listCurrent(includeTombstoned);
  }

  async findOne(id: string) {
    const found = await this.repo.findOne(id);
    if (!found) {
      throw new NotFoundException('System not found.');
    }
    const linkedEntries = await this.repo.listEntriesForSystem(id);
    return { ...found, linkedEntries };
  }

  async update(id: string, fields: SystemFields) {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.addVersion(id, fields, ctx.userId);
    if (!result) {
      throw new NotFoundException('System not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_system',
      targetId: id,
      reason: `System "${fields.name}" edited (version ${result.next.version_number})`,
      beforeState: versionState(result.previous),
      afterState: versionState(result.next),
    });

    return result.next;
  }

  async tombstone(id: string, reason: string | null) {
    const ctx = this.tenantContext.getOrThrow();
    const system = await this.repo.tombstone(id, reason, ctx.userId);
    if (!system) {
      throw new NotFoundException('System not found, or it is already tombstoned.');
    }

    this.audit.annotate({
      targetType: 'inventory_system',
      targetId: id,
      reason: reason ?? 'System removed from the register',
      afterState: { status: 'tombstoned' },
    });

    return system;
  }

  private async requireActiveEntry(entryId: string) {
    const found = await this.entries.findOne(entryId);
    if (!found || found.entry.status !== 'active') {
      throw new NotFoundException('Data element not found, or it has been tombstoned.');
    }
  }

  private async requireActiveSystem(systemId: string) {
    const found = await this.repo.findOne(systemId);
    if (!found || found.system.status !== 'active') {
      throw new NotFoundException('System not found, or it has been tombstoned.');
    }
    return found;
  }

  async link(entryId: string, systemId: string) {
    const ctx = this.tenantContext.getOrThrow();
    await this.requireActiveEntry(entryId);
    const { versions } = await this.requireActiveSystem(systemId);
    const link = await this.repo.link(entryId, systemId, ctx.userId);

    this.audit.annotate({
      targetType: 'inventory_entry_system_link',
      targetId: link.id,
      reason: `Data element linked to system "${versions[0]!.name}"`,
      afterState: { entryId, systemId },
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
      targetType: 'inventory_entry_system_link',
      targetId: linkId,
      reason: reason ?? 'System unlinked from data element',
      afterState: { status: 'tombstoned' },
    });

    return link;
  }

  listForEntry(entryId: string) {
    return this.repo.listForEntry(entryId);
  }
}
