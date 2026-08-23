/**
 * Pure Central DPDP Storage filesystem write operations for the delivery
 * agent — no Electron dependency (this process is not Electron; per the
 * task's explicit requirement, it must keep delivering while Electron is
 * completely closed). Deliberately mirrors desktop/src/storage-fs-ops.js and
 * desktop/src/storage-path-safety.js's algorithm and containment discipline
 * exactly, and backend/src/modules/storage-sync/server-storage-fs.ts's
 * write/segment conventions — a fourth runtime-specific copy of the same
 * small, stable write primitive, consistent with the established pattern in
 * this codebase (browser/Electron/backend each already have their own).
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A folder/file NAME segment is safe iff it is a non-empty string with no
 *  path separators, no '.'/'..', and no NUL. */
export function isSafeSegment(seg: string): boolean {
  return (
    typeof seg === 'string' &&
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0')
  );
}

/** True iff `p` is an absolute path (POSIX, Windows drive letter, or UNC). */
export function isAbsolutePath(p: string): boolean {
  return typeof p === 'string' && /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(p);
}

/** Resolve `segments` to an absolute path guaranteed to be contained within
 *  `root`. Throws PATH_NOT_ALLOWED on any unsafe segment or escape attempt. */
export function resolveContained(root: string, segments: readonly string[]): string {
  for (const seg of segments) {
    if (!isSafeSegment(seg)) throw new Error('PATH_NOT_ALLOWED');
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error('PATH_NOT_ALLOWED');
  }
  return target;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function browseDir(rootPath: string, segments: readonly string[]): Promise<string[]> {
  const dir = resolveContained(rootPath, segments);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

export async function createFolder(rootPath: string, segments: readonly string[], name: string): Promise<void> {
  if (!isSafeSegment(name)) throw new Error('PATH_NOT_ALLOWED');
  await ensureDir(resolveContained(rootPath, [...segments, name]));
}

/** Plain text — never JSON-wrapped (e.g. a text field's value.txt). */
export async function writeTextFile(rootPath: string, segments: readonly string[], filename: string, text: string): Promise<void> {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  const dir = resolveContained(rootPath, segments);
  await ensureDir(dir);
  await writeFile(path.join(dir, filename), text, 'utf8');
}

/** Pretty-printed JSON (profile.json / retention.json). */
export async function writeJsonFile(rootPath: string, segments: readonly string[], filename: string, data: unknown): Promise<void> {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  const dir = resolveContained(rootPath, segments);
  await ensureDir(dir);
  await writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
}

/** Raw bytes — original filename, original bytes, never re-encoded. */
export async function writeRawFile(rootPath: string, segments: readonly string[], filename: string, bytes: Buffer): Promise<void> {
  if (!isSafeSegment(filename)) throw new Error('PATH_NOT_ALLOWED');
  const dir = resolveContained(rootPath, segments);
  await ensureDir(dir);
  await writeFile(path.join(dir, filename), bytes);
}

/** Filesystem-safe label — mirrors central-storage.ts's sanitizeFolderLabel /
 *  server-storage-fs.ts's sanitizeLabel exactly (same collapsing rule), so a
 *  template name or field label produces the SAME folder name regardless of
 *  which runtime wrote it. */
export function sanitizeLabel(raw: string): string {
  const cleaned = raw.trim().replace(/[\\/:*?"<>|-]/g, '_').slice(0, 120);
  return cleaned || 'unnamed';
}
