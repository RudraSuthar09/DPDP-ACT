import { BadRequestException } from '@nestjs/common';
import type { EntryPurposeFields, LegalBasis } from './entry-purposes.repository';

/**
 * Request parsing for /inventory/register/:entryId/purposes. Same
 * hand-written, total style as register.dto.ts.
 */

const LEGAL_BASES: readonly LegalBasis[] = [
  'consent',
  'legitimate_use',
  'contract',
  'legal_obligation',
  'other',
];

export function parseEntryPurposeInput(body: unknown): EntryPurposeFields {
  const obj = asObject(body);
  const legalBasis = obj.legalBasis;
  if (typeof legalBasis !== 'string' || !LEGAL_BASES.includes(legalBasis as LegalBasis)) {
    throw new BadRequestException(`legalBasis must be one of: ${LEGAL_BASES.join(', ')}.`);
  }
  return {
    purposeName: requireString(obj, 'purposeName', { min: 1, max: 200 }),
    description: optionalString(obj, 'description', { max: 2000 }),
    legalBasis: legalBasis as LegalBasis,
    legalBasisNote: optionalString(obj, 'legalBasisNote', { max: 1000 }),
    retentionPeriod: requireString(obj, 'retentionPeriod', { min: 1, max: 200 }),
    retentionMonths: optionalPositiveInt(obj, 'retentionMonths'),
  };
}

function optionalPositiveInt(input: Record<string, unknown>, field: string): number | null {
  const value = input[field];
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
    throw new BadRequestException(`${field} must be a positive whole number of months.`);
  }
  return n;
}

export function parsePurposeTombstoneInput(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  const obj = asObject(body);
  return { reason: optionalString(obj, 'reason', { max: 1000 }) };
}

// --- primitives -------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('body must be a JSON object.');
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
    throw new BadRequestException(
      `${field} must be between ${bounds.min} and ${bounds.max} characters.`,
    );
  }
  return trimmed;
}

function optionalString(
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
