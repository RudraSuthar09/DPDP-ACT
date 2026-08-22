import { BadRequestException } from '@nestjs/common';
import { CONSENT_FORM_FIELD_TYPES } from '@dpdp/shared';

/** Request parsing for the new-UX consent forms — hand-written and total. */

export interface SaveFormInput {
  name: string;
  description: string | null;
  /** Client-authored Notice/Terms & Conditions, shown once above the form.
   *  Plain content the client owns — never generated here. */
  noticeText: string | null;
  /** Central DPDP Storage simplification: how many months this template's
   *  consent data should be retained in the client's local storage.
   *  Configuration only — never enforced/deleted by this endpoint. */
  retentionMonths: number | null;
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
  /** The value the customer typed/uploaded into the field marked
   *  `isIdentifier`, or null if this form has no identifier field (or the
   *  visitor left it blank) — a submission with no identity is legitimate,
   *  not an error; it simply cannot be recognised as a repeat customer. */
  identityValue: string | null;
  answers: FormAnswerInput[];
}

export function parseSaveFormInput(body: unknown): SaveFormInput {
  const obj = asObject(body);
  return {
    name: requireString(obj, 'name', { min: 2, max: 200 }),
    description: optionalStringOrNull(obj, 'description', { max: 2000 }),
    noticeText: optionalStringOrNull(obj, 'noticeText', { max: 20000 }),
    retentionMonths: optionalPositiveIntOrNull(obj, 'retentionMonths'),
  };
}

/** A whole number of months, > 0, or absent/null. Never guessed/defaulted —
 *  the client explicitly sets a retention period or leaves it unconfigured. */
function optionalPositiveIntOrNull(obj: Record<string, unknown>, field: string): number | null {
  const value = obj[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new BadRequestException(`${field} must be a positive whole number of months, or omitted.`);
  }
  return value;
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
  return {
    identityValue: optionalStringOrNull(obj, 'identityValue', { max: 500 }),
    answers: parseAnswers(obj),
  };
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

// --- Form fields — a simple, Google-Forms-like field list -------------------

export interface SaveCustomerFieldDtoInput {
  label: string;
  fieldType: string;
  required: boolean;
  /** Whether this field's value is the raw identity hashed into subject_ref
   *  (I2) — at most one per form (DB-enforced, see the migration header). */
  isIdentifier: boolean;
}

/** Parses a field save: label + type + required + isIdentifier, nothing
 *  else. `fieldType` must be one of CONSENT_FORM_FIELD_TYPES (text/pdf/
 *  excel) — enforced here, not just hidden in the UI, so it cannot be
 *  bypassed by a direct API call. The one-identifier-per-form rule is
 *  enforced by the DB's partial unique index, not here — this function
 *  never guesses or defaults which field that should be. */
export function parseSaveCustomerField(body: unknown): SaveCustomerFieldDtoInput {
  const obj = asObject(body);
  const fieldType = requireString(obj, 'fieldType', { min: 1, max: 64 });
  if (!(CONSENT_FORM_FIELD_TYPES as readonly string[]).includes(fieldType)) {
    throw new BadRequestException(`fieldType must be one of: ${CONSENT_FORM_FIELD_TYPES.join(', ')}.`);
  }
  return {
    label: requireString(obj, 'label', { min: 1, max: 200 }),
    fieldType,
    required: Boolean(obj['required']),
    isIdentifier: Boolean(obj['isIdentifier']),
  };
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
