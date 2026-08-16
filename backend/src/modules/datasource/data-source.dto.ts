import { BadRequestException } from '@nestjs/common';
import { DATA_SOURCE_KINDS, type DataSourceKind, type GatewayAuditAction } from '@dpdp/shared';

/**
 * Phase 3G-2: the ONLY Gateway audit actions this central endpoint may record —
 * a strict allowlist, not the full GatewayAuditAction union (which also
 * includes session/source actions this endpoint has nothing to do with). Every
 * one of these is a POST-HOC, metadata-only fact: the actual Gateway operation
 * (customer resolve/write/create, column create) already completed entirely
 * within the client environment before the browser ever calls this.
 */
const GATEWAY_CUSTOMER_EVENT_ACTIONS = [
  'gateway.customer.resolved',
  'gateway.customer.updated',
  'gateway.customer.created',
  'gateway.customer.write_failed',
  'gateway.column.created',
] as const satisfies readonly GatewayAuditAction[];
export type GatewayCustomerEventAction = (typeof GATEWAY_CUSTOMER_EVENT_ACTIONS)[number];

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
 * Phase 3G-1: the identity-column config body: `{ identityColumn: string|null }`.
 * A column NAME only — validated as a plausible identifier, never treated as
 * (and never triggering) a lookup. null clears the configuration.
 */
export function parseIdentityColumn(body: unknown): { identityColumn: string | null } {
  const obj = asObject(body);
  const value = obj['identityColumn'];
  if (value === null) return { identityColumn: null };
  if (typeof value !== 'string') throw new BadRequestException('identityColumn must be a string or null.');
  return { identityColumn: parseColumnIdentifier(value, 'identityColumn') };
}

/**
 * Phase 3H-1: the customer-write config body:
 * `{ allowCustomerCreate: boolean, writableColumns: string[] }`. Column NAMES
 * only, never values — validated as identifiers, deduplicated, capped. This is
 * the CENTRAL configuration surface (identity_column's sibling); the Gateway
 * agent's own local config is separate and still independently enforced.
 */
export function parseCustomerWriteConfig(body: unknown): { allowCustomerCreate: boolean; writableColumns: string[] } {
  const obj = asObject(body);
  const allowCustomerCreate = obj['allowCustomerCreate'];
  if (typeof allowCustomerCreate !== 'boolean') {
    throw new BadRequestException('allowCustomerCreate must be a boolean.');
  }
  const raw = obj['writableColumns'];
  if (!Array.isArray(raw)) {
    throw new BadRequestException('writableColumns must be an array of column names.');
  }
  if (raw.length > 50) {
    throw new BadRequestException('writableColumns supports at most 50 columns.');
  }
  const seen = new Set<string>();
  const writableColumns = raw.map((c) => {
    if (typeof c !== 'string') throw new BadRequestException('writableColumns must contain only strings.');
    const id = parseColumnIdentifier(c, 'writableColumns[]');
    if (seen.has(id)) throw new BadRequestException(`writableColumns contains a duplicate: "${id}".`);
    seen.add(id);
    return id;
  });
  return { allowCustomerCreate, writableColumns };
}

/**
 * A strict, conservative column-identifier validator: letters/digits/underscore,
 * must start with a letter or underscore, 1-63 chars (Postgres identifier limit).
 * Used everywhere a client-supplied "this is a column name" string is accepted
 * (identity column, mapped column, new-column name) — never for a value, never
 * for SQL construction here (the Gateway re-validates and quote-escapes on the
 * connector side; this is the edge-level shape check).
 */
export function parseColumnIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(trimmed)) {
    throw new BadRequestException(
      `${field} must be a valid column identifier (letters, digits, underscore; starting with a letter or underscore).`,
    );
  }
  return trimmed;
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

/**
 * Phase 3G-2: record a Gateway customer/column event centrally — METADATA
 * ONLY. `action` must be one of the fixed allowlist above (never an arbitrary
 * string the caller invents); `rowCount` is an optional non-negative integer.
 * Explicitly refuses anything that looks like an identity value, a field
 * value, or a customer reference — this endpoint's entire job is to record
 * that something happened, never what the value was.
 */
export function parseGatewayEvent(body: unknown): { action: GatewayCustomerEventAction; rowCount?: number } {
  const obj = asObject(body);
  const action = obj['action'];
  if (typeof action !== 'string' || !(GATEWAY_CUSTOMER_EVENT_ACTIONS as readonly string[]).includes(action)) {
    throw new BadRequestException(`action must be one of: ${GATEWAY_CUSTOMER_EVENT_ACTIONS.join(', ')}.`);
  }
  for (const forbidden of ['identityValue', 'fields', 'customerRef', 'value', 'values', 'row', 'rows', 'columnValue']) {
    if (forbidden in obj) {
      throw new BadRequestException(
        `The Gateway event endpoint accepts metadata only (action, rowCount). It must never receive "${forbidden}".`,
      );
    }
  }
  let rowCount: number | undefined;
  if (obj['rowCount'] !== undefined) {
    const value = obj['rowCount'];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new BadRequestException('rowCount must be a non-negative integer.');
    }
    rowCount = value;
  }
  return { action: action as GatewayCustomerEventAction, rowCount };
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
