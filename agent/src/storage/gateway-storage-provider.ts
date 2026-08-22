import type {
  GatewayHealthResponse,
  GatewayStorageBrowseResponse,
  GatewayStorageCreateFolderResponse,
  GatewayStoragePath,
  GatewayStorageVerifyFolderResponse,
  StorageConnector,
} from '@dpdp/shared';
import { createSubdirectory, isRealDirectory, listSubdirectories, resolveContainedDir } from './path-safety';
import { AGENT_VERSION } from '../version';

/**
 * GatewayStorageProvider — the agent-side (Enterprise) implementation of
 * StorageConnector, rooted at ONE configured local filesystem path on the
 * Gateway machine. This is the "Local Storage Adapter" concept applied on the
 * Enterprise side of the architecture (the SaaS side's equivalent runs
 * entirely in the browser via the File System Access API — see
 * frontend/src/lib/local-storage-provider.ts — because there is no agent in
 * that path at all).
 *
 * Folders only. There is no read/write-file-content capability anywhere in
 * this class, and there must never be one — see the boundary guard spec.
 */
export class GatewayStorageProvider implements StorageConnector {
  constructor(private readonly rootPath: string) {}

  async browse(path: GatewayStoragePath): Promise<GatewayStorageBrowseResponse> {
    const dir = resolveContainedDir(this.rootPath, path, true);
    return { entries: listSubdirectories(dir).map((name) => ({ name })) };
  }

  async createFolder(path: GatewayStoragePath, name: string): Promise<GatewayStorageCreateFolderResponse> {
    const parentDir = resolveContainedDir(this.rootPath, path, true);
    createSubdirectory(parentDir, name);
    return { created: true };
  }

  async verifyFolder(path: GatewayStoragePath): Promise<GatewayStorageVerifyFolderResponse> {
    try {
      const dir = resolveContainedDir(this.rootPath, path, true);
      return { exists: isRealDirectory(dir) };
    } catch {
      return { exists: false };
    }
  }

  async healthCheck(): Promise<GatewayHealthResponse> {
    return { status: 'ok', agentVersion: AGENT_VERSION };
  }
}
