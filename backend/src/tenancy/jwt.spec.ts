import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER, verifyTenantJwt } from './jwt';

const SECRET = 'test-secret-not-used-anywhere-real';

function sign(payload: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, SECRET, {
    subject: 'user-1',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: 'HS256',
    expiresIn: 300,
    ...options,
  });
}

/**
 * This file guards the claim the entire product rests on. `tenant_id` from a
 * token here becomes the Postgres `app.current_tenant` GUC, which is what every
 * RLS policy filters on — so a token this function wrongly accepts is not a
 * login bug, it is a cross-tenant breach (I3).
 */
describe('verifyTenantJwt', () => {
  it('accepts a well-formed access token and returns the tenant claim', () => {
    const token = sign({ tenant_id: 'tenant-a', role: 'owner', typ: 'access' });
    expect(verifyTenantJwt(token, SECRET)).toEqual({
      sub: 'user-1',
      tenant_id: 'tenant-a',
      role: 'owner',
      typ: 'access',
    });
  });

  // ------------------------------------------------------------------
  // The one that matters most: an MFA challenge is NOT a session. If this
  // passes as an access token, the second factor is optional — an attacker with
  // only the password takes the challenge from /auth/login and uses it as a
  // bearer token, and FR-IDN-02 is silently gone.
  // ------------------------------------------------------------------
  it('REFUSES an mfa_challenge token where an access token is expected', () => {
    const challenge = sign({ tenant_id: 'tenant-a', role: 'owner', typ: 'mfa_challenge' });
    expect(() => verifyTenantJwt(challenge, SECRET)).toThrow(/Expected a access token/);
  });

  it('refuses an access token where an mfa_challenge is expected', () => {
    const access = sign({ tenant_id: 'tenant-a', role: 'owner', typ: 'access' });
    expect(() => verifyTenantJwt(access, SECRET, 'mfa_challenge')).toThrow(
      /Expected a mfa_challenge/,
    );
  });

  it('refuses a token with no typ claim (a token minted before types existed)', () => {
    expect(() => verifyTenantJwt(sign({ tenant_id: 'tenant-a' }), SECRET)).toThrow(
      /Expected a access/,
    );
  });

  it('refuses a token signed with a different secret', () => {
    const forged = jwt.sign({ tenant_id: 'tenant-b', typ: 'access' }, 'attacker-secret', {
      subject: 'user-1',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: 300,
    });
    expect(() => verifyTenantJwt(forged, SECRET)).toThrow();
  });

  // The classic forgery: an unsigned token whose header claims alg:none.
  it('refuses an alg:none token', () => {
    const unsigned = jwt.sign({ tenant_id: 'tenant-b', typ: 'access', sub: 'user-1' }, '', {
      algorithm: 'none',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    expect(() => verifyTenantJwt(unsigned, SECRET)).toThrow();
  });

  it('refuses an expired token', () => {
    const expired = sign({ tenant_id: 'tenant-a', typ: 'access' }, { expiresIn: -10 });
    expect(() => verifyTenantJwt(expired, SECRET)).toThrow();
  });

  it('refuses a token minted for another issuer or audience', () => {
    expect(() =>
      verifyTenantJwt(
        sign({ tenant_id: 'tenant-a', typ: 'access' }, { issuer: 'somewhere-else' }),
        SECRET,
      ),
    ).toThrow();
    expect(() =>
      verifyTenantJwt(
        sign({ tenant_id: 'tenant-a', typ: 'access' }, { audience: 'another-api' }),
        SECRET,
      ),
    ).toThrow();
  });

  it.each([
    ['missing tenant_id', { typ: 'access' }],
    ['empty tenant_id', { tenant_id: '', typ: 'access' }],
    ['non-string tenant_id', { tenant_id: 12345, typ: 'access' }],
  ])('refuses a token with %s — we never guess a tenant', (_label, payload) => {
    expect(() => verifyTenantJwt(sign(payload), SECRET)).toThrow();
  });

  it('refuses when no signing secret is configured', () => {
    // Fail closed rather than verify everything against an empty string.
    expect(() => verifyTenantJwt(sign({ tenant_id: 'tenant-a', typ: 'access' }), '')).toThrow(
      /secret is not configured/,
    );
  });

  it('ignores an unrecognised role claim rather than trusting it', () => {
    const token = sign({ tenant_id: 'tenant-a', role: 42, typ: 'access' });
    expect(verifyTenantJwt(token, SECRET).role).toBeUndefined();
  });
});
