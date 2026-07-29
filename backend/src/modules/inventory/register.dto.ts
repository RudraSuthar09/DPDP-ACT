import { BadRequestException } from '@nestjs/common';
import type { RegisterEntryFields } from './register-entries.repository';

/**
 * Request parsing for /inventory/register. Same hand-written, total style as
 * the other modules' DTOs — narrows `unknown` before it reaches the service.
 */

export function parseRegisterEntryInput(body: unknown): RegisterEntryFields {
  const obj = asObject(body);
  return {
    category: requireString(obj, 'category', { min: 1, max: 200 }),
    description: optionalString(obj, 'description', { max: 2000 }),
    storageLocation: requireString(obj, 'storageLocation', { min: 1, max: 500 }),
  };
}

export function parseTombstoneInput(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) {
    return { reason: null };
  }
  const obj = asObject(body);
  return { reason: optionalString(obj, 'reason', { max: 1000 }) };
}

export interface ParsedPiiDecisionInput {
  decision: 'accepted' | 'rejected';
  reason: string | null;
}

export function parsePiiDecisionInput(body: unknown): ParsedPiiDecisionInput {
  const obj = asObject(body);
  const decision = obj.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    throw new BadRequestException('decision must be "accepted" or "rejected".');
  }
  const reason = optionalString(obj, 'reason', { max: 1000 });
  if (decision === 'rejected' && !reason) {
    throw new BadRequestException('reason is required when rejecting a classification suggestion.');
  }
  return { decision, reason };
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
