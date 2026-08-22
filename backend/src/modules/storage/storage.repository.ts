import { Injectable } from '@nestjs/common';
import type { StorageMappingStatus, StorageModuleKey, StorageProvider, StorageStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * The Storage & Folder Mapping store. Reads/writes ROOT/FOLDER/MAPPING
 * METADATA ONLY — never a file, a document, or a customer value (read the
 * column list as the invariant, same discipline as DataSourceRepository /
 * GatewayRepository). There is no `readFile`, `writeFile`, or `content`
 * anywhere in this module, and there must never be one.
 */

export interface StorageRootRow {
  id: string;
  tenant_id: string;
  name: string;
  provider: StorageProvider;
  gateway_device_id: string | null;
  root_path: string | null;
  status: StorageStatus;
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StorageFolderRow {
  id: string;
  tenant_id: string;
  storage_root_id: string;
  parent_folder_id: string | null;
  name: string;
  status: StorageStatus;
  tombstone_reason: string | null;
  tombstoned_at: Date | null;
  tombstoned_by: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StorageMappingRow {
  id: string;
  tenant_id: string;
  module_key: StorageModuleKey;
  entity_id: string;
  folder_id: string;
  status: StorageMappingStatus;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const ROOT_COLS =
  'id, tenant_id, name, provider, gateway_device_id, root_path, status, ' +
  'tombstone_reason, tombstoned_at, tombstoned_by, created_by, created_at, updated_at';
const FOLDER_COLS =
  'id, tenant_id, storage_root_id, parent_folder_id, name, status, ' +
  'tombstone_reason, tombstoned_at, tombstoned_by, created_by, created_at, updated_at';
const MAPPING_COLS = 'id, tenant_id, module_key, entity_id, folder_id, status, created_by, created_at, updated_at';

@Injectable()
export class StorageRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- roots ------------------------------------------------------------

  createRoot(input: {
    name: string;
    provider: StorageProvider;
    gatewayDeviceId: string | null;
    rootPath: string | null;
    createdBy: string | null;
  }): Promise<StorageRootRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageRootRow>(
        `INSERT INTO storage_roots (name, provider, gateway_device_id, root_path, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ROOT_COLS}`,
        [input.name, input.provider, input.gatewayDeviceId, input.rootPath, input.createdBy],
      );
      return rows[0]!;
    });
  }

  listRoots(includeTombstoned: boolean): Promise<StorageRootRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageRootRow>(
        `SELECT ${ROOT_COLS} FROM storage_roots
          ${includeTombstoned ? '' : "WHERE status = 'active'"}
          ORDER BY created_at DESC`,
      );
      return rows;
    });
  }

  findRoot(id: string): Promise<StorageRootRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageRootRow>(`SELECT ${ROOT_COLS} FROM storage_roots WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
  }

  updateRoot(id: string, input: { name: string; rootPath: string | null }): Promise<StorageRootRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageRootRow>(
        `UPDATE storage_roots
            SET name = $2, root_path = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${ROOT_COLS}`,
        [id, input.name, input.rootPath],
      );
      return rows[0] ?? null;
    });
  }

  tombstoneRoot(id: string, reason: string | null, actorId: string | null): Promise<StorageRootRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageRootRow>(
        `UPDATE storage_roots
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(), tombstoned_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${ROOT_COLS}`,
        [id, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /** True if any active folder still exists under this root — used to fail
   *  closed on removing a root that is still in use. */
  hasActiveFoldersForRoot(rootId: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM storage_folders WHERE storage_root_id = $1 AND status = 'active') AS exists`,
        [rootId],
      );
      return rows[0]!.exists;
    });
  }

  // --- folders ------------------------------------------------------------

  createFolder(input: {
    storageRootId: string;
    parentFolderId: string | null;
    name: string;
    createdBy: string | null;
  }): Promise<StorageFolderRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageFolderRow>(
        `INSERT INTO storage_folders (storage_root_id, parent_folder_id, name, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING ${FOLDER_COLS}`,
        [input.storageRootId, input.parentFolderId, input.name, input.createdBy],
      );
      return rows[0]!;
    });
  }

  /** Every active folder under a root, for building the full tree view. */
  listAllFoldersForRoot(storageRootId: string): Promise<StorageFolderRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageFolderRow>(
        `SELECT ${FOLDER_COLS} FROM storage_folders
          WHERE storage_root_id = $1 AND status = 'active'
          ORDER BY name`,
        [storageRootId],
      );
      return rows;
    });
  }

  findFolder(id: string): Promise<StorageFolderRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageFolderRow>(`SELECT ${FOLDER_COLS} FROM storage_folders WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
  }

  tombstoneFolder(id: string, reason: string | null, actorId: string | null): Promise<StorageFolderRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageFolderRow>(
        `UPDATE storage_folders
            SET status = 'tombstoned', tombstone_reason = $2, tombstoned_at = now(), tombstoned_by = $3
          WHERE id = $1 AND status = 'active'
          RETURNING ${FOLDER_COLS}`,
        [id, reason, actorId],
      );
      return rows[0] ?? null;
    });
  }

  /** True if any active folder still references this one as its parent —
   *  used to fail closed on removing a non-empty folder. */
  hasActiveChildren(id: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM storage_folders WHERE parent_folder_id = $1 AND status = 'active') AS exists`,
        [id],
      );
      return rows[0]!.exists;
    });
  }

  /** True if any active mapping still points at this folder — used to fail
   *  closed on removing a folder that is in use. */
  hasActiveMappings(folderId: string): Promise<boolean> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM storage_mappings WHERE folder_id = $1 AND status = 'active') AS exists`,
        [folderId],
      );
      return rows[0]!.exists;
    });
  }

  // --- mappings ------------------------------------------------------------

  findMapping(moduleKey: StorageModuleKey, entityId: string): Promise<StorageMappingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageMappingRow>(
        `SELECT ${MAPPING_COLS} FROM storage_mappings WHERE module_key = $1 AND entity_id = $2`,
        [moduleKey, entityId],
      );
      return rows[0] ?? null;
    });
  }

  listMappings(moduleKey: StorageModuleKey): Promise<StorageMappingRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageMappingRow>(
        `SELECT ${MAPPING_COLS} FROM storage_mappings WHERE module_key = $1 AND status = 'active' ORDER BY created_at DESC`,
        [moduleKey],
      );
      return rows;
    });
  }

  /** Create the mapping, or — if one already exists for this (module, entity)
   *  — point it at the new folder and reactivate it. One row per entity,
   *  always (the unique constraint is the backstop). */
  upsertMapping(input: {
    moduleKey: StorageModuleKey;
    entityId: string;
    folderId: string;
    createdBy: string | null;
  }): Promise<StorageMappingRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageMappingRow>(
        `INSERT INTO storage_mappings (module_key, entity_id, folder_id, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT storage_mappings_module_entity_uq
         DO UPDATE SET folder_id = EXCLUDED.folder_id, status = 'active'
         RETURNING ${MAPPING_COLS}`,
        [input.moduleKey, input.entityId, input.folderId, input.createdBy],
      );
      return rows[0]!;
    });
  }

  deactivateMapping(id: string): Promise<StorageMappingRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<StorageMappingRow>(
        `UPDATE storage_mappings SET status = 'inactive' WHERE id = $1 AND status = 'active' RETURNING ${MAPPING_COLS}`,
        [id],
      );
      return rows[0] ?? null;
    });
  }
}
