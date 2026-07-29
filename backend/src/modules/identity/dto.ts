import { BadRequestException } from '@nestjs/common';
import { isRole, ROLES, USER_STATUSES, type Role, type UserStatus } from '@dpdp/shared';

/**
 * Request parsing for the identity routes.
 *
 * Hand-written rather than class-validator + class-transformer + a global
 * ValidationPipe: that is two dependencies and a decorator-metadata build
 * requirement for six small payloads, on a module whose whole point is to add no
 * attack surface. These functions are total — every field that reaches a service
 * has been narrowed from `unknown` — which is the property that actually matters.
 * If validation needs grow past this file, class-validator is the right answer;
 * it is not the right answer yet.
 */

/**
 * NIST SP 800-63B: length is the control that matters, composition rules ("one
 * uppercase, one symbol") are not — they push users toward Passw0rd! and are
 * explicitly recommended against. So: a real minimum, a maximum that exists only
 * to stop someone handing our KDF a 10 MB password as a DoS, and no theatre.
 */
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

/** Deliberately permissive: the RFC 5322 grammar is not worth re-litigating, and
 *  the address is proven by the confirmation email, not by a regex. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegisterOrganisationBody {
  organisationName: string;
  ownerEmail: string;
  ownerName: string;
  password: string;
}

export function parseRegisterOrganisation(body: unknown): RegisterOrganisationBody {
  const input = asObject(body);
  return {
    organisationName: requireString(input, 'organisationName', { min: 2, max: 200 }),
    ownerEmail: requireEmail(input, 'ownerEmail'),
    ownerName: requireString(input, 'ownerName', { min: 1, max: 200 }),
    password: requirePassword(input, 'password'),
  };
}

export interface LoginBody {
  email: string;
  password: string;
}

export function parseLogin(body: unknown): LoginBody {
  const input = asObject(body);
  return {
    email: requireEmail(input, 'email'),
    // NOT requirePassword: the policy applies when SETTING a password. Applying
    // it at login would reject a legitimate old password after a policy change,
    // and would tell an attacker which guesses are worth making.
    password: requireString(input, 'password', { min: 1, max: PASSWORD_MAX }),
  };
}

export interface MfaBody {
  challengeToken: string;
  code: string;
}

export function parseMfa(body: unknown): MfaBody {
  const input = asObject(body);
  return {
    challengeToken: requireString(input, 'challengeToken', { min: 1, max: 4096 }),
    // Width is not constrained here: a 6-digit TOTP and a 14-char recovery code
    // are both valid, and the verifier is the thing that knows the difference.
    code: requireString(input, 'code', { min: 1, max: 64 }),
  };
}

export interface ChallengeBody {
  challengeToken: string;
}

export function parseChallenge(body: unknown): ChallengeBody {
  const input = asObject(body);
  return { challengeToken: requireString(input, 'challengeToken', { min: 1, max: 4096 }) };
}

export interface SetStatusBody {
  status: UserStatus;
  reason: string;
}

export function parseSetStatus(body: unknown): SetStatusBody {
  const input = asObject(body);
  const status = requireString(input, 'status', { min: 1, max: 32 });
  if (!(USER_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException(`status must be one of: ${USER_STATUSES.join(', ')}`);
  }
  if (status === 'active') {
    // Reactivation has its own route: it is a different decision from suspending
    // someone, and it should read differently in the audit log.
    throw new BadRequestException('Use POST /users/:id/reactivate to restore an account.');
  }
  return { status: status as UserStatus, reason: parseReason(body) };
}

/**
 * A status change is evidence (I4), and evidence without a reason is a mystery
 * for whoever reads it during an incident. Required on every lifecycle route.
 */
export function parseReason(body: unknown): string {
  return requireString(asObject(body), 'reason', { min: 3, max: 1000 });
}

export interface SetRoleBody {
  role: Role;
  reason: string;
}

export function parseSetRole(body: unknown): SetRoleBody {
  const input = asObject(body);
  const role = requireString(input, 'role', { min: 1, max: 32 });
  if (!isRole(role)) {
    throw new BadRequestException(`role must be one of: ${ROLES.join(', ')}`);
  }
  return { role, reason: parseReason(body) };
}

export interface InviteTeamMemberBody {
  email: string;
  fullName: string;
  role: Role;
  reason: string;
}

/** FR-IDN-05 — invite a teammate into the CALLER'S tenant (never a new one). */
export function parseInviteTeamMember(body: unknown): InviteTeamMemberBody {
  const input = asObject(body);
  const role = requireString(input, 'role', { min: 1, max: 32 });
  if (!isRole(role)) {
    throw new BadRequestException(`role must be one of: ${ROLES.join(', ')}`);
  }
  return {
    email: requireEmail(input, 'email'),
    fullName: requireString(input, 'fullName', { min: 1, max: 200 }),
    role,
    reason: parseReason(body),
  };
}

export interface AcceptInvitationBody {
  inviteToken: string;
  fullName: string;
  password: string;
}

/** FR-IDN-05 — the invited person completing sign-up. Mirrors registration's
 *  shape exactly, minus an organisation name: the tenant is fixed by the token. */
export function parseAcceptInvitation(body: unknown): AcceptInvitationBody {
  const input = asObject(body);
  return {
    inviteToken: requireString(input, 'inviteToken', { min: 1, max: 4096 }),
    fullName: requireString(input, 'fullName', { min: 1, max: 200 }),
    password: requirePassword(input, 'password'),
  };
}

/**
 * `escalation_contact` joined these when the shared request substrate needed a
 * third rung above the DPO for its escalation ladder (FR-GRV-05). It is the same
 * kind of fact as the other two — one named person per tenant — so it lives in
 * the same place rather than in a request-module table that would duplicate and
 * eventually contradict it. Mirrored by the CHECK on org_designations.
 */
const DESIGNATIONS = ['dpo', 'grievance_officer', 'escalation_contact'] as const;
export type Designation = (typeof DESIGNATIONS)[number];

export interface SetDesignationBody {
  designation: Designation;
  userId: string;
  reason: string;
}

/** FR-IDN-04 — who is THE published DPO / Grievance Officer for this tenant. */
export function parseSetDesignation(body: unknown): SetDesignationBody {
  const input = asObject(body);
  const designation = requireString(input, 'designation', { min: 1, max: 32 });
  if (!(DESIGNATIONS as readonly string[]).includes(designation)) {
    throw new BadRequestException(`designation must be one of: ${DESIGNATIONS.join(', ')}`);
  }
  return {
    designation: designation as Designation,
    userId: requireUuid(input, 'userId'),
    reason: parseReason(body),
  };
}

// --- primitives -------------------------------------------------------------

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
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

function requireEmail(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field, { min: 3, max: 320 }).toLowerCase();
  if (!EMAIL_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a valid email address.`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(input: Record<string, unknown>, field: string): string {
  const value = requireString(input, field, { min: 36, max: 36 });
  if (!UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function requirePassword(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required and must be a string.`);
  }
  // NOT trimmed: leading/trailing spaces are legitimate password characters, and
  // silently eating them means the password that was set is not the one the user
  // typed. (Length is measured on the real value for the same reason.)
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    throw new BadRequestException(
      `${field} must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`,
    );
  }
  return value;
}
