import { BadRequestException } from '@nestjs/common';
import { STORAGE_MODULE_KEYS, STORAGE_PROVIDERS, type StorageModuleKey, type StorageProvider } from '@dpdp/shared';
import { isAbsoluteEnterprisePath } from '../storage-sync/server-storage-fs';

/**
 * Request parsing for /storage — hand-written and total (same style as the
 * other module DTOs). Storage-specific safety rules beyond the usual
 * narrowing:
 *   - `rootPath` is rejected if it looks like it contains a secret, same
 *     discipline as data-source.dto's `parseConnectionHint`.
 *   - `provider`/`gatewayDeviceId` pairing is enforced here too (defense in
 *     depth ahead of the DB CHECK constraint) so the caller gets a clear
 *     400 instead of a raw constraint-violation error.
 */

export interface CreateStorageRootInput {
  name: string;
  provider: StorageProvider;
  gatewayDeviceId: string | null;
  rootPath: string | null;
}

export interface UpdateStorageRootInput {
  name: string;
  rootPath: string | null;
}

export function parseCreateStorageRoot(body: unknown): CreateStorageRootInput {
  const obj = asObject(body);
  const provider = obj['provider'] ?? 'local';
  if (typeof provider !== 'string' || !(STORAGE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new BadRequestException(`provider must be one of: ${STORAGE_PROVIDERS.join(', ')}.`);
  }
  const gatewayDeviceId = optionalStringOrNull(obj, 'gatewayDeviceId', {});
  if (provider === 'gateway' && !gatewayDeviceId) {
    throw new BadRequestException('gatewayDeviceId is required when provider is "gateway".');
  }
  if ((provider === 'local' || provider === 'server') && gatewayDeviceId) {
    throw new BadRequestException(`gatewayDeviceId must not be set when provider is "${provider}".`);
  }
  const rootPath = parseRootPath(obj);
  if (provider === 'server') {
    if (!rootPath) {
      throw new BadRequestException(
        'rootPath is required when provider is "server" — the filesystem path the backend/worker process itself will read and write.',
      );
    }
    assertAbsoluteEnterprisePath(rootPath);
  }
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    provider: provider as StorageProvider,
    gatewayDeviceId,
    rootPath,
  };
}

export function parseUpdateStorageRoot(body: unknown): UpdateStorageRootInput {
  const obj = asObject(body);
  if ('provider' in obj || 'gatewayDeviceId' in obj) {
    throw new BadRequestException('provider and gatewayDeviceId cannot be changed after creation — create a new storage root instead.');
  }
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    rootPath: parseRootPath(obj),
  };
}

export interface CreateStorageFolderInput {
  storageRootId: string;
  parentFolderId: string | null;
  name: string;
}

export function parseCreateStorageFolder(body: unknown): CreateStorageFolderInput {
  const obj = asObject(body);
  return {
    storageRootId: requireString(obj, 'storageRootId', { min: 1 }),
    parentFolderId: optionalStringOrNull(obj, 'parentFolderId', {}),
    name: requireString(obj, 'name', { min: 1, max: 200 }),
  };
}

export interface UpsertStorageMappingInput {
  moduleKey: StorageModuleKey;
  entityId: string;
  folderId: string;
}

/**
 * The explicit mapping body: `{ moduleKey, entityId, folderId }`. There is no
 * "auto-detect" path anywhere in this module — every mapping is the direct
 * result of a client picking a folder for a specific entity, never inferred
 * from a name, a column, or any heuristic (see the master doc's "no automatic
 * guessing" requirement).
 */
export function parseUpsertStorageMapping(body: unknown): UpsertStorageMappingInput {
  const obj = asObject(body);
  const moduleKey = obj['moduleKey'];
  if (typeof moduleKey !== 'string' || !(STORAGE_MODULE_KEYS as readonly string[]).includes(moduleKey)) {
    throw new BadRequestException(`moduleKey must be one of: ${STORAGE_MODULE_KEYS.join(', ')}.`);
  }
  return {
    moduleKey: moduleKey as StorageModuleKey,
    entityId: requireUuid(obj, 'entityId'),
    folderId: requireString(obj, 'folderId', { min: 1 }),
  };
}

/** `entity_id` is a `uuid` column for every moduleKey today (a consent form's
 *  own id, a field's own id, or — as of the data-principal registry fix — a
 *  customer's internal id, never the 64-character subject_ref hash). Reject
 *  a malformed value here with a clean 400, so it can never reach Postgres
 *  as a raw "invalid input syntax for type uuid" 500. */
export function parseEntityIdQueryParam(value: string | undefined): string {
  if (!value) throw new BadRequestException('entityId query parameter is required.');
  if (!UUID_RE.test(value)) throw new BadRequestException('entityId must be a UUID.');
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(obj: Record<string, unknown>, field: string): string {
  const value = requireString(obj, field, { min: 1 });
  if (!UUID_RE.test(value)) throw new BadRequestException(`${field} must be a UUID.`);
  return value;
}

export interface StorageRedeemPairingInput {
  nonce: string;
  storageRootId: string;
}

/** The device-facing storage-pairing redeem body: `{ nonce, storageRootId }`.
 *  Mirrors the Gateway control plane's parseRedeemPairing (never a secret, no
 *  filesystem path, no customer value). */
export function parseStorageRedeemPairing(body: unknown): StorageRedeemPairingInput {
  const obj = asObject(body);
  return {
    nonce: requireString(obj, 'nonce', { min: 16, max: 512 }),
    storageRootId: requireString(obj, 'storageRootId', { min: 1 }),
  };
}

export function parseTombstoneReason(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) return { reason: null };
  const obj = asObject(body);
  return { reason: optionalStringOrNull(obj, 'reason', { max: 1000 }) };
}

// --- helpers ---------------------------------------------------------------

/**
 * Rejects a 'server' rootPath that isn't absolute — see
 * server-storage-fs.ts's isAbsoluteEnterprisePath for the exact, reproduced
 * failure this closes (a bare folder name silently resolving inside the
 * backend/worker's OWN working directory instead of the configured volume).
 * This is the HTTP-layer wrapper (throws a clean 400); the underlying check
 * is also enforced again at every actual write (verifyServerPathWritable),
 * so a pre-existing bad row from before this validation shipped is still safe. */
export function assertAbsoluteEnterprisePath(rootPath: string): void {
  if (!isAbsoluteEnterprisePath(rootPath)) {
    throw new BadRequestException(
      `rootPath must be an absolute filesystem path as seen by the backend/worker process (e.g. "/enterprise-storage" in Docker, or "D:\\CompanyData\\DPDP" on a native Windows install) — ` +
        `"${rootPath}" looks like a bare folder name, not a full path. A picked folder's name alone is never enough: type or confirm the complete path here.`,
    );
  }
}

/** A non-secret path/reference only — same discipline as data-source.dto's
 *  `parseConnectionHint`. Reject anything that looks like it smuggles a
 *  credential. */
function parseRootPath(obj: Record<string, unknown>): string | null {
  const path = optionalStringOrNull(obj, 'rootPath', { max: 1000 });
  if (path === null) return null;
  const looksSecret =
    /password\s*[=:]/i.test(path) ||
    /\bpwd\s*[=:]/i.test(path) ||
    /\bapi[-_ ]?key\b/i.test(path) ||
    /\bsecret\b/i.test(path) ||
    /:\/\/[^/\s:]+:[^/\s@]+@/.test(path); // scheme://user:pass@host
  if (looksSecret) {
    throw new BadRequestException(
      'rootPath must be a non-secret path/reference only — it appears to contain a credential. ' +
        'Never put passwords, API keys, or connection strings with secrets here.',
    );
  }
  return path;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, opts: { min?: number; max?: number } = {}): string {
  const value = obj[field];
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required and must be a string.`);
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) throw new BadRequestException(`${field} must be at least ${opts.min} character(s).`);
  if (opts.max !== undefined && trimmed.length > opts.max) throw new BadRequestException(`${field} must be at most ${opts.max} character(s).`);
  return trimmed;
}

function optionalStringOrNull(obj: Record<string, unknown>, field: string, opts: { max?: number } = {}): string | null {
  const value = obj[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string.`);
  const trimmed = value.trim();
  if (opts.max !== undefined && trimmed.length > opts.max) throw new BadRequestException(`${field} must be at most ${opts.max} character(s).`);
  return trimmed || null;
}
