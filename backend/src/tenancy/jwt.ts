import jwt, { type JwtPayload } from 'jsonwebtoken';

/**
 * The token issuer/audience. Verified on every token, so a token minted for some
 * other service that happens to share the signing secret cannot be replayed here.
 */
export const JWT_ISSUER = 'dpdp-platform';
export const JWT_AUDIENCE = 'dpdp-api';

/**
 * Token types. These are NOT interchangeable, and the distinction is
 * security-critical:
 *
 *   access        — a fully authenticated session. Password AND MFA both passed.
 *   mfa_challenge — password passed, MFA has NOT. It exists only to carry the
 *                   half-finished login between POST /auth/login and
 *                   POST /auth/mfa/verify.
 *
 * An `mfa_challenge` that could be presented as a bearer token would reduce MFA
 * to a suggestion: the attacker with the password would simply skip the second
 * step. `verifyTenantJwt` therefore demands an exact type match and defaults to
 * `access`, so the dangerous case has to be asked for explicitly, by name.
 */
export type TokenType = 'access' | 'mfa_challenge';

/**
 * The claims Seam S1 requires from an authenticated token. `tenant_id` is the
 * claim that binds the whole request to one tenant: it flows from here into
 * AsyncLocalStorage and then into the Postgres `app.current_tenant` GUC, which
 * is what every RLS policy filters on. Everything the platform promises about
 * isolation hangs off this one string being right.
 */
export interface TenantJwtClaims {
  sub: string;
  tenant_id: string;
  role?: string;
  typ: TokenType;
}

/**
 * Verify a bearer token and extract the tenant claims. Throws if the signature
 * is invalid/expired, the issuer/audience is wrong, the token is of the wrong
 * type, or the required claims are absent — the caller turns that into a 401.
 * We never trust an unverified `tenant_id`.
 */
export function verifyTenantJwt(
  token: string,
  secret: string,
  expectedType: TokenType = 'access',
): TenantJwtClaims {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  const decoded = jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    // Pin the algorithm. Without this, a token whose header says {"alg":"none"}
    // (or HS256-signed-with-the-RSA-public-key, if this ever goes asymmetric) is
    // a classic forgery route.
    algorithms: ['HS256'],
  }) as JwtPayload;

  const tenantId = decoded.tenant_id;
  if (typeof tenantId !== 'string' || !tenantId || !decoded.sub) {
    throw new Error('Token is missing required tenant_id / sub claims');
  }
  if (decoded.typ !== expectedType) {
    throw new Error(`Expected a ${expectedType} token, got ${String(decoded.typ)}`);
  }

  return {
    sub: String(decoded.sub),
    tenant_id: tenantId,
    role: typeof decoded.role === 'string' ? decoded.role : undefined,
    typ: expectedType,
  };
}
