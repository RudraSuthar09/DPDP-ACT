import { BadRequestException } from '@nestjs/common';

export interface FailDeliveryInput {
  /** A short, sanitized failure reason from the agent — never a field value,
   *  never a raw filesystem error message that might embed customer content
   *  (the agent is responsible for sanitizing before sending this). */
  error: string;
}

export function parseFailDeliveryInput(body: unknown): FailDeliveryInput {
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const raw = obj['error'];
  const error = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 2000) : 'Unknown delivery failure.';
  return { error };
}

/** What the claiming device can perform. An EMPTY body (every agent before
 *  this field existed) means exactly the old behaviour: Central only. */
export interface DeliveryClaimInput {
  central: boolean;
  /** Storage roots the device reports as authorized for writing BY ITS
   *  ADMINISTRATOR. Only narrows what it is offered; whether each root is
   *  really bound to this device is checked again server-side at claim. */
  storageRootIds: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REPORTED_ROOTS = 50;

export function parseClaimInput(body: unknown): DeliveryClaimInput {
  const obj = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const central = obj['central'] === undefined ? true : obj['central'] === true;
  const raw = obj['storageRootIds'];
  if (raw === undefined) return { central, storageRootIds: [] };
  if (!Array.isArray(raw) || raw.length > MAX_REPORTED_ROOTS || !raw.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
    throw new BadRequestException(`storageRootIds must be an array of at most ${MAX_REPORTED_ROOTS} UUIDs.`);
  }
  return { central, storageRootIds: [...new Set(raw as string[])] };
}

export function requireUuidParam(value: string, field = 'id'): string {
  if (!UUID_RE.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value;
}
