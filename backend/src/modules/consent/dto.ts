import { BadRequestException } from '@nestjs/common';
import {
  type ConsentSource,
  type ConsentStatus,
} from '@dpdp/shared';
import type { ConsentPurposeFields } from './consent.repository';

/**
 * Request parsing for the consent routes — hand-written and total, narrowing
 * every field from `unknown` before it reaches a service (same reasoning as the
 * identity DTOs). Consent ingest is a public-facing write path (FR-CON-03), so
 * the edge is exactly where the narrowing has to be airtight.
 */

const CONSENT_STATUSES: readonly ConsentStatus[] = ['GRANTED', 'WITHDRAWN', 'EXPIRED'];
const CONSENT_SOURCES: readonly ConsentSource[] = ['web_sdk', 'mobile_sdk', 'api', 'portal', 'import'];

/** FR-CON-01: create or edit a purpose's current version. Same fields either way. */
export function parsePurposeInput(body: unknown): ConsentPurposeFields {
  const obj = asObject(body);
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    description: optionalStringOrNull(obj, 'description', { max: 2000 }),
  };
}

export function parsePurposeTombstoneInput(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  const obj = asObject(body);
  return { reason: optionalStringOrNull(obj, 'reason', { max: 1000 }) };
}

/**
 * The FR-CON-03 ingest payload, narrowed. Deliberately nothing more than the
 * master doc's envelope: org id (implicit — it is the JWT's tenant, never a
 * caller-supplied field, so a caller cannot write into another tenant's
 * stream), subject reference, purpose id, status, timestamp, notice version id,
 * evidence hash, source, idempotency key.
 */
export interface RecordConsentBody {
  /** The client's internal customer id — pseudonymised at ingest, never stored (I2). */
  customerId: string;
  purposeId: string;
  status: ConsentStatus;
  /** A real consent_notice_versions id (FR-CON-02) — no longer free text. */
  noticeVersionId: string;
  occurredAt: string;
  source: ConsentSource;
  /** Optional: the client's own seal over evidence they hold. Derived if absent. */
  evidenceHash?: string;
  /** Optional: the SDK supplies one; if absent we derive a deterministic key. */
  idempotencyKey?: string;
}

/** How far ahead of server time a client's `occurredAt` may legitimately be.
 *  Mirrors the same allowance in app.consent_append — the DB is authoritative;
 *  this rejects at the edge so the round trip is not spent. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

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

  const occurredAt = optionalIsoTimestamp(input, 'occurredAt') ?? new Date().toISOString();
  if (Date.parse(occurredAt) > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new BadRequestException(
      'occurredAt is more than 5 minutes in the future. Consent cannot be given before it happens.',
    );
  }

  return {
    customerId: requireString(input, 'customerId', { min: 1, max: 256 }),
    purposeId: requireUuid(input, 'purposeId'),
    status: status as ConsentStatus,
    noticeVersionId: requireUuid(input, 'noticeVersionId'),
    occurredAt,
    source: source as ConsentSource,
    evidenceHash: optionalString(input, 'evidenceHash'),
    idempotencyKey: optionalString(input, 'idempotencyKey'),
  };
}

export function parseDeriveSubjectRef(body: unknown): { customerId: string } {
  return { customerId: requireString(asObject(body), 'customerId', { min: 1, max: 256 }) };
}

/** FR-CON-06: one-click withdrawal's optional operator-supplied reason — an
 *  empty body is entirely valid (a click needs no essay to justify it). */
export function parseWithdrawInput(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  const obj = asObject(body);
  return { reason: optionalStringOrNull(obj, 'reason', { max: 1000 }) };
}

export interface SubjectHistoryQuery {
  /** Valid-time cutoff: "what was true AT this moment". */
  asOf: string;
  /** Transaction-time cutoff: "…using only what we knew BY this moment". */
  knownAs: string;
}

/**
 * The two clocks of a bitemporal query (FR-CON-05), parsed from query strings.
 *
 * Both default to now, which gives the ordinary "current status" answer. They
 * are separate parameters because they answer genuinely different questions:
 *
 *   asOf=2026-03-03                     — what do we NOW believe was true then
 *                                         (includes a correction filed later)
 *   asOf=2026-03-03&knownAs=2026-03-03  — what we believed on the day itself
 *
 * The second is the one a regulator asks. Collapsing them into one parameter
 * would silently answer whichever question the implementer had in mind.
 */
export function parseSubjectHistoryQuery(query: {
  asOf?: string;
  knownAs?: string;
}): SubjectHistoryQuery {
  const now = new Date().toISOString();
  return {
    asOf: parseTimestampParam(query.asOf, 'asOf') ?? now,
    knownAs: parseTimestampParam(query.knownAs, 'knownAs') ?? now,
  };
}

function parseTimestampParam(value: string | undefined, field: string): string | null {
  if (value === undefined || value === null || value.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new BadRequestException(`${field} must be an ISO-8601 timestamp or date.`);
  }
  return new Date(ms).toISOString();
}

/** Shared by every route that takes a subject reference as a path param — the
 *  one validity check "did the caller actually derive this via POST
 *  /consent/subject-ref" can perform. */
export function parseSubjectRefParam(subjectRef: string): string {
  const ref = (subjectRef ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ref)) {
    throw new BadRequestException(
      'subjectRef must be a 64-character hex subject reference (derive one via POST /consent/subject-ref).',
    );
  }
  return ref;
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

/** Same as `optionalString`, but `null` (not `undefined`) for "absent" — the
 *  shape purpose/notice fields use (matches inventory's DTO convention). */
function optionalStringOrNull(
  input: Record<string, unknown>,
  field: string,
  bounds: { max: number },
): string | null {
  const value = input[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > bounds.max) {
    throw new BadRequestException(`${field} must be at most ${bounds.max} characters.`);
  }
  return trimmed;
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
