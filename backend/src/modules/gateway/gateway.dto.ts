import { BadRequestException } from '@nestjs/common';
import { GATEWAY_AGENT_PLATFORMS, type GatewayAgentPlatform } from '@dpdp/shared';

/**
 * Request parsing for the Gateway control plane — hand-written and total, same
 * style as the other module DTOs. The security-critical rule here: the enrolment
 * request accepts ONLY a PUBLIC key and non-secret device metadata, and REJECTS
 * anything that looks like a private key or a credential. A private key must
 * never leave the Enterprise machine, so the backend refuses to even receive one.
 */

/** Field names that must never appear on a request into the control plane —
 *  a private key, or any credential. Refused at the edge, on every DTO. */
const FORBIDDEN_SECRET_FIELDS = [
  'privateKey',
  'private_key',
  'privatekey',
  'secretKey',
  'secret_key',
  'secret',
  'password',
  'passphrase',
  'credential',
  'credentials',
  'connectionString',
  'connection_string',
  'dsn',
  'token',
];

function rejectSecretFields(obj: Record<string, unknown>): void {
  for (const field of FORBIDDEN_SECRET_FIELDS) {
    if (field in obj) {
      throw new BadRequestException(
        `The Gateway control plane never accepts "${field}". A private key/credential must ` +
          'remain on the Enterprise machine and is never sent to the platform.',
      );
    }
  }
}

export interface EnrollDeviceInput {
  publicKey: string;
  platform: GatewayAgentPlatform;
  agentVersion: string;
  displayName: string;
  deviceRef: string | null;
}

export function parseEnrollDevice(body: unknown): EnrollDeviceInput {
  const obj = asObject(body);
  rejectSecretFields(obj);
  const platform = obj['platform'];
  if (typeof platform !== 'string' || !(GATEWAY_AGENT_PLATFORMS as readonly string[]).includes(platform)) {
    throw new BadRequestException(`platform must be one of: ${GATEWAY_AGENT_PLATFORMS.join(', ')}.`);
  }
  const publicKey = requireString(obj, 'publicKey', { min: 40, max: 8192 });
  // A public key only. If it smells like a private key, refuse it outright.
  if (/PRIVATE KEY/i.test(publicKey)) {
    throw new BadRequestException('publicKey must be a PUBLIC key — a private key must never be sent.');
  }
  return {
    publicKey,
    platform: platform as GatewayAgentPlatform,
    agentVersion: requireString(obj, 'agentVersion', { min: 1, max: 64 }),
    displayName: requireString(obj, 'displayName', { min: 1, max: 200 }),
    deviceRef: optionalStringOrNull(obj, 'deviceRef', { max: 200 }),
  };
}

/** Staff creates a one-time enrolment code (optionally labelled). */
export function parseCreateEnrollment(body: unknown): { label: string | null } {
  if (body === undefined || body === null) return { label: null };
  const obj = asObject(body);
  rejectSecretFields(obj);
  return { label: optionalStringOrNull(obj, 'label', { max: 200 }) };
}

/** Staff creates a pairing nonce for a specific source + enrolled device. */
export function parseCreatePairing(body: unknown): { sourceId: string; deviceId: string } {
  const obj = asObject(body);
  rejectSecretFields(obj);
  return {
    sourceId: requireUuid(obj, 'sourceId'),
    deviceId: requireUuid(obj, 'deviceId'),
  };
}

/** Device redeems a pairing nonce for a source. */
export function parseRedeemPairing(body: unknown): { nonce: string; sourceId: string } {
  const obj = asObject(body);
  rejectSecretFields(obj);
  return {
    nonce: requireString(obj, 'nonce', { min: 16, max: 512 }),
    sourceId: requireUuid(obj, 'sourceId'),
  };
}

/** Device refreshes a session. */
export function parseRefreshSession(body: unknown): { sessionToken: string } {
  const obj = asObject(body);
  rejectSecretFields(obj);
  // sessionToken is the one legitimately-present opaque credential on this route;
  // it is checked by shape only and never logged.
  const value = obj['sessionToken'];
  if (typeof value !== 'string' || value.trim().length < 16 || value.trim().length > 512) {
    throw new BadRequestException('sessionToken must be an opaque token string.');
  }
  return { sessionToken: value.trim() };
}

/** Heartbeat carries only the agent version (liveness metadata). */
export function parseHeartbeat(body: unknown): { agentVersion: string } {
  const obj = asObject(body);
  rejectSecretFields(obj);
  return { agentVersion: requireString(obj, 'agentVersion', { min: 1, max: 64 }) };
}

export function parseRevokeReason(body: unknown): { reason: string | null } {
  if (body === undefined || body === null) return { reason: null };
  const obj = asObject(body);
  rejectSecretFields(obj);
  return { reason: optionalStringOrNull(obj, 'reason', { max: 1000 }) };
}

// --- helpers (same shape as data-source.dto) --------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const value = obj[field];
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required and must be a string.`);
  const trimmed = value.trim();
  if (opts.min !== undefined && trimmed.length < opts.min) throw new BadRequestException(`${field} must be at least ${opts.min} character(s).`);
  if (opts.max !== undefined && trimmed.length > opts.max) throw new BadRequestException(`${field} must be at most ${opts.max} character(s).`);
  return trimmed;
}

function requireUuid(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value.trim();
}

function optionalStringOrNull(obj: Record<string, unknown>, field: string, opts: { max?: number } = {}): string | null {
  const value = obj[field];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string.`);
  const trimmed = value.trim();
  if (opts.max !== undefined && trimmed.length > opts.max) throw new BadRequestException(`${field} must be at most ${opts.max} character(s).`);
  return trimmed || null;
}
