import { realpathSync, statSync, mkdirSync, readdirSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { GatewayErrorCode, GatewayStoragePath } from '@dpdp/shared';

/**
 * Filesystem containment for the STORAGE plane — folders only, no file
 * content, no read capability at all. The browser NEVER sends an OS path; it
 * sends an array of plain folder NAME segments (GatewayStoragePath), derived
 * from the central storage_folders metadata it already has. That alone makes
 * '..'/absolute-path syntax unrepresentable as a valid segment; this module
 * is still the backstop that enforces it, exactly like connectors/path-
 * safety.ts does for the (separate) data-source read plane.
 */

export class StorageSecurityError extends Error {
  constructor(public readonly code: GatewayErrorCode) {
    super(code);
    this.name = 'StorageSecurityError';
  }
}

/** A folder NAME segment: no path separators, no NUL, not empty, not '.'/'..'.
 *  Rejects anything that could mean "go somewhere else" even textually. */
function assertSafeSegment(segment: string): void {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw new StorageSecurityError('PATH_NOT_ALLOWED');
  }
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    throw new StorageSecurityError('STORAGE_ROOT_NOT_AUTHORIZED');
  }
}

/**
 * Resolve `path` (an array of folder-name segments) to a real, contained
 * directory under `rootPath`. Every segment is validated BEFORE any fs call —
 * since a validated segment can never contain a separator or '..', `join()`
 * cannot escape the directory it is joined onto. Each level that DOES exist
 * is additionally realpath'd, so a symlink partway down that points outside
 * the root is caught, not followed.
 *
 * `mustExist`: when true (browse/verify), every segment must resolve to a
 * real, existing directory or this throws FILE_NOT_FOUND. When false
 * (createFolder's target), the FINAL segment may not yet exist — every
 * segment up to it still must.
 */
export function resolveContainedDir(rootPath: string, path: GatewayStoragePath, mustExist: boolean): string {
  const root = canonicalRoot(rootPath);
  let real = root;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    assertSafeSegment(segment);
    const candidate = join(real, segment);
    const isLast = i === path.length - 1;
    try {
      real = realpathSync(candidate);
    } catch {
      if (isLast && !mustExist) {
        real = candidate; // the not-yet-created target; containment still holds structurally
      } else {
        throw new StorageSecurityError('FILE_NOT_FOUND');
      }
    }
  }
  if (real !== root && !real.startsWith(root + sep)) {
    // Defence in depth — should be structurally unreachable given the segment
    // validation above, but never trust containment implicitly.
    throw new StorageSecurityError('PATH_NOT_ALLOWED');
  }
  return real;
}

/** List the DIRECT SUBDIRECTORY entries of a real, contained directory. Hidden
 *  (dotfile) entries are skipped, matching the filesystem connector's
 *  discovery precedent. Files are never listed — this endpoint is folders
 *  only. */
export function listSubdirectories(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new StorageSecurityError('FILE_NOT_FOUND');
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/** True iff `dir` exists and is a real directory. */
export function isRealDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Create `name` under the already-contained `parentDir`. Idempotent: if it
 *  already exists as a directory, this succeeds without complaint (matches
 *  the central mapping's upsert-not-duplicate discipline); if it exists as
 *  something else, this fails closed. */
export function createSubdirectory(parentDir: string, name: string): void {
  assertSafeSegment(name);
  const target = join(parentDir, name);
  try {
    mkdirSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' && isRealDirectory(target)) {
      return; // already exists as a directory — treat as success
    }
    throw new StorageSecurityError('PERMISSION_DENIED');
  }
}
