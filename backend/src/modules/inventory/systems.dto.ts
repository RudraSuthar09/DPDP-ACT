import { BadRequestException } from '@nestjs/common';
import type { SystemFields } from './systems.repository';

/** Request parsing for /inventory/systems. Same hand-written, total style as register.dto.ts. */

export function parseSystemInput(body: unknown): SystemFields {
  const obj = asObject(body);
  return {
    name: requireString(obj, 'name', { min: 1, max: 200 }),
    systemType: requireString(obj, 'systemType', { min: 1, max: 100 }),
    description: optionalString(obj, 'description', { max: 2000 }),
    hostingLocation: optionalString(obj, 'hostingLocation', { max: 300 }),
    accessControlNote: optionalString(obj, 'accessControlNote', { max: 2000 }),
  };
}

export function parseTombstoneInput(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  const obj = asObject(body);
  return { reason: optionalString(obj, 'reason', { max: 1000 }) };
}

export function parseSystemLinkInput(body: unknown): { systemId: string } {
  const obj = asObject(body);
  return { systemId: requireString(obj, 'systemId', { min: 36, max: 36 }) };
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
