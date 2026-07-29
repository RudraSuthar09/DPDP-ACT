import { BadRequestException } from '@nestjs/common';
import {
  CONTACT_CHANNELS,
  IDENTITY_VERIFICATION_OUTCOMES,
  REQUEST_STATUSES,
  REQUEST_TYPES,
  type ContactChannel,
  type IdentityVerificationOutcome,
  type RequestStatus,
  type RequestType,
} from '@dpdp/shared';
import { parseLadder, type SlaPolicyValue } from './request-sla-policy';

/**
 * Input parsing for the request substrate.
 *
 * Hand-written, like every other module's dto.ts — no class-validator, no
 * decorators. The reason it matters more here than anywhere else: these are the
 * only parsers in the platform that run on input from a completely
 * unauthenticated stranger. Everything below assumes the caller is hostile and
 * validates length, shape, and charset before a value reaches SQL or an email
 * body.
 */

export interface SubmitRequestBody {
  requestType: RequestType;
  subject: string;
  body: string;
  contactChannel: ContactChannel;
  contactValue: string;
}

export function parseSubmitRequest(input: unknown): SubmitRequestBody {
  const body = asObject(input);
  const requestType = requireEnum(body, 'requestType', REQUEST_TYPES);
  const contactChannel = requireEnum(body, 'contactChannel', CONTACT_CHANNELS);
  return {
    requestType,
    subject: requireString(body, 'subject', 3, 200),
    // Generous but bounded. Long enough for a real complaint with detail; short
    // enough that a single POST cannot be used to store a file in the database.
    body: requireString(body, 'body', 10, 10_000),
    contactChannel,
    contactValue: normaliseContact(contactChannel, requireString(body, 'contactValue', 3, 320)),
  };
}

/**
 * Normalise and sanity-check a contact channel value.
 *
 * Lowercased and trimmed so "Asha@Example.com" and "asha@example.com " are ONE
 * subject to the rate limiter — otherwise the per-contact limit is defeated by
 * the shift key. The checks are deliberately shallow: a stricter email regex
 * rejects real addresses, and the only test that actually proves an address is
 * whether the OTP comes back.
 */
function normaliseContact(channel: ContactChannel, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new BadRequestException('contactValue must be a valid email address.');
    }
    return trimmed;
  }
  const digits = trimmed.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{8,15}$/.test(digits)) {
    throw new BadRequestException('contactValue must be a valid phone number in E.164-ish form.');
  }
  return digits;
}

export function parseOtpCode(input: unknown): string {
  const body = asObject(input);
  const code = requireString(body, 'code', 6, 6);
  if (!/^[0-9]{6}$/.test(code)) {
    throw new BadRequestException('code must be six digits.');
  }
  return code;
}

export function parsePortalMessage(input: unknown): string {
  return requireString(asObject(input), 'body', 1, 10_000);
}

export interface StaffCorrespondenceBody {
  direction: 'outbound' | 'internal_note';
  body: string;
}

export function parseStaffCorrespondence(input: unknown): StaffCorrespondenceBody {
  const body = asObject(input);
  const direction = requireEnum(body, 'direction', ['outbound', 'internal_note'] as const);
  return { direction, body: requireString(body, 'body', 1, 10_000) };
}

export interface CompleteIdentityVerificationBody {
  outcome: IdentityVerificationOutcome;
  reason: string;
  assignTo?: string;
}

/**
 * The FR-GRV-04 verdict.
 *
 * `reason` is REQUIRED and cannot be trivially short — this is a decision about
 * whether a human being gets to exercise a statutory right, and "no" with no
 * stated basis is not a decision anyone should be able to record. It is the same
 * standard the identity module already applies to suspending a user.
 *
 * Note what this parser has no field for: a customer id, an account reference,
 * an internal record locator. The verifier looked the person up in systems the
 * platform cannot see, and what comes back is the verdict — never the key they
 * matched on (I1).
 */
export function parseCompleteIdentityVerification(
  input: unknown,
): CompleteIdentityVerificationBody {
  const body = asObject(input);
  const parsed: CompleteIdentityVerificationBody = {
    outcome: requireEnum(body, 'outcome', IDENTITY_VERIFICATION_OUTCOMES),
    reason: requireString(body, 'reason', 10, 1000),
  };
  if (body.assignTo !== undefined && body.assignTo !== null) {
    parsed.assignTo = requireUuid(body, 'assignTo');
  }
  return parsed;
}

/** Statuses staff may move a ticket to directly. `created`, `contact_verified`
 *  and `pending_identity_verification` are absent on purpose: those are reached
 *  by the requester proving their channel and by the handoff being completed,
 *  never by someone declaring them. A narrow TYPE rather than a runtime check
 *  alone, so the transition table in request.service.ts is forced to cover
 *  exactly these three and cannot silently miss one. */
export const STAFF_SETTABLE_STATUSES = ['in_progress', 'resolved', 'closed'] as const;
export type StaffSettableStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

export interface ChangeStatusBody {
  status: StaffSettableStatus;
  reason: string;
  resolution?: string;
}

export function parseChangeStatus(input: unknown): ChangeStatusBody {
  const body = asObject(input);
  const parsed: ChangeStatusBody = {
    status: requireEnum(body, 'status', STAFF_SETTABLE_STATUSES),
    reason: requireString(body, 'reason', 5, 1000),
  };
  if (body.resolution !== undefined && body.resolution !== null) {
    parsed.resolution = requireString(body, 'resolution', 1, 2000);
  }
  return parsed;
}

export interface AssignBody {
  assigneeUserId: string;
  reason: string;
}

export function parseAssign(input: unknown): AssignBody {
  const body = asObject(input);
  return {
    assigneeUserId: requireUuid(body, 'assigneeUserId'),
    reason: requireString(body, 'reason', 5, 1000),
  };
}

export function parseManualEscalation(input: unknown): { reason: string } {
  return { reason: requireString(asObject(input), 'reason', 10, 1000) };
}

export interface SetSlaPolicyBody extends SlaPolicyValue {
  requestType: RequestType;
}

export function parseSetSlaPolicy(input: unknown): SetSlaPolicyBody {
  const body = asObject(input);
  const slaSeconds = Number(body.slaSeconds);
  if (!Number.isInteger(slaSeconds) || slaSeconds < 60 || slaSeconds > 31_536_000) {
    throw new BadRequestException('slaSeconds must be an integer between 60 and 31536000.');
  }
  return {
    requestType: requireEnum(body, 'requestType', REQUEST_TYPES),
    slaSeconds,
    ladder: parseLadder(body.ladder),
  };
}

export function parseStatusFilter(value: unknown): RequestStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!(REQUEST_STATUSES as readonly string[]).includes(String(value))) {
    throw new BadRequestException(`status must be one of: ${REQUEST_STATUSES.join(', ')}`);
  }
  return value as RequestStatus;
}

export function parseRequestTypeFilter(value: unknown): RequestType | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!(REQUEST_TYPES as readonly string[]).includes(String(value))) {
    throw new BadRequestException(`requestType must be one of: ${REQUEST_TYPES.join(', ')}`);
  }
  return value as RequestType;
}

// --- primitives -------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

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

function requireEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = body[field];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireUuid(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value;
}
