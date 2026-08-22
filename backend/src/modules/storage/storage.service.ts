import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { StorageFolder, StorageMapping, StorageModuleKey, StorageRoot } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { GatewayService } from '../gateway/gateway.service';
import { StorageRepository, type StorageFolderRow, type StorageMappingRow, type StorageRootRow } from './storage.repository';
import type { CreateStorageFolderInput, CreateStorageRootInput, UpdateStorageRootInput, UpsertStorageMappingInput } from './storage.dto';

/**
 * Managing the persistent Storage & Folder Mapping foundation — CONFIGURATION
 * ONLY. No method here reads, writes, or even names a file's contents or a
 * customer value; a "folder" is a row (name + parent), and a "mapping" is a
 * pointer from a module entity to a folder id. See the migration header for
 * the full architecture.
 *
 * Audit: every mutation is @Audited at the controller (S5 interceptor writes
 * the hash-chain entry); this service annotates the domain detail.
 */
@Injectable()
export class StorageService {
  constructor(
    private readonly repo: StorageRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    private readonly gateway: GatewayService,
  ) {}

  // --- roots ------------------------------------------------------------

  async createRoot(input: CreateStorageRootInput): Promise<StorageRoot> {
    const ctx = this.tenantContext.getOrThrow();
    if (input.provider === 'gateway' && input.gatewayDeviceId) {
      // A plain foreign key does NOT apply RLS during its own referential-
      // integrity check (a documented Postgres limitation) — without this
      // explicit, tenant-scoped lookup, one tenant could bind a storage root
      // to ANOTHER tenant's Gateway device by guessing/observing its id. This
      // lookup runs under the current tenant's RLS session, so a foreign
      // device id is indistinguishable from a nonexistent one — the same
      // pattern GatewayService.createPairing already relies on for sourceId.
      const devices = await this.gateway.listDevices();
      const device = devices.find((d) => d.id === input.gatewayDeviceId);
      if (!device || device.status !== 'active') {
        throw new NotFoundException('Gateway device not found, not active, or not enrolled to this tenant.');
      }
    }
    const row = await this.repo.createRoot({
      name: input.name,
      provider: input.provider,
      gatewayDeviceId: input.gatewayDeviceId,
      rootPath: input.rootPath,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'storage_root',
      targetId: row.id,
      reason: `Storage root "${input.name}" (${input.provider}) configured.`,
      afterState: { provider: input.provider },
    });
    return toRootResponse(row);
  }

  async listRoots(includeTombstoned = false): Promise<StorageRoot[]> {
    const rows = await this.repo.listRoots(includeTombstoned);
    return rows.map(toRootResponse);
  }

  async getRoot(id: string): Promise<StorageRoot> {
    const row = await this.repo.findRoot(id);
    if (!row) throw new NotFoundException('Storage root not found.');
    return toRootResponse(row);
  }

  async updateRoot(id: string, input: UpdateStorageRootInput): Promise<StorageRoot> {
    const row = await this.repo.updateRoot(id, input);
    if (!row) throw new NotFoundException('Storage root not found or has been removed.');
    this.audit.annotate({
      targetType: 'storage_root',
      targetId: id,
      reason: `Storage root "${input.name}" updated.`,
      afterState: { name: input.name },
    });
    return toRootResponse(row);
  }

  async removeRoot(id: string, reason: string | null): Promise<StorageRoot> {
    const before = await this.repo.findRoot(id);
    if (!before || before.status !== 'active') {
      throw new NotFoundException('Storage root not found or already removed.');
    }
    if (await this.repo.hasActiveFoldersForRoot(id)) {
      throw new ConflictException('This storage root still has folders. Remove or reassign them first.');
    }
    const row = await this.repo.tombstoneRoot(id, reason, this.tenantContext.getOrThrow().userId);
    if (!row) throw new NotFoundException('Storage root not found or already removed.');
    this.audit.annotate({
      targetType: 'storage_root',
      targetId: id,
      reason: reason ?? 'Storage root removed.',
      beforeState: { status: 'active' },
      afterState: { status: 'tombstoned' },
    });
    return toRootResponse(row);
  }

  // --- folders ------------------------------------------------------------

  async createFolder(input: CreateStorageFolderInput): Promise<StorageFolder> {
    const ctx = this.tenantContext.getOrThrow();
    const root = await this.repo.findRoot(input.storageRootId);
    if (!root || root.status !== 'active') throw new NotFoundException('Storage root not found or has been removed.');
    if (input.parentFolderId) {
      const parent = await this.repo.findFolder(input.parentFolderId);
      if (!parent || parent.status !== 'active' || parent.storage_root_id !== input.storageRootId) {
        throw new NotFoundException('Parent folder not found in this storage root.');
      }
    }
    const row = await this.repo.createFolder({
      storageRootId: input.storageRootId,
      parentFolderId: input.parentFolderId,
      name: input.name,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'storage_folder',
      targetId: row.id,
      reason: `Folder "${input.name}" created under storage root "${root.name}".`,
      afterState: { storageRootId: input.storageRootId, parentFolderId: input.parentFolderId },
    });
    return toFolderResponse(row);
  }

  /** The full active folder set for a root (a client's chosen tree, flat —
   *  the caller assembles it via parentFolderId). Used for both "browse" and
   *  "select a folder for a mapping". */
  async listFolders(storageRootId: string): Promise<StorageFolder[]> {
    const root = await this.repo.findRoot(storageRootId);
    if (!root) throw new NotFoundException('Storage root not found.');
    const rows = await this.repo.listAllFoldersForRoot(storageRootId);
    return rows.map(toFolderResponse);
  }

  async removeFolder(id: string, reason: string | null): Promise<StorageFolder> {
    const before = await this.repo.findFolder(id);
    if (!before || before.status !== 'active') {
      throw new NotFoundException('Folder not found or already removed.');
    }
    if (await this.repo.hasActiveChildren(id)) {
      throw new ConflictException('This folder still has subfolders. Remove them first.');
    }
    if (await this.repo.hasActiveMappings(id)) {
      throw new ConflictException('This folder is still mapped to a DPDP module. Remove or repoint the mapping first.');
    }
    const row = await this.repo.tombstoneFolder(id, reason, this.tenantContext.getOrThrow().userId);
    if (!row) throw new NotFoundException('Folder not found or already removed.');
    this.audit.annotate({
      targetType: 'storage_folder',
      targetId: id,
      reason: reason ?? 'Folder removed.',
      beforeState: { status: 'active' },
      afterState: { status: 'tombstoned' },
    });
    return toFolderResponse(row);
  }

  // --- mappings ------------------------------------------------------------

  /**
   * The explicit mapping surface: point one module entity (e.g. a Consent
   * Template) at one folder. Idempotent by (moduleKey, entityId) — calling
   * this again with a different folderId is how a client CHANGES a mapping;
   * there is never more than one active folder per entity.
   */
  async setMapping(input: UpsertStorageMappingInput): Promise<StorageMapping> {
    const ctx = this.tenantContext.getOrThrow();
    const folder = await this.repo.findFolder(input.folderId);
    if (!folder || folder.status !== 'active') throw new NotFoundException('Folder not found or has been removed.');
    const before = await this.repo.findMapping(input.moduleKey, input.entityId);
    const row = await this.repo.upsertMapping({
      moduleKey: input.moduleKey,
      entityId: input.entityId,
      folderId: input.folderId,
      createdBy: ctx.userId,
    });
    this.audit.annotate({
      targetType: 'storage_mapping',
      targetId: row.id,
      reason: before
        ? `Storage mapping for ${input.moduleKey}/${input.entityId} changed to a new folder.`
        : `Storage mapping created: ${input.moduleKey}/${input.entityId} -> folder "${folder.name}".`,
      beforeState: before ? { folderId: before.folder_id, status: before.status } : undefined,
      afterState: { folderId: row.folder_id, status: row.status },
    });
    return toMappingResponse(row);
  }

  /** Resolve the active mapping for one entity, or null if none is configured. */
  async getMapping(moduleKey: StorageModuleKey, entityId: string): Promise<StorageMapping | null> {
    const row = await this.repo.findMapping(moduleKey, entityId);
    if (!row || row.status !== 'active') return null;
    return toMappingResponse(row);
  }

  async listMappings(moduleKey: StorageModuleKey): Promise<StorageMapping[]> {
    const rows = await this.repo.listMappings(moduleKey);
    return rows.map(toMappingResponse);
  }

  async deactivateMapping(id: string): Promise<StorageMapping> {
    const row = await this.repo.deactivateMapping(id);
    if (!row) throw new NotFoundException('Storage mapping not found or already inactive.');
    this.audit.annotate({
      targetType: 'storage_mapping',
      targetId: id,
      reason: `Storage mapping for ${row.module_key}/${row.entity_id} deactivated.`,
      beforeState: { status: 'active' },
      afterState: { status: 'inactive' },
    });
    return toMappingResponse(row);
  }
}

/** Maps a row to the API view. */
function toRootResponse(row: StorageRootRow): StorageRoot {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    gatewayDeviceId: row.gateway_device_id,
    rootPath: row.root_path,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toFolderResponse(row: StorageFolderRow): StorageFolder {
  return {
    id: row.id,
    storageRootId: row.storage_root_id,
    parentFolderId: row.parent_folder_id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMappingResponse(row: StorageMappingRow): StorageMapping {
  return {
    id: row.id,
    moduleKey: row.module_key,
    entityId: row.entity_id,
    folderId: row.folder_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
