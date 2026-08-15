import { ConfigService } from '@nestjs/config';
import { TokenService } from '../identity/token.service';

/**
 * The device token proves device identity for control-plane calls. It is a
 * `gateway_device` JWT signed by the platform secret — it carries a verified
 * tenant_id (→ RLS) and the enrolling actor, and NEVER a private key or a secret.
 */
function tokenService(overrides: Record<string, string> = {}): TokenService {
  const values: Record<string, string> = { JWT_SECRET: 'test-secret-abc', ...overrides };
  return new TokenService({ get: (k: string) => values[k] } as unknown as ConfigService);
}

describe('Phase 3C — gateway_device token', () => {
  it('1. a freshly minted device token verifies and returns its claims', () => {
    const svc = tokenService();
    const { token } = svc.mintGatewayDeviceToken({ deviceId: 'dev-1', tenantId: 'ten-1', actorUserId: 'user-1' });
    expect(svc.verifyGatewayDeviceToken(token)).toEqual({
      deviceId: 'dev-1',
      tenantId: 'ten-1',
      actorUserId: 'user-1',
    });
  });

  it('a tampered token is rejected', () => {
    const svc = tokenService();
    const { token } = svc.mintGatewayDeviceToken({ deviceId: 'dev-1', tenantId: 'ten-1', actorUserId: 'user-1' });
    expect(() => svc.verifyGatewayDeviceToken(token + 'x')).toThrow();
  });

  it('a token signed with a different secret is rejected', () => {
    const a = tokenService({ JWT_SECRET: 'secret-a' });
    const b = tokenService({ JWT_SECRET: 'secret-b' });
    const { token } = a.mintGatewayDeviceToken({ deviceId: 'dev-1', tenantId: 'ten-1', actorUserId: 'user-1' });
    expect(() => b.verifyGatewayDeviceToken(token)).toThrow();
  });

  it('an access token cannot be presented as a device token (typ is enforced)', () => {
    const svc = tokenService();
    const access = svc.mintAccessToken({ userId: 'u', tenantId: 't', role: 'owner' }).accessToken;
    expect(() => svc.verifyGatewayDeviceToken(access)).toThrow();
  });
});
