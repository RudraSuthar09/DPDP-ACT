import jwt, { type JwtPayload } from 'jsonwebtoken';

/**
 * The claims Seam S1 requires from an authenticated token. In Stage 1 these are
 * minted by the identity provider (Keycloak/Auth0) at login. `tenant_id` is the
 * claim that binds the whole request to one tenant.
 */
export interface TenantJwtClaims {
  sub: string;
  tenant_id: string;
  role?: string;
}

/**
 * Verify a bearer token and extract the tenant claims. Throws if the signature
 * is invalid/expired or the required claims are absent — the caller turns that
 * into a 401. We never trust an unverified `tenant_id`.
 */
export function verifyTenantJwt(token: string, secret: string): TenantJwtClaims {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  const decoded = jwt.verify(token, secret) as JwtPayload;
  const tenantId = decoded.tenant_id;
  if (typeof tenantId !== 'string' || !tenantId || !decoded.sub) {
    throw new Error('Token is missing required tenant_id / sub claims');
  }
  return {
    sub: String(decoded.sub),
    tenant_id: tenantId,
    role: typeof decoded.role === 'string' ? decoded.role : undefined,
  };
}
