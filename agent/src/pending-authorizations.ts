/**
 * A folder an administrator approved in Gateway Setup, waiting for the
 * SERVICE to register it with DPDP.
 *
 * Why a queue and not a direct call: only the service account can decrypt the
 * device credential (DPAPI, service-only identity), so the elevated helper
 * that runs the wizard's request cannot authenticate to DPDP. It therefore
 * records the administrator's decision — folder path, label, permission — and
 * the service, on its next start, exchanges it for the DPDP record ids
 * (POST /gateway/folders) and writes a complete source entry. Exactly the
 * hand-off shape pending-sources.json already uses, which is why this file
 * reuses atomic-write and the same read/validate/scrub discipline.
 *
 * NOTHING here is a secret: a local folder path, a display label and a
 * permission. It is still written into the ACL-protected state directory,
 * and scrubbed and removed once applied.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GatewayFolderAccess } from '@dpdp/shared';
import { scrubAndRemove, writeFileAtomic } from './atomic-write';

export const PENDING_AUTHORIZATIONS_FILE_NAME = 'pending-authorizations.json';
const FORMAT = 'dpdp-gateway-pending-authorizations';
const VERSION = 1;
/** A guard against a runaway wizard/helper, mirroring the backend's own cap. */
const MAX_PENDING = 50;

export interface PendingFolderAuthorization {
  /** The real local folder, as the administrator picked it. Never sent to DPDP. */
  root: string;
  /** The folder's display name, which IS sent to DPDP as its label. */
  label: string;
  access: GatewayFolderAccess;
}

export class PendingAuthorizationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingAuthorizationsError';
  }
}

function filePath(stateDir: string): string {
  return path.join(stateDir, PENDING_AUTHORIZATIONS_FILE_NAME);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Absolute Windows/UNC/POSIX path only — the same rule the wizard and the
 *  connector registry already apply, enforced again here. */
function assertUsable(entry: PendingFolderAuthorization): void {
  if (!/^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(entry.root)) {
    throw new PendingAuthorizationsError('A queued folder authorization has no absolute folder path.');
  }
  if (!entry.label.trim() || entry.label.includes('\0')) {
    throw new PendingAuthorizationsError('A queued folder authorization has no usable label.');
  }
  if (!['read', 'write', 'both'].includes(entry.access)) {
    throw new PendingAuthorizationsError('A queued folder authorization has an unknown permission.');
  }
}

export function readPendingAuthorizations(stateDir: string): PendingFolderAuthorization[] {
  let raw: string;
  try {
    raw = readFileSync(filePath(stateDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new PendingAuthorizationsError('The queued folder authorizations could not be read.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new PendingAuthorizationsError('The queued folder authorizations file is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.format !== FORMAT || parsed.version !== VERSION || !Array.isArray(parsed.folders)) {
    throw new PendingAuthorizationsError('The queued folder authorizations file is not a recognised format.');
  }
  return parsed.folders.map((entry) => {
    if (!isRecord(entry) || typeof entry.root !== 'string' || typeof entry.label !== 'string' || typeof entry.access !== 'string') {
      throw new PendingAuthorizationsError('A queued folder authorization is malformed.');
    }
    const out: PendingFolderAuthorization = { root: entry.root, label: entry.label, access: entry.access as GatewayFolderAccess };
    assertUsable(out);
    return out;
  });
}

/** Queues one folder (replacing any earlier entry for the SAME path, so a
 *  changed permission supersedes rather than duplicating). Returns how many
 *  are now queued. */
export function appendPendingAuthorization(stateDir: string, entry: PendingFolderAuthorization): number {
  assertUsable(entry);
  const existing = readPendingAuthorizations(stateDir).filter((e) => e.root.toLowerCase() !== entry.root.toLowerCase());
  const folders = [...existing, entry];
  if (folders.length > MAX_PENDING) {
    throw new PendingAuthorizationsError(`No more than ${MAX_PENDING} folder authorizations can be queued at once.`);
  }
  writeFileAtomic(filePath(stateDir), JSON.stringify({ format: FORMAT, version: VERSION, folders }, null, 2));
  return folders.length;
}

export function clearPendingAuthorizations(stateDir: string): void {
  try {
    scrubAndRemove(filePath(stateDir));
  } catch {
    // Already gone, or unreadable: nothing queued either way.
  }
}
