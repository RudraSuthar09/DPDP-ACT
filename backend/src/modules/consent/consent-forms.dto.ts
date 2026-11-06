import { BadRequestException } from '@nestjs/common';
import {
  CONSENT_FORM_FIELD_TYPES,
  CONSENT_FORM_FILE_KINDS,
  DEFAULT_UPLOAD_MAX_BYTES,
  UPLOAD_MAX_BYTES_CEILING,
  UPLOAD_MIN_BYTES,
  type ConsentFormFileKind,
} from '@dpdp/shared';

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

export interface LinkSubmissionFieldValueInput {
  fieldId: string;
  /** Set for a 'text' field. */
  textValue?: string;
  /** Set for a 'pdf'/'excel' field — original bytes, base64-encoded for
   *  transit. Decoded, never re-encoded, before being written anywhere. */
  file?: { filename: string; contentBase64: string };
}

export interface LinkSubmissionInput {
  /** The value the customer typed/uploaded into the field marked
   *  `isIdentifier`, or null if this form has no identifier field (or the
   *  visitor left it blank) — a submission with no identity is legitimate,
   *  not an error; it simply cannot be recognised as a repeat customer. */
  identityValue: string | null;
  /** The value the customer typed into the field marked `isCustomerName`,
   *  or null if this form has no customer-name field (or the visitor left
   *  it blank). Separate from identityValue on purpose: the field that names
   *  a customer on disk and the field that resolves their identity may be
   *  the same field or two different ones — see data_principals.display_name. */
  customerNameValue: string | null;
  answers: FormAnswerInput[];
  /** OPTIONAL. Present only when the hosted-link frontend's own check
   *  (publicFormForLink's `hasServerStorage`) says this tenant has an
   *  Enterprise 'server' storage root configured — never sent otherwise, so
   *  a SaaS-only tenant's field values still never reach this backend at all
   *  (I1 unchanged for every tenant without Enterprise server storage).
   *  Used ONLY to write these values synchronously to the configured
   *  filesystem path within THIS request; never stored in Postgres, never
   *  queued (CLAUDE.md R6) — see EnterpriseStorageSyncService. */
  fieldValues: LinkSubmissionFieldValueInput[];
}

/** Per-file cap on the DECODED byte size — a compliance document, not an
 *  arbitrary upload target. Rejected with a clean 400 rather than accepted
 *  and silently truncated. */
const MAX_FIELD_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_TEXT_LENGTH = 10_000;

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
    customerNameValue: optionalStringOrNull(obj, 'customerNameValue', { max: 500 }),
    answers: parseAnswers(obj),
    fieldValues: parseFieldValues(obj),
  };
}

function parseFieldValues(obj: Record<string, unknown>): LinkSubmissionFieldValueInput[] {
  const raw = obj['fieldValues'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('fieldValues must be an array.');
  const seen = new Set<string>();
  return raw.map((v) => {
    const vo = asObject(v);
    const fieldId = requireUuid(vo, 'fieldId');
    if (seen.has(fieldId)) throw new BadRequestException(`fieldValues has more than one entry for field ${fieldId}.`);
    seen.add(fieldId);

    const hasText = typeof vo['textValue'] === 'string';
    const hasFile = typeof vo['file'] === 'object' && vo['file'] !== null;
    if (hasText === hasFile) {
      throw new BadRequestException('fieldValues[].must set exactly one of textValue or file.');
    }
    if (hasText) {
      const textValue = vo['textValue'] as string;
      if (textValue.length > MAX_FIELD_TEXT_LENGTH) {
        throw new BadRequestException(`fieldValues[].textValue must be at most ${MAX_FIELD_TEXT_LENGTH} characters.`);
      }
      return { fieldId, textValue };
    }
    const fileObj = asObject(vo['file']);
    const filename = requireString(fileObj, 'filename', { min: 1, max: 200 });
    const contentBase64 = requireString(fileObj, 'contentBase64', { min: 1 });
    const decodedLength = base64DecodedLength(contentBase64);
    if (decodedLength === null) {
      throw new BadRequestException('fieldValues[].file.contentBase64 is not valid base64.');
    }
    if (decodedLength > MAX_FIELD_FILE_BYTES) {
      throw new BadRequestException(`fieldValues[].file exceeds the ${MAX_FIELD_FILE_BYTES / (1024 * 1024)}MB limit.`);
    }
    return { fieldId, file: { filename, contentBase64 } };
  });
}

/** Byte length WITHOUT decoding the whole payload twice — base64 expands 4
 *  chars per 3 bytes, minus padding. Returns null if the string is not
 *  valid base64 shape at all (rejected before any decode is attempted). */
function base64DecodedLength(base64: string): number | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
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
  /** Whether this field's value becomes the customer's filesystem display
   *  name (data_principals.display_name) — at most one per form, and
   *  independent of isIdentifier (may be the same field or a different one). */
  isCustomerName: boolean;
  /** Optional instructions for the respondent. */
  description: string | null;
  /** `file` fields only; null for every other type. */
  allowedFileKinds: ConsentFormFileKind | null;
  maxFileBytes: number | null;
}

/** Parses a field save: label + type + required + isIdentifier +
 *  isCustomerName + optional instructions, plus the upload configuration a
 *  `file` field needs. `fieldType` must be one of CONSENT_FORM_FIELD_TYPES —
 *  enforced here, not just hidden in the UI, so it cannot be bypassed by a
 *  direct API call. The one-per-form rules are enforced by the DB's partial
 *  unique indexes, not here — this function never guesses or defaults which
 *  field that should be.
 *
 *  The upload configuration is accepted ONLY for a `file` field and is
 *  rejected outright on any other type, rather than ignored: a caller that
 *  sends a 100 MB cap for a text field has misunderstood something, and
 *  silently dropping it would hide that. */
export function parseSaveCustomerField(body: unknown): SaveCustomerFieldDtoInput {
  const obj = asObject(body);
  const fieldType = requireString(obj, 'fieldType', { min: 1, max: 64 });
  if (!(CONSENT_FORM_FIELD_TYPES as readonly string[]).includes(fieldType)) {
    throw new BadRequestException(`fieldType must be one of: ${CONSENT_FORM_FIELD_TYPES.join(', ')}.`);
  }
  const description = optionalText(obj, 'description', 500);
  const isFileUpload = fieldType === 'file';
  const kindsRaw = obj['allowedFileKinds'];
  const maxRaw = obj['maxFileBytes'];

  if (!isFileUpload) {
    if (kindsRaw !== undefined && kindsRaw !== null) {
      throw new BadRequestException('allowedFileKinds applies only to a file upload field.');
    }
    if (maxRaw !== undefined && maxRaw !== null) {
      throw new BadRequestException('maxFileBytes applies only to a file upload field.');
    }
  }

  let allowedFileKinds: ConsentFormFileKind | null = null;
  let maxFileBytes: number | null = null;
  if (isFileUpload) {
    if (typeof kindsRaw !== 'string' || !(CONSENT_FORM_FILE_KINDS as readonly string[]).includes(kindsRaw)) {
      throw new BadRequestException(`allowedFileKinds must be one of: ${CONSENT_FORM_FILE_KINDS.join(', ')}.`);
    }
    allowedFileKinds = kindsRaw as ConsentFormFileKind;
    // Absent means "use the default", not "no limit" — an unbounded upload
    // field is never a reachable state.
    maxFileBytes = maxRaw === undefined || maxRaw === null ? DEFAULT_UPLOAD_MAX_BYTES : asInteger(maxRaw, 'maxFileBytes');
    if (maxFileBytes < UPLOAD_MIN_BYTES || maxFileBytes > UPLOAD_MAX_BYTES_CEILING) {
      throw new BadRequestException(
        `maxFileBytes must be between ${UPLOAD_MIN_BYTES} and ${UPLOAD_MAX_BYTES_CEILING} bytes.`,
      );
    }
  }

  return {
    label: requireString(obj, 'label', { min: 1, max: 200 }),
    fieldType,
    required: Boolean(obj['required']),
    isIdentifier: Boolean(obj['isIdentifier']),
    isCustomerName: Boolean(obj['isCustomerName']),
    description,
    allowedFileKinds,
    maxFileBytes,
  };
}

function optionalText(obj: Record<string, unknown>, key: string, max: number): string | null {
  const raw = obj[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException(`${key} must be a string.`);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new BadRequestException(`${key} must be at most ${max} characters.`);
  return trimmed;
}

function asInteger(raw: unknown, key: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new BadRequestException(`${key} must be an integer number of bytes.`);
  }
  return raw;
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

/**
 * The export-destination body: a storage root id, or null to clear it.
 *
 * The id is the ONLY thing read, and it is not trusted beyond being a UUID:
 * the service re-checks that the root is this tenant's, active and
 * gateway-provider (therefore writable), and the database re-checks the
 * tenant with its own trigger. No path, no folder name, no device.
 */
export function parseExportDestination(body: unknown): { storageRootId: string | null } {
  const obj = asObject(body);
  const raw = obj['storageRootId'];
  if (raw === null || raw === undefined) return { storageRootId: null };
  if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) {
    throw new BadRequestException('storageRootId must be a UUID, or null to save no spreadsheet.');
  }
  return { storageRootId: raw };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
