import { BadRequestException } from '@nestjs/common';
import {
  type ConsentSource,
  type ConsentStatus,
} from '@dpdp/shared';

/**
 * Request parsing for the consent routes — hand-written and total, narrowing
 * every field from `unknown` before it reaches a service (same reasoning as the
 * identity DTOs). Consent ingest is a public-facing write path (FR-CON-03), so
 * the edge is exactly where the narrowing has to be airtight.
 */

const CONSENT_STATUSES: readonly ConsentStatus[] = ['GRANTED', 'WITHDRAWN', 'EXPIRED'];
const CONSENT_SOURCES: readonly ConsentSource[] = ['web_sdk', 'mobile_sdk', 'api', 'portal', 'import'];

export interface CreatePurposeBody {
  name: string;
}

export function parseCreatePurpose(body: unknown): CreatePurposeBody {
  return { name: requireString(asObject(body), 'name', { min: 2, max: 200 }) };
}

export interface RecordConsentBody {
  /** The client's internal customer id — pseudonymised at ingest, never stored (I2). */
  customerId: string;
  purposeId: string;
  status: ConsentStatus;
  noticeVersionId: string;
  occurredAt: string;
  source: ConsentSource;
  /** Optional: the SDK supplies one; if absent we derive a deterministic key. */
  idempotencyKey?: string;
}

export function parseRecordConsent(body: unknown): RecordConsentBody {
  const input = asObject(body);
  const status = requireString(input, 'status', { min: 1, max: 16 });
  if (!(CONSENT_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException(`status must be one of: ${CONSENT_STATUSES.join(', ')}`);
  }
  const source = optionalString(input, 'source') ?? 'api';
  if (!(CONSENT_SOURCES as readonly string[]).includes(source)) {
    throw new BadRequestException(`source must be one of: ${CONSENT_SOURCES.join(', ')}`);
  }
  return {
    customerId: requireString(input, 'customerId', { min: 1, max: 256 }),
    purposeId: requireUuid(input, 'purposeId'),
    status: status as ConsentStatus,
    noticeVersionId: requireString(input, 'noticeVersionId', { min: 1, max: 200 }),
    occurredAt: optionalIsoTimestamp(input, 'occurredAt') ?? new Date().toISOString(),
    source: source as ConsentSource,
    idempotencyKey: optionalString(input, 'idempotencyKey'),
  };
}

// --- primitives -------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requireString(
  input: Record<string, unknown>,
  field: string,
  bounds: { min: number; max: number },
): string {
  const value = input[field];
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < bounds.min || trimmed.length > bounds.max) {
    throw new BadRequestException(`${field} must be between ${bounds.min} and ${bounds.max} characters.`);
  }
  return trimmed;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field}, if present, must be a non-empty string.`);
  }
  return value.trim();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field, { min: 36, max: 36 });
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function optionalIsoTimestamp(input: Record<string, unknown>, field: string): string | undefined {
  const value = optionalString(input, field);
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new BadRequestException(`${field} must be an ISO-8601 timestamp.`);
  }
  return new Date(ms).toISOString();
}
