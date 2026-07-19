import { BadRequestException } from '@nestjs/common';
import type { SchemaColumn } from '@dpdp/shared';
import type { SchemaSourceInput } from './schema-source/schema-source.factory';
import type { ManualDeclaration, ManualSchema, ManualTable } from './schema-source/manual-entry.source';

/**
 * Request parsing for /inventory/discover. Narrows the two SchemaSource kinds
 * from `unknown` before they reach the factory — same hand-written, total style
 * as the other modules' DTOs.
 */

export interface ParsedDiscover {
  input: SchemaSourceInput;
  /** A human-readable provenance ref stored on every discovered element. */
  sourceRef: string;
}

const CSV_MAX = 5 * 1024 * 1024; // 5 MB — a header-only parser needs no more.

export function parseDiscover(body: unknown): ParsedDiscover {
  const obj = asObject(body);
  const kind = requireString(obj, 'kind', { min: 1, max: 20 });

  if (kind === 'manual') {
    return { input: { kind: 'manual', declaration: parseDeclaration(obj.declaration) }, sourceRef: 'wizard' };
  }

  if (kind === 'file_import') {
    const fileName = requireString(obj, 'fileName', { min: 1, max: 260 });
    const tableName = requireString(obj, 'tableName', { min: 1, max: 200 });
    const csvText = requireString(obj, 'csvText', { min: 1, max: CSV_MAX });
    return { input: { kind: 'file_import', fileName, tableName, csvText }, sourceRef: fileName };
  }

  throw new BadRequestException("kind must be 'manual' or 'file_import'.");
}

function parseDeclaration(value: unknown): ManualDeclaration {
  const obj = asObject(value, 'declaration');
  const schemas = requireArray(obj, 'schemas');
  if (schemas.length === 0) {
    throw new BadRequestException('declaration.schemas must not be empty.');
  }
  return { schemas: schemas.map(parseSchema) };
}

function parseSchema(value: unknown): ManualSchema {
  const obj = asObject(value, 'schema');
  return {
    name: requireString(obj, 'name', { min: 1, max: 200 }),
    tables: requireArray(obj, 'tables').map(parseTable),
  };
}

function parseTable(value: unknown): ManualTable {
  const obj = asObject(value, 'table');
  return {
    name: requireString(obj, 'name', { min: 1, max: 200 }),
    columns: requireArray(obj, 'columns').map(parseColumn),
  };
}

function parseColumn(value: unknown): SchemaColumn {
  const obj = asObject(value, 'column');
  const comment = obj.comment;
  return {
    name: requireString(obj, 'name', { min: 1, max: 200 }),
    type: requireString(obj, 'type', { min: 1, max: 100 }),
    nullable: obj.nullable !== false, // default true unless explicitly false
    ...(typeof comment === 'string' && comment.trim() ? { comment: comment.trim() } : {}),
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
