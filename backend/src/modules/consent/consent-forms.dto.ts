import { BadRequestException } from '@nestjs/common';
import { CONSENT_FIELD_DESTINATIONS, type ConsentFieldDestination } from '@dpdp/shared';

/** Column TYPES a "create new column" request may declare (3G-1: config only —
 *  nothing is created yet; this is the allowlist the eventual 3G-2 ALTER will
 *  also enforce). Kept small and generic — never a business-meaning type like
 *  "aadhaar" or "pan". */
const NEW_COLUMN_TYPES = ['text', 'integer', 'boolean', 'timestamp', 'date'] as const;

/**
 * A strict, conservative column-identifier validator (letters/digits/underscore,
 * starting with a letter/underscore, ≤63 chars). Deliberately duplicated from
 * data-source.dto.ts rather than imported (R2 — modules stay independent; this
 * is six lines, not a shared table) — both copies exist purely so a
 * client-supplied "this is a column name" string is shape-checked at the edge,
 * never to construct SQL here.
 */
function parseColumnIdentifier(value: string, field: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(trimmed)) {
    throw new BadRequestException(
      `${field} must be a valid column identifier (letters, digits, underscore; starting with a letter or underscore).`,
    );
  }
  return trimmed;
}

/** Request parsing for the new-UX consent forms — hand-written and total. */

export interface SaveFormInput {
  name: string;
  description: string | null;
}

export interface AddRowInput {
  label: string;
  noticeText: string;
  active?: boolean;
  inventoryEntryId: string | null;
}

export interface UpdateRowInput {
  label: string;
  noticeText: string;
  inventoryEntryId: string | null;
}

export interface FormAnswerInput {
  consentPurposeId: string;
  granted: boolean;
}

export interface WidgetSubmissionInput {
  customerId: string;
  answers: FormAnswerInput[];
}

export interface LinkSubmissionInput {
  name: string;
  email: string | null;
  phone: string | null;
  answers: FormAnswerInput[];
}

export function parseSaveFormInput(body: unknown): SaveFormInput {
  const obj = asObject(body);
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    description: optionalStringOrNull(obj, 'description', { max: 2000 }),
  };
}

export function parseAddRowInput(body: unknown): AddRowInput {
  const obj = asObject(body);
  const active = obj['active'];
  return {
    label: requireString(obj, 'label', { min: 1, max: 200 }),
    noticeText: requireString(obj, 'noticeText', { min: 1, max: 2000 }),
    active: active === undefined ? undefined : Boolean(active),
    inventoryEntryId: optionalUuidOrNull(obj, 'inventoryEntryId'),
  };
}

export function parseUpdateRowInput(body: unknown): UpdateRowInput {
  const obj = asObject(body);
  return {
    label: requireString(obj, 'label', { min: 1, max: 200 }),
    noticeText: requireString(obj, 'noticeText', { min: 1, max: 2000 }),
    inventoryEntryId: optionalUuidOrNull(obj, 'inventoryEntryId'),
  };
}

export function parseActiveFlag(body: unknown, field = 'active'): boolean {
  const obj = asObject(body);
  if (typeof obj[field] !== 'boolean') {
    throw new BadRequestException(`${field} must be a boolean.`);
  }
  return obj[field] as boolean;
}

export function parseWidgetSubmission(body: unknown): WidgetSubmissionInput {
  const obj = asObject(body);
  return { customerId: requireString(obj, 'customerId', { min: 1, max: 256 }), answers: parseAnswers(obj) };
}

export function parseLinkSubmission(body: unknown): LinkSubmissionInput {
  const obj = asObject(body);
  const name = requireString(obj, 'name', { min: 1, max: 200 });
  const email = optionalStringOrNull(obj, 'email', { max: 320 });
  const phone = optionalStringOrNull(obj, 'phone', { max: 32 });
  if (!email && !phone) {
    throw new BadRequestException('Either email or phone is required.');
  }
  return { name, email, phone, answers: parseAnswers(obj) };
}

function parseAnswers(obj: Record<string, unknown>): FormAnswerInput[] {
  const raw = obj['answers'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException('answers must be a non-empty array.');
  }
  const seen = new Set<string>();
  return raw.map((a) => {
    const ao = asObject(a);
    const consentPurposeId = requireUuid(ao, 'consentPurposeId');
    if (seen.has(consentPurposeId)) {
      throw new BadRequestException(`consentPurposeId ${consentPurposeId} answered more than once.`);
    }
    seen.add(consentPurposeId);
    if (typeof ao['granted'] !== 'boolean') {
      throw new BadRequestException('answers[].granted must be a boolean.');
    }
    return { consentPurposeId, granted: ao['granted'] as boolean };
  });
}

// --- Phase 3G-1: customer-data field configuration --------------------------

export interface SaveCustomerFieldDtoInput {
  label: string;
  fieldType: string;
  required: boolean;
  destination: ConsentFieldDestination;
  mappedColumn: string | null;
  newColumnName: string | null;
  newColumnType: string | null;
}

/**
 * Parses a customer-data field save. The mapping is EXPLICIT-or-absent by
 * construction: `mappedColumn`/`newColumnName` are only ever set to what the
 * caller sent, never derived, never defaulted from the label. A
 * `destination: 'consent_record'` field is rejected if it carries a mapping —
 * the DB CHECK constraint enforces the same rule, this just fails fast with a
 * clear message. `mappedColumn` and a `newColumnName` may not both be present
 * (a field is either mapped to an existing column or configured to create one).
 */
export function parseSaveCustomerField(body: unknown): SaveCustomerFieldDtoInput {
  const obj = asObject(body);
  const destinationRaw = obj['destination'];
  if (typeof destinationRaw !== 'string' || !(CONSENT_FIELD_DESTINATIONS as readonly string[]).includes(destinationRaw)) {
    throw new BadRequestException(`destination must be one of: ${CONSENT_FIELD_DESTINATIONS.join(', ')}.`);
  }
  const destination = destinationRaw as ConsentFieldDestination;

  const mappedColumn = optionalStringOrNull(obj, 'mappedColumn', { max: 63 });
  const newColumnName = optionalStringOrNull(obj, 'newColumnName', { max: 63 });
  const newColumnType = optionalStringOrNull(obj, 'newColumnType', { max: 32 });

  if (destination === 'consent_record' && (mappedColumn || newColumnName)) {
    throw new BadRequestException('A field stored in the Consent Record cannot also carry a column mapping.');
  }
  if (mappedColumn && newColumnName) {
    throw new BadRequestException('Choose either an existing column or "create new column" — not both.');
  }
  if (newColumnName && !newColumnType) {
    throw new BadRequestException('newColumnType is required when newColumnName is set.');
  }
  if (newColumnType && !(NEW_COLUMN_TYPES as readonly string[]).includes(newColumnType)) {
    throw new BadRequestException(`newColumnType must be one of: ${NEW_COLUMN_TYPES.join(', ')}.`);
  }

  return {
    label: requireString(obj, 'label', { min: 1, max: 200 }),
    fieldType: requireString(obj, 'fieldType', { min: 1, max: 64 }),
    required: Boolean(obj['required']),
    destination,
    mappedColumn: mappedColumn ? parseColumnIdentifier(mappedColumn, 'mappedColumn') : null,
    newColumnName: newColumnName ? parseColumnIdentifier(newColumnName, 'newColumnName') : null,
    newColumnType,
  };
}

/** The body for associating a form with a data source: `{ sourceId: string|null }`. */
export function parseSetFormSource(body: unknown): { sourceId: string | null } {
  const obj = asObject(body);
  return { sourceId: optionalUuidOrNull(obj, 'sourceId') };
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

function optionalUuidOrNull(obj: Record<string, unknown>, field: string): string | null {
  const value = obj[field];
  if (value === undefined || value === null || value === '') return null;
  return requireUuid(obj, field);
}

function requireUuid(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value;
}
