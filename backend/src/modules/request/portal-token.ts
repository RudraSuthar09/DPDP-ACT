import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../tenancy/jwt';

/**
 * The PORTAL TOKEN — what a completed OTP round-trip actually buys.
 *
 * It is a fourth token type alongside access / mfa_challenge / invite (see
 * tenancy/jwt.ts), and it is deliberately NOT verifiable by `verifyTenantJwt`:
 * that function's whole point is that a token minted for one purpose cannot be
 * presented for another, and this one grants something no staff token does —
 * read and reply access to exactly one ticket, held by someone with no account.
 *
 * What it says, and nothing more:
 *   "the holder proved control of the contact channel on ticket X of tenant Y."
 *
 * Note what it does NOT say. It makes no claim about WHO the holder is — that is
 * the question the platform is not allowed to answer (FR-GRV-04, I1) and it is
 * still open at the moment this token is issued. It carries no role, so it can
 * never satisfy an RBAC check, and it names a single ticket, so it cannot be
 * walked sideways to another one.
 *
 * Short-lived on purpose: this is a link a person keeps in an email or a browser
 * tab. If they come back later they verify their channel again, which costs them
 * one OTP and costs an attacker who found the tab a channel they do not control.
 */

const PORTAL_TOKEN_TYPE = 'portal';

export interface PortalTokenClaims {
  ticketId: string;
  tenantId: string;
}

export function signPortalToken(
  secret: string,
  claims: PortalTokenClaims,
  ttlSeconds: number,
): string {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  return jwt.sign(
    { tenant_id: claims.tenantId, typ: PORTAL_TOKEN_TYPE },
    secret,
    {
      subject: claims.ticketId,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithm: 'HS256',
      expiresIn: ttlSeconds,
    },
  );
}

/** Verify a portal token. Fail-closed in the same shape as verifyTenantJwt:
 *  wrong signature, wrong issuer/audience, wrong type, or missing claims all
 *  throw, and the caller turns that into a 401. */
export function verifyPortalToken(token: string, secret: string): PortalTokenClaims {
  if (!secret) {
    throw new Error('JWT secret is not configured');
  }
  const decoded = jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  }) as JwtPayload;

  if (decoded.typ !== PORTAL_TOKEN_TYPE) {
    throw new Error(`Expected a ${PORTAL_TOKEN_TYPE} token, got ${String(decoded.typ)}`);
  }
  const tenantId = decoded.tenant_id;
  if (typeof decoded.sub !== 'string' || !decoded.sub || typeof tenantId !== 'string' || !tenantId) {
    throw new Error('Portal token is missing required claims');
  }
  return { ticketId: decoded.sub, tenantId };
}
