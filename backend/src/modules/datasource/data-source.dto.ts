import { BadRequestException } from '@nestjs/common';
import { DATA_SOURCE_KINDS, type DataSourceKind } from '@dpdp/shared';

/**
 * Request parsing for /data-sources — hand-written and total (same style as the
 * other module DTOs). Two Phase-1-specific safety rules beyond the usual
 * narrowing:
 *   - `data_access_mode` is NEVER accepted on create/update — it defaults closed
 *     and only the dedicated privileged mode endpoint can change it.
 *   - `connectionHint` is rejected if it looks like it contains a secret, so the
 *     non-secret-identifier rule is enforced at the edge, not just documented.
 */

export interface CreateDataSourceInput {
  name: string;
  sourceKind: DataSourceKind;
  connectionHint: string | null;
}

export interface UpdateDataSourceInput {
  name: string;
  connectionHint: string | null;
}

export function parseCreateDataSource(body: unknown): CreateDataSourceInput {
  const obj = asObject(body);
  const sourceKind = obj['sourceKind'];
  if (typeof sourceKind !== 'string' || !(DATA_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    throw new BadRequestException(`sourceKind must be one of: ${DATA_SOURCE_KINDS.join(', ')}.`);
  }
  // Defensive: a caller must not be able to smuggle a mode in at creation.
  if ('dataAccessMode' in obj || 'data_access_mode' in obj) {
    throw new BadRequestException(
      'A data source cannot be created with an access mode — it always starts metadata_only. ' +
        'Enable Gateway mode afterwards via the dedicated mode endpoint.',
    );
  }
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    sourceKind: sourceKind as DataSourceKind,
    connectionHint: parseConnectionHint(obj),
  };
}

export function parseUpdateDataSource(body: unknown): UpdateDataSourceInput {
  const obj = asObject(body);
  if ('dataAccessMode' in obj || 'data_access_mode' in obj) {
    throw new BadRequestException('Access mode is changed only via the dedicated mode endpoint.');
  }
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    connectionHint: parseConnectionHint(obj),
  };
}

/** The mode toggle body: `{ enabled: boolean }`. true = gateway_connected. */
export function parseModeToggle(body: unknown): { enabled: boolean } {
  const obj = asObject(body);
  if (typeof obj['enabled'] !== 'boolean') {
    throw new BadRequestException('enabled must be a boolean (true = enable Gateway mode).');
  }
  return { enabled: obj['enabled'] as boolean };
}

export function parseTombstoneReason(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) return { reason: null };
  const obj = asObject(body);
  return { reason: optionalStringOrNull(obj, 'reason', { max: 1000 }) };
}

/**
 * The raw-access AUDIT body. This endpoint records that a Mode-B raw view
 * happened, for accountability — it takes METADATA ONLY. The only field is a
 * row COUNT (a number, already considered safe under the audit policy — same
 * class as the relay byte-count in Tier 2). There is deliberately no field for
 * a file, rows, cell values, or a file name: none may ever reach the server.
 */
export function parseRawAccess(body: unknown): { rowCount: number } {
  const obj = asObject(body);
  const rowCount = obj['rowCount'];
  if (typeof rowCount !== 'number' || !Number.isInteger(rowCount) || rowCount < 0) {
    throw new BadRequestException('rowCount must be a non-negative integer.');
  }
  // Defensive: refuse anything that even looks like a smuggled value/file, so a
  // caller cannot sneak content into this metadata-only endpoint.
  for (const forbidden of ['rows', 'data', 'file', 'content', 'values', 'cells', 'fileName', 'payload']) {
    if (forbidden in obj) {
      throw new BadRequestException(
        `The raw-access endpoint accepts metadata only (rowCount). It must never receive "${forbidden}".`,
      );
    }
  }
  return { rowCount };
}

// --- helpers ---------------------------------------------------------------

/** A non-secret identifier only. Reject anything that looks like it smuggles a
 *  credential — this is the edge enforcement of "connection_hint is never a
 *  secret" (the migration documents the same rule). */
function parseConnectionHint(obj: Record<string, unknown>): string | null {
  const hint = optionalStringOrNull(obj, 'connectionHint', { max: 500 });
  if (hint === null) return null;
  const looksSecret =
    /password\s*[=:]/i.test(hint) ||
    /\bpwd\s*[=:]/i.test(hint) ||
    /\bapi[-_ ]?key\b/i.test(hint) ||
    /\bsecret\b/i.test(hint) ||
    /:\/\/[^/\s:]+:[^/\s@]+@/.test(hint); // scheme://user:pass@host
  if (looksSecret) {
    throw new BadRequestException(
      'connectionHint must be a non-secret identifier only — it appears to contain a credential. ' +
        'Never put passwords, API keys, or connection strings with secrets here.',
    );
  }
  return hint;
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
