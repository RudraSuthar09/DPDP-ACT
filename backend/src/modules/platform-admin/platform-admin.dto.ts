import { BadRequestException } from '@nestjs/common';

/** Request parsing for the platform-admin module — hand-written and total,
 *  same style as licensing.dto.ts. */

export interface PlatformAdminLoginInput {
  email: string;
  password: string;
}

export function parsePlatformAdminLogin(body: unknown): PlatformAdminLoginInput {
  const obj = asObject(body);
  const email = obj['email'];
  const password = obj['password'];
  if (typeof email !== 'string' || !email.trim()) {
    throw new BadRequestException('email is required.');
  }
  if (typeof password !== 'string' || !password) {
    throw new BadRequestException('password is required.');
  }
  return { email: email.trim().toLowerCase(), password };
}

/** Body of POST …/licenses/:licenseId/reject — a reason is mandatory (I4:
 *  every decision about a customer carries its WHY). Trimmed, 3..500 chars. */
export function parseRejectLicense(body: unknown): { reason: string } {
  const obj = asObject(body);
  const reason = obj['reason'];
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new BadRequestException('A rejection reason of at least 3 characters is required.');
  }
  if (reason.trim().length > 500) {
    throw new BadRequestException('The rejection reason must be at most 500 characters.');
  }
  return { reason: reason.trim() };
}

/** ?limit= for read endpoints: an integer clamped to 1..max, default `fallback`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route-param validation for :tenantId — fails clean (400) instead of
 *  letting a malformed value reach Postgres as a uuid-typed column error. */
export function parseTenantIdParam(tenantId: string): string {
  if (!UUID_RE.test(tenantId)) {
    throw new BadRequestException('tenantId must be a UUID.');
  }
  return tenantId;
}

/** Route-param validation for :licenseId — same reasoning as parseTenantIdParam. */
export function parseLicenseIdParam(licenseId: string): string {
  if (!UUID_RE.test(licenseId)) {
    throw new BadRequestException('licenseId must be a UUID.');
  }
  return licenseId;
}
