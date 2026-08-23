import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The BACKEND/WORKER-SIDE equivalent of frontend/src/lib/central-storage.ts's
 * write functions — real Node `fs/promises` I/O against a 'server'-provider
 * storage root's `root_path`, instead of the browser's File System Access
 * API. Same logical tree shape, same file-format discipline (text -> plain
 * .txt, pdf/excel -> original bytes/filename), deliberately duplicated as a
 * small, self-contained set of pure functions rather than shared code with
 * the frontend (different runtimes: Node fs vs a FileSystemDirectoryHandle).
 * Keep the folder-name constants below in sync with central-storage.ts's.
 *
 * SAFETY: every path this module writes to is built with `path.join` from a
 * caller-supplied `rootPath` plus SANITIZED path segments only (see
 * sanitizeLabel) — never a raw client-controlled string — so a hostile
 * label/filename cannot escape the configured root.
 */

export const CENTRAL_STORAGE_ROOT_NAME = 'DPDP Central Storage';
export const CUSTOMERS_FOLDER_NAME = 'Customers';
export const CONSENT_REGISTER_FOLDER_NAME = 'Consent Register';
export const CUSTOMER_INFORMATION_FOLDER_NAME = 'Customer Information';
export const TOP_LEVEL_MODULE_FOLDERS: Record<string, string> = {
  data_inventory: 'Data Inventory',
  grievance: 'Grievances',
  dprequest: 'DSR',
  breach: 'Breach',
};
export const SEED_FOLDERS = [CUSTOMERS_FOLDER_NAME, ...Object.values(TOP_LEVEL_MODULE_FOLDERS)];

/** Filesystem-safe label — same discipline as central-storage.ts's
 *  sanitizeFolderLabel: collapses path separators/control characters so a
 *  client-supplied raw name can never escape the intended folder. */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|-]/g, '_')
    .slice(0, 120);
  return cleaned || 'unnamed';
}

/** Joins sanitized segments onto rootPath — the one place a real absolute
 *  path gets constructed, so containment is enforced in exactly one spot. */
function resolveUnder(rootPath: string, segments: string[]): string {
  const resolvedRoot = path.resolve(rootPath);
  const target = path.resolve(resolvedRoot, ...segments.map(sanitizeLabel));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Refusing to write outside the configured storage root.');
  }
  return target;
}

async function withRetries<T>(attempt: () => Promise<T>, delaysMs: number[]): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= delaysMs.length; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      const delay = delaysMs[i];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/** Matches an absolute POSIX path (/...), an absolute Windows path
 *  (D:\... or D:/...), or a UNC path (\\server\share...) — never a bare
 *  relative name. */
const ABSOLUTE_PATH_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\)/;

/**
 * A REPRODUCED, real failure this specifically guards against: a 'server'
 * root_path saved as a bare relative name (e.g. "DPDP-Enterprise-Test" — a
 * folder picker's `handle.name` on its own, with no path in front of it).
 * `path.resolve()` happily resolves a relative path against the CURRENT
 * PROCESS'S working directory (`/repo/backend` in this image) rather than
 * failing — so every fs call below would "succeed" against a directory
 * inside the container's own ephemeral layer, nowhere near the bind-mounted
 * Enterprise volume, while reporting available/synced the whole time. See
 * storage.dto.ts's parseCreateStorageRoot / storage.service.ts's updateRoot,
 * which reject this at the moment a root is configured — this check is the
 * SAME rule enforced again here, as the one choke point every write and
 * every verify (old rows included, saved before that validation shipped)
 * passes through. */
export function isAbsoluteEnterprisePath(rootPath: string): boolean {
  return ABSOLUTE_PATH_RE.test(rootPath);
}

/** Confirms the configured path is actually reachable AND writable by THIS
 *  process — a probe file created and immediately removed, never left
 *  behind. Retries a few times (transient unavailability: a network share
 *  still mounting, a permission race) before giving up. Never throws — a
 *  caller checks the boolean, exactly like the browser's queryPermission. */
export async function verifyServerPathWritable(rootPath: string): Promise<boolean> {
  if (!isAbsoluteEnterprisePath(rootPath)) return false;
  const probe = path.join(path.resolve(rootPath), `.dpdp-write-probe-${randomUUID()}`);
  try {
    return await withRetries(async () => {
      await fs.mkdir(path.resolve(rootPath), { recursive: true });
      await fs.writeFile(probe, '');
      await fs.unlink(probe);
      return true;
    }, [200, 800, 2000]);
  } catch {
    return false;
  }
}

export async function ensureDir(rootPath: string, segments: string[]): Promise<void> {
  await fs.mkdir(resolveUnder(rootPath, segments), { recursive: true });
}

export async function writeTextFile(rootPath: string, segments: string[], filename: string, content: string): Promise<void> {
  const dir = resolveUnder(rootPath, segments);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, sanitizeLabel(filename) || 'value.txt'), content, 'utf8');
}

export async function writeJsonFile(rootPath: string, segments: string[], filename: string, value: unknown): Promise<void> {
  const dir = resolveUnder(rootPath, segments);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(value, null, 2), 'utf8');
}

/** Original bytes, original filename — never re-encoded, never wrapped. */
export async function writeRawFile(rootPath: string, segments: string[], filename: string, bytes: Buffer): Promise<void> {
  const dir = resolveUnder(rootPath, segments);
  await fs.mkdir(dir, { recursive: true });
  const safeName = filename.replace(/[\\/]/g, '_').slice(0, 200) || 'value';
  await fs.writeFile(path.join(dir, safeName), bytes);
}

export async function listChildDirNames(rootPath: string, segments: string[]): Promise<string[]> {
  try {
    const dir = resolveUnder(rootPath, segments);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Idempotent, additive-only — creates any of the five top-level real
 *  directories that don't already exist; never deletes/renames anything. */
export async function ensureTopLevelFoldersOnDisk(rootPath: string): Promise<void> {
  for (const name of SEED_FOLDERS) {
    await ensureDir(rootPath, [name]);
  }
}

export function fieldValueSegments(customerFolderName: string, templateName: string, fieldLabel: string): string[] {
  return [CUSTOMERS_FOLDER_NAME, customerFolderName, CONSENT_REGISTER_FOLDER_NAME, templateName, fieldLabel];
}
