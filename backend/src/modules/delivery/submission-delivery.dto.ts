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

export function requireUuidParam(value: string, field = 'id'): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value;
}
