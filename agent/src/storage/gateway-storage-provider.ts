import { closeSync, existsSync, openSync, writeSync, fsyncSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type {
  GatewayHealthResponse,
  GatewayStorageBrowseResponse,
  GatewayStorageCreateFolderResponse,
  GatewayStoragePath,
  GatewayStorageVerifyFolderResponse,
  GatewayStorageWriteResponse,
  StorageConnector,
} from '@dpdp/shared';
import { createSubdirectory, isRealDirectory, listSubdirectories, resolveContainedDir, resolveWriteDir, assertSafeFilename, StorageSecurityError } from './path-safety';
import { AGENT_VERSION } from '../version';

/** Matches connectors/filesystem-connector.ts's own cap for a single file —
 *  same order-of-magnitude content, same reasoning (bound memory use for a
 *  base64 decode + a synchronous write). */
const MAX_WRITE_BYTES = 15 * 1024 * 1024;

/**
 * GatewayStorageProvider — the agent-side (Enterprise) implementation of
 * StorageConnector, rooted at ONE configured local filesystem path on the
 * Gateway machine. This is the "Local Storage Adapter" concept applied on the
 * Enterprise side of the architecture (the SaaS side's equivalent runs
 * entirely in the browser via the File System Access API — see
 * frontend/src/lib/local-storage-provider.ts — because there is no agent in
 * that path at all).
 *
 * Folders, plus exactly ONE narrow write capability: writeFile, for
 * Enterprise consent-form field delivery. There is no read-file-content
 * capability anywhere in this class, and there must never be one — see the
 * boundary guard spec, which pins both facts.
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

  /**
   * Writes one file into an already-authorized, already-existing folder.
   * See StorageConnector.writeFile's doc for the full contract. Every check
   * below runs in order and fails closed; none is skippable by a caller.
   */
  async writeFile(path: GatewayStoragePath, filename: string, contentBase64: string, overwrite = false): Promise<GatewayStorageWriteResponse> {
    // 1. Containment: the folder must already exist inside this root (never
    //    auto-created; symlinks resolved before the check, same as browse).
    const dir = resolveWriteDir(this.rootPath, path);
    // 2. Filename: safe characters, no traversal, no dangerous extension.
    assertSafeFilename(filename);
    // 3. Size, checked on the ENCODED string first (cheap, bounds the decode
    //    itself) and again on the decoded bytes (base64 padding/estimation
    //    can both over- and under-count by a few bytes).
    if (contentBase64.length > Math.ceil((MAX_WRITE_BYTES * 4) / 3) + 8) {
      throw new StorageSecurityError('RATE_LIMITED');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentBase64, 'base64');
    } catch {
      throw new StorageSecurityError('INVALID_FILENAME');
    }
    if (bytes.length > MAX_WRITE_BYTES) throw new StorageSecurityError('RATE_LIMITED');

    const target = join(dir, filename);
    // 4. Collision: never silently replace a file this call didn't ask to.
    if (!overwrite && existsSync(target)) throw new StorageSecurityError('FILE_ALREADY_EXISTS');

    // 5. Atomic write: a temp file in the SAME directory, fsynced, then
    //    renamed over the target — a crash leaves the old file or the new
    //    one, never a partial write. Mirrors agent/src/atomic-write.ts's
    //    discipline (that helper takes a string; this one needs raw bytes,
    //    so the few lines are reproduced rather than stretching that helper's
    //    signature for one caller).
    const tmp = join(dir, `.dpdp-write-${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    try {
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return { written: true, bytesWritten: bytes.length };
  }

  async healthCheck(): Promise<GatewayHealthResponse> {
    return { status: 'ok', agentVersion: AGENT_VERSION };
  }
}
