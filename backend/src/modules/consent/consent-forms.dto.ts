import { BadRequestException } from '@nestjs/common';

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
