/**
 * Enterprise (Gateway) destinations for a consent-form field's Additional
 * Storage — the SAME per-field mapping (storage_mappings, moduleKey
 * 'consent_form_field') the browser-local Additional Storage already uses,
 * pointed at a folder under a Gateway-provider storage root instead of a
 * local one. Nothing here writes a file: the Gateway delivers the copy, and
 * only into a folder its own administrator authorized for writing.
 * Pure helpers; no I/O.
 */
import type { StorageFolder, StorageRoot } from '@dpdp/shared';

/** Active Gateway-provider storage roots: the only roots a field's
 *  Enterprise copy can target. */
export function gatewayStorageRoots(roots: readonly StorageRoot[]): StorageRoot[] {
  return roots.filter((r) => r.provider === 'gateway' && r.status === 'active');
}

/** A folder NAME the Gateway will accept as one path segment (it re-checks
 *  this itself — this only spares the administrator a failed delivery).
 *  Mirrors the agent's storage path-safety rules plus Windows-reserved
 *  characters. */
export function folderNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Enter a folder name.';
  if (n.length > 200) return 'The folder name is too long.';
  if (n === '.' || n === '..') return 'That folder name is not allowed.';
  if (/[\\/:*?"<>|\0]/.test(n)) return 'A folder name cannot contain \\ / : * ? " < > |';
  return null;
}

/** "Finance share / Consent copies" — root name, then the folder chain.
 *  (Resolving a browsed path to a storage_folders record is done by the
 *  destination picker, which walks and creates the whole parent chain.) */
export function describeDestination(root: Pick<StorageRoot, 'name'>, folder: Pick<StorageFolder, 'name'>): string {
  return `${root.name} / ${folder.name}`;
}
