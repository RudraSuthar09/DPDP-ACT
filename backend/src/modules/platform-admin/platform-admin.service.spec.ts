import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PasswordHasher } from '../identity/crypto/password-hasher';
import type { AuditVerifierService } from '../audit/audit-verifier.service';
import type { LicensingService } from '../licensing/licensing.service';
import type { PlatformAdminRepository } from './platform-admin.repository';
import { PlatformAdminService } from './platform-admin.service';

function makeService(opts: { known?: boolean; passwordOk?: boolean } = {}) {
  const repo = {
    resolveLogin: jest.fn(async () => (opts.known === false ? null : { id: 'admin-1', passwordHash: 'h', passwordAlgo: 'scrypt' })),
    touchLastLogin: jest.fn(async () => undefined),
  };
  const hasher = { verify: jest.fn(async () => opts.passwordOk ?? false), hash: jest.fn(async () => 'h') };
  const config = { get: (k: string) => (k === 'JWT_SECRET' ? 'test-secret' : undefined) } as unknown as ConfigService;
  const service = new PlatformAdminService(
    config,
    repo as unknown as PlatformAdminRepository,
    hasher as unknown as PasswordHasher,
    {} as LicensingService,
    {} as AuditVerifierService,
  );
  return { service, repo, hasher };
}

describe('PlatformAdminService.login — rate limiting', () => {
  it('blocks an account after 10 attempts in the window (429), before any hashing', async () => {
    const { service, hasher } = makeService({ passwordOk: false });
    for (let i = 0; i < 10; i += 1) {
      await expect(service.login('admin@example.com', 'wrong', `10.0.0.${i}`)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const calls = hasher.verify.mock.calls.length;
    await expect(service.login('admin@example.com', 'wrong', '10.0.0.99')).rejects.toMatchObject({ status: 429 });
    expect(hasher.verify.mock.calls.length).toBe(calls); // refused before the password check
  });

  it('blocks one source IP after 20 attempts across different accounts', async () => {
    const { service } = makeService({ known: false });
    for (let i = 0; i < 20; i += 1) {
      await expect(service.login(`a${i}@example.com`, 'x', '192.0.2.7')).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const err = await service.login('another@example.com', 'x', '192.0.2.7').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('a correct password still signs in (and records the login) within the limits', async () => {
    const { service, repo } = makeService({ passwordOk: true });
    const session = await service.login('admin@example.com', 'right', '198.51.100.1');
    expect(session.tokenType).toBe('Bearer');
    expect(session.expiresIn).toBe(8 * 60 * 60);
    expect(repo.touchLastLogin).toHaveBeenCalledWith('admin-1');
  });
});
