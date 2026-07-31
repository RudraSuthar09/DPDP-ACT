import { BadRequestException } from '@nestjs/common';
import {
  BREACH_GATES,
  BREACH_SEVERITIES,
  type BreachGate,
  type BreachSeverity,
} from '@dpdp/shared';

/** Hand-written, like every other module's dto.ts. */

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export interface CreateIncidentBody {
  title: string;
  whatHappened: string;
  discoveredAt: Date;
  occurredAt: Date | null;
  systemsAffected: string[];
  dataCategoryEntryIds: string[];
  estimatedAffectedCount: number | null;
  severity: BreachSeverity;
}

export function parseCreateIncident(input: unknown): CreateIncidentBody {
  const body = asRecord(input);

  const discoveredAt = new Date(String(body.discoveredAt ?? ''));
  if (Number.isNaN(discoveredAt.getTime())) {
    throw new BadRequestException('discoveredAt is required and must be an ISO-8601 timestamp.');
  }
  // Every statutory clock in this module runs from discovery, so a discovery
  // date in the future would put the deadline in the future too — an incident
  // could be logged as "not yet discovered" and never become late.
  if (discoveredAt.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestException('discoveredAt cannot be in the future.');
  }

  let occurredAt: Date | null = null;
  if (body.occurredAt !== undefined && body.occurredAt !== null && body.occurredAt !== '') {
    occurredAt = new Date(String(body.occurredAt));
    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException('occurredAt, if present, must be an ISO-8601 timestamp.');
    }
    if (occurredAt.getTime() > discoveredAt.getTime()) {
      throw new BadRequestException('occurredAt cannot be after discoveredAt.');
    }
  }

  const severity = String(body.severity ?? '');
  if (!(BREACH_SEVERITIES as readonly string[]).includes(severity)) {
    throw new BadRequestException(`severity must be one of: ${BREACH_SEVERITIES.join(', ')}`);
  }

  let estimatedAffectedCount: number | null = null;
  if (body.estimatedAffectedCount !== undefined && body.estimatedAffectedCount !== null) {
    const n = Number(body.estimatedAffectedCount);
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequestException('estimatedAffectedCount must be a non-negative integer.');
    }
    estimatedAffectedCount = n;
  }

  return {
    title: requireString(body, 'title', 3, 200),
    whatHappened: requireString(body, 'whatHappened', 10, 10_000),
    discoveredAt,
    occurredAt,
    systemsAffected: parseStringArray(body.systemsAffected, 'systemsAffected', 200),
    // The one field that is deliberately a list of IDs rather than free text —
    // a data category is a REFERENCE into the Data Inventory (FR-BRC-01).
    dataCategoryEntryIds: parseUuidArray(body.dataCategoryEntryIds, 'dataCategoryEntryIds'),
    estimatedAffectedCount,
    severity: severity as BreachSeverity,
  };
}

export function parseGate(value: unknown): BreachGate {
  if (typeof value !== 'string' || !(BREACH_GATES as readonly string[]).includes(value)) {
    throw new BadRequestException(`gate must be one of: ${BREACH_GATES.join(', ')}`);
  }
  return value as BreachGate;
}

export function parseGateCompletion(input: unknown): { notes: string } {
  // A gate passed with no account of what was done is a checkbox, not evidence
  // — the same standard the identity-verification verdict is held to.
  return { notes: requireString(asRecord(input), 'notes', 10, 10_000) };
}

export function parseClosure(input: unknown): { note: string } {
  return { note: requireString(asRecord(input), 'note', 10, 5_000) };
}

export interface EvidenceBody {
  fileName: string;
  contentType: string | null;
  /** Base64 of the file. Hashed in memory and discarded — see BreachService. */
  contentBase64: string;
  description: string | null;
}

export function parseEvidence(input: unknown): EvidenceBody {
  const body = asRecord(input);
  const contentBase64 = body.contentBase64;
  if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
    throw new BadRequestException('contentBase64 is required.');
  }
  // ~12 MB of base64. Generous for a log excerpt or a screenshot, bounded so a
  // single POST cannot be used to push an arbitrary blob through the API — and
  // the bytes are never stored anyway, so there is no reason to accept more.
  if (contentBase64.length > 16_000_000) {
    throw new BadRequestException('The file is too large. Submit an excerpt or a manifest instead.');
  }
  return {
    fileName: requireString(body, 'fileName', 1, 255),
    contentType: optionalString(body, 'contentType', 100),
    contentBase64,
    description: optionalString(body, 'description', 1000),
  };
}

// --- primitives -------------------------------------------------------------

function requireString(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new BadRequestException(`${field} must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

function optionalString(
  body: Record<string, unknown>,
  field: string,
  max: number,
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new BadRequestException(`${field}, if present, must be a string of at most ${max} characters.`);
  }
  return value.trim();
}

function parseStringArray(value: unknown, field: string, maxLen: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array of strings.`);
  if (value.length > 50) throw new BadRequestException(`${field} may have at most 50 entries.`);
  return value.map((v) => {
    if (typeof v !== 'string' || v.trim().length === 0 || v.trim().length > maxLen) {
      throw new BadRequestException(`Each ${field} entry must be a non-empty string.`);
    }
    return v.trim();
  });
}

function parseUuidArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array of UUIDs.`);
  if (value.length > 100) throw new BadRequestException(`${field} may have at most 100 entries.`);
  return value.map((v) => {
    if (
      typeof v !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ) {
      throw new BadRequestException(`Each ${field} entry must be a UUID.`);
    }
    return v;
  });
}
