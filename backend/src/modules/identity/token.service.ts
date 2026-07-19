import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { Role } from '@dpdp/shared';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  type InviteJwtClaims,
  type TenantJwtClaims,
  type TokenType,
  verifyInviteJwt,
  verifyTenantJwt,
} from '../../tenancy/jwt';

/**
 * Mints the tokens the rest of the platform trusts.
 *
 * This is the ONLY place a `tenant_id` claim is created. That matters: Seam S1
 * takes `tenant_id` straight from the verified token into the Postgres session
 * GUC that every RLS policy filters on, so this file is the origin of the fact
 * the entire isolation guarantee (I3) rests on. The claim is always read from a
 * database row the caller just authenticated against — never from request input.
 */

export interface TokenSubject {
  userId: string;
  tenantId: string;
  role: Role;
}

export interface AccessToken {
  accessToken: string;
  /** Seconds until expiry — what an OAuth-shaped client expects. */
  expiresIn: number;
  tokenType: 'Bearer';
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly accessTtlSeconds: number;
  private readonly mfaChallengeTtlSeconds: number;
  private readonly inviteTtlSeconds: number;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('JWT_SECRET') ?? '';
    if (!this.secret) {
      throw new Error('JWT_SECRET is required — it signs the tenant claim Seam S1 depends on.');
    }
    // Short-lived by default: this is a bearer token with no revocation list in
    // Stage 1, so its lifetime IS its blast radius. A suspended user keeps a
    // valid token until it expires; 15 minutes bounds that.
    this.accessTtlSeconds = Number(config.get('ACCESS_TOKEN_TTL_SECONDS') ?? 900);
    // Long enough to open an authenticator app, short enough that a stolen
    // half-login is worthless by the time it is used.
    this.mfaChallengeTtlSeconds = Number(config.get('MFA_CHALLENGE_TTL_SECONDS') ?? 300);
    // Long enough that "invite someone on Friday, they join Monday" just works —
    // this is a human waiting on an email/link, not a live login flow. Revocation
    // is the invitations row (status), not a short TTL: see accept-invite.
    this.inviteTtlSeconds = Number(config.get('INVITE_TOKEN_TTL_SECONDS') ?? 7 * 24 * 60 * 60);
  }

  /** A fully authenticated session token: password AND MFA both passed. */
  mintAccessToken(subject: TokenSubject): AccessToken {
    return {
      accessToken: this.sign(subject, 'access', this.accessTtlSeconds),
      expiresIn: this.accessTtlSeconds,
      tokenType: 'Bearer',
    };
  }

  /**
   * The half-finished login handed to the client between password and TOTP.
   * It is NOT a session: `verifyTenantJwt` will refuse it anywhere an access
   * token is expected, so it cannot be used as a bearer token to reach any route.
   */
  mintMfaChallengeToken(subject: TokenSubject): string {
    return this.sign(subject, 'mfa_challenge', this.mfaChallengeTtlSeconds);
  }

  /** Verify the MFA challenge handed back by the client. Throws if not valid. */
  verifyMfaChallengeToken(token: string): TenantJwtClaims {
    return verifyTenantJwt(token, this.secret, 'mfa_challenge');
  }

  /**
   * An offer to join an EXISTING tenant with a specific role (FR-IDN-05).
   * Unlike `mintMfaChallengeToken`, this names no user — `sub` is the
   * invitation row's id, because no user exists until the invite is accepted.
   */
  mintInviteToken(input: {
    invitationId: string;
    tenantId: string;
    email: string;
    role: Role;
  }): string {
    return jwt.sign(
      { tenant_id: input.tenantId, email: input.email, role: input.role, typ: 'invite' },
      this.secret,
      {
        subject: input.invitationId,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: 'HS256',
        expiresIn: this.inviteTtlSeconds,
      },
    );
  }

  /** Verify an invite token. Throws if invalid/expired/wrong type. */
  verifyInviteToken(token: string): InviteJwtClaims {
    return verifyInviteJwt(token, this.secret);
  }

  /**
   * When an invite token minted right now would expire. The `invitations` row
   * stores this too (its `expires_at`), so accept-invite can re-check the ROW
   * even after the JWT itself would still verify — this is the single source
   * for that duration, so the two never drift apart.
   */
  inviteExpiry(): Date {
    return new Date(Date.now() + this.inviteTtlSeconds * 1000);
  }

  private sign(subject: TokenSubject, typ: TokenType, expiresInSeconds: number): string {
    return jwt.sign(
      {
        // The claim Seam S1 reads. Everything downstream — ALS context, the
        // `app.current_tenant` GUC, every RLS policy — follows from this.
        tenant_id: subject.tenantId,
        role: subject.role,
        typ,
      },
      this.secret,
      {
        subject: subject.userId,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: 'HS256',
        expiresIn: expiresInSeconds,
      },
    );
  }
}
