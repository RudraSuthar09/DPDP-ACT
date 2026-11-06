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
