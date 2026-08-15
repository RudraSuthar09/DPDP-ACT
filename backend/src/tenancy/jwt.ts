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
 *   invite        — an offer to join an EXISTING tenant with a specific role
 *                   (FR-IDN-05), carried between POST /users/invite and
 *                   POST /auth/invitations/accept. Not a session and not a
 *                   challenge: it names no user (none exists yet), only an
 *                   invitation row, a tenant, and an email.
 *
 * An `mfa_challenge` that could be presented as a bearer token would reduce MFA
 * to a suggestion: the attacker with the password would simply skip the second
 * step. `verifyTenantJwt` therefore demands an exact type match and defaults to
 * `access`, so the dangerous case has to be asked for explicitly, by name. The
 * same reasoning is why `invite` cannot verify as anything else: it grants no
 * access on its own, and must never be accepted where a session is expected.
 */
export type TokenType = 'access' | 'mfa_challenge' | 'invite' | 'gateway_device';

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

/**
 * An `invite` token's claims. Shaped differently from `TenantJwtClaims`
 * on purpose: `sub` here is the invitation row's id (there is no user yet), and
 * `email`/`role` are the OFFER the invite carries, not a granted identity — the
 * accept endpoint still re-checks the invitation row itself before trusting it.
 */
export interface InviteJwtClaims {
  invitationId: string;
  tenantId: string;
  email: string;
  role: string;
}

/**
 * A `gateway_device` token's claims. This is how an ENROLLED Local Gateway
 * authenticates its outbound control-plane calls (heartbeat/pair-redeem/session-
 * refresh/deenroll) — the device is not a human, so this is NOT an access token
 * and can never be one. `sub` is the device id; `tenant_id` binds the device to
 * one tenant (read straight into the RLS GUC, same as any other token). `gw_actor`
 * is the staff user who created the enrolment code, used as the audit actor for
 * device-originated actions (a device has no users(id) row of its own).
 *
 * It carries NO private key, NO credential, NO customer value — a bearer JWT
 * signed by the platform secret. Device REVOCATION is enforced by an in-database
 * status check on every call (fail closed), not by this token, because a bearer
 * JWT cannot itself be revoked before expiry.
 */
export interface GatewayDeviceJwtClaims {
  deviceId: string;
  tenantId: string;
  actorUserId: string;
}

/** Verify a gateway_device token. Throws if invalid/expired/wrong type. */
export function verifyGatewayDeviceJwt(token: string, secret: string): GatewayDeviceJwtClaims {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  const decoded = jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  }) as JwtPayload;

  if (decoded.typ !== 'gateway_device') {
    throw new Error(`Expected a gateway_device token, got ${String(decoded.typ)}`);
  }
  const tenantId = decoded.tenant_id;
  const actorUserId = decoded.gw_actor;
  if (
    typeof decoded.sub !== 'string' ||
    !decoded.sub ||
    typeof tenantId !== 'string' ||
    !tenantId ||
    typeof actorUserId !== 'string' ||
    !actorUserId
  ) {
    throw new Error('gateway_device token is missing required claims');
  }
  return { deviceId: decoded.sub, tenantId, actorUserId };
}

/** Verify an invite token. Throws if invalid/expired/wrong type — the same
 *  fail-closed shape as `verifyTenantJwt`. */
export function verifyInviteJwt(token: string, secret: string): InviteJwtClaims {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  const decoded = jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  }) as JwtPayload;

  if (decoded.typ !== 'invite') {
    throw new Error(`Expected an invite token, got ${String(decoded.typ)}`);
  }
  const tenantId = decoded.tenant_id;
  const email = decoded.email;
  const role = decoded.role;
  if (
    typeof decoded.sub !== 'string' ||
    !decoded.sub ||
    typeof tenantId !== 'string' ||
    !tenantId ||
    typeof email !== 'string' ||
    !email ||
    typeof role !== 'string' ||
    !role
  ) {
    throw new Error('Invite token is missing required claims');
  }
  return { invitationId: decoded.sub, tenantId, email, role };
}
