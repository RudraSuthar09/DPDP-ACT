import { BadRequestException } from '@nestjs/common';
import { DPR_RIGHT_TYPES, type DprRightType } from '@dpdp/shared';

/**
 * DPRequest's own small parser, in the same hand-written style as Grievance's
 * (see `grievance/dto.ts`). The generic submission body — subject, body,
 * contactChannel, contactValue — stays owned by `request/dto.ts` unchanged;
 * only the two genuinely DPR-only inputs are validated here.
 */

export function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return input as Record<string, unknown>;
}

export function parseRightType(input: unknown): DprRightType {
  const value = asRecord(input).rightType;
  if (typeof value !== 'string' || !(DPR_RIGHT_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(`rightType must be one of: ${DPR_RIGHT_TYPES.join(', ')}`);
  }
  return value as DprRightType;
}

export function parseRightTypeFilter(value: unknown): DprRightType | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!(DPR_RIGHT_TYPES as readonly string[]).includes(String(value))) {
    throw new BadRequestException(`rightType must be one of: ${DPR_RIGHT_TYPES.join(', ')}`);
  }
  return value as DprRightType;
}

/**
 * The raw customer id a verifier types in to resolve a subject reference.
 *
 * The ONLY place in the platform where a client's internal customer id is
 * accepted over the wire outside the Consent SDK — and the contract attached to
 * it is strict: it is HMAC'd immediately, the digest is stored, and the raw
 * value is never written to a table, a log line, or an audit entry (I2). See
 * `DPRequestService.resolveSubjectRef`, which is the only caller.
 *
 * Bounded at 200 characters because an account reference is short. A 10 kB
 * "customer id" is either an attack or a paste of an entire customer record,
 * and neither should get as far as the hasher.
 */
export function parseSubjectResolution(input: unknown): { customerId: string; reason: string } {
  const body = asRecord(input);
  const customerId = body.customerId;
  if (typeof customerId !== 'string' || customerId.trim().length < 1 || customerId.length > 200) {
    throw new BadRequestException('customerId must be a string of 1-200 characters.');
  }
  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 1000) {
    throw new BadRequestException(
      'reason must be 10-1000 characters: resolving a subject reference is an act on a real ' +
        'person’s record and the trail has to say why it was done.',
    );
  }
  return { customerId: customerId.trim(), reason: reason.trim() };
}
