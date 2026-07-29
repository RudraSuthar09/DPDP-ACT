import { BadRequestException } from '@nestjs/common';

/**
 * Request parsing for /inventory/register/import/*. Same hand-written, total
 * style as the other modules' DTOs.
 */

const CSV_MAX = 5 * 1024 * 1024; // 5 MB — matches the /inventory/discover limit.

export interface ParsedPreviewInput {
  fileName: string;
  tableName: string;
  csvText: string;
}

export function parsePreviewInput(body: unknown): ParsedPreviewInput {
  const obj = asObject(body);
  return {
    fileName: requireString(obj, 'fileName', { min: 1, max: 260 }),
    tableName: requireString(obj, 'tableName', { min: 1, max: 200 }),
    csvText: requireString(obj, 'csvText', { min: 1, max: CSV_MAX }),
  };
}

export interface ColumnMappingInput {
  name: string;
  category: string;
  description: string | null;
}

const LEGAL_BASES = ['consent', 'legitimate_use', 'contract', 'legal_obligation', 'other'] as const;
export type ImportLegalBasis = (typeof LEGAL_BASES)[number];

export interface ParsedCommitInput {
  fileName: string;
  tableName: string;
  csvText: string;
  purpose: string;
  legalBasis: ImportLegalBasis;
  storageLocation: string;
  retentionPeriod: string;
  columns: ColumnMappingInput[];
}

export function parseCommitInput(body: unknown): ParsedCommitInput {
  const obj = asObject(body);
  const columnsRaw = requireArray(obj, 'columns');
  if (columnsRaw.length === 0) {
    throw new BadRequestException('columns must include at least one mapped column.');
  }
  const legalBasis = obj.legalBasis;
  if (typeof legalBasis !== 'string' || !(LEGAL_BASES as readonly string[]).includes(legalBasis)) {
    throw new BadRequestException(`legalBasis must be one of: ${LEGAL_BASES.join(', ')}.`);
  }
  return {
    fileName: requireString(obj, 'fileName', { min: 1, max: 260 }),
    tableName: requireString(obj, 'tableName', { min: 1, max: 200 }),
    csvText: requireString(obj, 'csvText', { min: 1, max: CSV_MAX }),
    purpose: requireString(obj, 'purpose', { min: 1, max: 2000 }),
    legalBasis: legalBasis as ImportLegalBasis,
    storageLocation: requireString(obj, 'storageLocation', { min: 1, max: 500 }),
    retentionPeriod: requireString(obj, 'retentionPeriod', { min: 1, max: 200 }),
    columns: columnsRaw.map(parseColumnMapping),
  };
}

function parseColumnMapping(value: unknown): ColumnMappingInput {
  const obj = asObject(value, 'column mapping');
  const description = obj.description;
  return {
    name: requireString(obj, 'name', { min: 1, max: 200 }),
    category: requireString(obj, 'category', { min: 1, max: 200 }),
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
  };
}

// --- primitives -------------------------------------------------------------

function asObject(body: unknown, label = 'body'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException(`${label} must be a JSON object.`);
  }
  return body as Record<string, unknown>;
}

function requireArray(input: Record<string, unknown>, field: string): unknown[] {
  const value = input[field];
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${field} is required and must be an array.`);
  }
  return value;
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
  // Not trimmed for csvText (its content is the payload); trimmed for names.
  const measured = field === 'csvText' ? value : value.trim();
  if (measured.length < bounds.min || measured.length > bounds.max) {
    throw new BadRequestException(`${field} must be between ${bounds.min} and ${bounds.max} characters.`);
  }
  return measured;
}
