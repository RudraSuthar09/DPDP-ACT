import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER, verifyTenantJwt } from '../../tenancy/jwt';
import { PlatformAdminGuard } from '../../tenancy/platform-admin.guard';
import { parseLimit, parseRejectLicense } from './platform-admin.dto';

const PLATFORM_ADMIN_TOKEN_TYPE_FOR_TESTS = 'platform_admin';

function signForTests(secret: string, payload: Record<string, unknown>, subject: string): string {
  return jwt.sign(payload, secret, { subject, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256', expiresIn: 300 });
}

/**
 * The admin portal rests on two token types never being interchangeable:
 * a customer's tenant `access` token must not open /platform-admin/*, and a
 * `platform_admin` token must not pass the tenant guard (it carries no
 * tenant, and must never establish one).
 */
const SECRET = 'test-secret-not-used-anywhere-real';

function guardFor(authorization: string | undefined) {
  const guard = new PlatformAdminGuard({ get: () => SECRET } as unknown as ConfigService);
  const req: Record<string, unknown> = { header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { run: () => guard.canActivate(ctx), req };
}

const customerAccess = signForTests(SECRET, { tenant_id: 'tenant-a', role: 'owner', typ: 'access' }, 'user-1');
const platformAdmin = signForTests(SECRET, { email: 'admin@example.com', typ: PLATFORM_ADMIN_TOKEN_TYPE_FOR_TESTS }, 'admin-1');

describe('PlatformAdminGuard — only platform_admin tokens open /platform-admin/*', () => {
  it('accepts a platform_admin token and attaches its claims (no tenant)', () => {
    const { run, req } = guardFor(`Bearer ${platformAdmin}`);
    expect(run()).toBe(true);
    expect(req.platformAdmin).toEqual({ adminId: 'admin-1', email: 'admin@example.com' });
  });

  it('REFUSES an ordinary customer access token (owner role included)', () => {
    expect(guardFor(`Bearer ${customerAccess}`).run).toThrow(UnauthorizedException);
  });

  it('REFUSES other token types and malformed headers', () => {
    for (const typ of ['mfa_challenge', 'invite', 'gateway_device']) {
      const t = signForTests(SECRET, { email: 'admin@example.com', typ, tenant_id: 'tenant-a' }, 'x');
      expect(guardFor(`Bearer ${t}`).run).toThrow(UnauthorizedException);
    }
    expect(guardFor(undefined).run).toThrow(UnauthorizedException);
    expect(guardFor(platformAdmin).run).toThrow(UnauthorizedException); // no "Bearer "
    expect(guardFor('Bearer not-a-jwt').run).toThrow(UnauthorizedException);
  });

  it('REFUSES a platform_admin token signed with another secret, or expired', () => {
    const forged = signForTests('another-secret', { email: 'admin@example.com', typ: 'platform_admin' }, 'admin-1');
    expect(guardFor(`Bearer ${forged}`).run).toThrow(UnauthorizedException);
    const expired = jwt.sign({ email: 'admin@example.com', typ: 'platform_admin' }, SECRET, {
      subject: 'admin-1',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: 'HS256',
      expiresIn: -10,
    });
    expect(guardFor(`Bearer ${expired}`).run).toThrow(UnauthorizedException);
  });
});

describe('a platform_admin token cannot act as a customer session', () => {
  it('verifyTenantJwt (behind TenantGuard) refuses it', () => {
    expect(() => verifyTenantJwt(platformAdmin, SECRET)).toThrow();
  });

  it('even if it were given a tenant_id claim, the type still does not match', () => {
    const withTenant = signForTests(SECRET, { email: 'admin@example.com', typ: 'platform_admin', tenant_id: 'tenant-a' }, 'admin-1');
    expect(() => verifyTenantJwt(withTenant, SECRET)).toThrow(/Expected a access token/);
  });
});

describe('platform-admin request parsing', () => {
  it('a rejection requires a real reason (3..500 chars, trimmed)', () => {
    expect(parseRejectLicense({ reason: '  Duplicate request  ' })).toEqual({ reason: 'Duplicate request' });
    expect(() => parseRejectLicense({})).toThrow();
    expect(() => parseRejectLicense({ reason: '  ' })).toThrow();
    expect(() => parseRejectLicense({ reason: 'no' })).toThrow();
    expect(() => parseRejectLicense({ reason: 42 })).toThrow();
    expect(() => parseRejectLicense({ reason: 'x'.repeat(501) })).toThrow();
    expect(() => parseRejectLicense(null)).toThrow();
  });

  it('limit is clamped to 1..max with a fallback', () => {
    expect(parseLimit(undefined, 100, 500)).toBe(100);
    expect(parseLimit('abc', 100, 500)).toBe(100);
    expect(parseLimit('0', 100, 500)).toBe(1);
    expect(parseLimit('9999', 100, 500)).toBe(500);
    expect(parseLimit('25.7', 100, 500)).toBe(25);
  });
});
