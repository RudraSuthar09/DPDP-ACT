import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Audited } from '../audit/audited.decorator';
import { TokenService } from './token.service';
import { IdentityService } from './identity.service';
import {
  IDENTITY_PROVIDER,
  type ChallengeSubject,
  type IdentityProvider,
} from './provider/identity-provider';
import { parseChallenge, parseLogin, parseMfa, parseRegisterOrganisation } from './dto';

/**
 * The authentication surface (FR-IDN-01/02).
 *
 * Everything here except GET /auth/me is public by necessity — you cannot
 * present a token to get your first token. Public does not mean unguarded: each
 * route below either mints a tenant context from proven credentials or refuses.
 *
 * The login sequence, and why it has the shape it does:
 *
 *   POST /auth/register  → workspace + Owner + an ENROLMENT challenge
 *   POST /auth/login     → password checked → an MFA challenge. NOT a session.
 *   POST /auth/mfa/enroll  ─┐ (challenge token)
 *   POST /auth/mfa/confirm ─┴→ session + recovery codes
 *   POST /auth/mfa/verify   → session
 *
 * No route returns a session in exchange for a password alone. That is what
 * makes MFA a requirement (FR-IDN-02) rather than a setting.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly identityService: IdentityService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * FR-IDN-01 — organisation self-registration. One call provisions the tenant,
   * its five module areas, and the Owner, atomically.
   */
  @Post('register')
  @Audited('identity.organisation.registered')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown) {
    const input = parseRegisterOrganisation(body);
    const result = await this.identity.registerOrganisation(input);

    return {
      tenantId: result.tenantId,
      organisationName: result.organisationName,
      ownerUserId: result.ownerUserId,
      // Returned so the caller can SEE the workspace is complete (FR-IDN-01),
      // rather than taking our word for it.
      modules: result.modules,
      mfaEnrolmentToken: result.mfaEnrolmentToken,
      nextStep: 'Enrol MFA with POST /auth/mfa/enroll before you can sign in.',
    };
  }

  /** FR-IDN-02 step 1. Always ends in a challenge or an opaque failure. */
  @Post('login')
  @Audited('identity.auth.password_verified')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown) {
    const input = parseLogin(body);
    const result = await this.identity.authenticate(input);

    if (result.outcome === 'failed') {
      // One message for every failure mode — unknown email, wrong password,
      // locked, suspended, removed. Anything more specific is an oracle for
      // enumerating a client's staff (and their HR events).
      throw new UnauthorizedException('Invalid email or password.');
    }

    return {
      outcome: result.outcome,
      challengeToken: result.challengeToken,
      nextStep:
        result.outcome === 'mfa_required'
          ? 'Submit your authenticator code to POST /auth/mfa/verify.'
          : 'MFA is required. Enrol with POST /auth/mfa/enroll.',
    };
  }

  /** FR-IDN-02 — begin TOTP enrolment. Requires a challenge, not a session. */
  @Post('mfa/enroll')
  @Audited('identity.mfa.enrolment_started')
  @HttpCode(HttpStatus.OK)
  async enrollMfa(@Body() body: unknown) {
    const { challengeToken } = parseChallenge(body);
    const subject = this.subjectFromChallenge(challengeToken);
    const enrolment = await this.identity.beginMfaEnrolment(subject);
    return {
      ...enrolment,
      nextStep: 'Scan the URI, then confirm a code with POST /auth/mfa/confirm.',
    };
  }

  /** FR-IDN-02 — prove the authenticator works. Returns the session + recovery codes. */
  @Post('mfa/confirm')
  @Audited('identity.mfa.enrolled')
  @HttpCode(HttpStatus.OK)
  async confirmMfa(@Body() body: unknown) {
    const { challengeToken, code } = parseMfa(body);
    const subject = this.subjectFromChallenge(challengeToken);
    const result = await this.identity.confirmMfaEnrolment({ ...subject, code });
    return {
      ...result.session,
      recoveryCodes: result.recoveryCodes,
      // Said plainly, because this response is the only time these exist.
      recoveryCodesNotice:
        'Store these now. They are shown once and cannot be retrieved — only their hashes are kept.',
    };
  }

  /** FR-IDN-02 step 2 — the second factor. Accepts a TOTP code or a recovery code. */
  @Post('mfa/verify')
  @Audited('identity.auth.session_issued')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(@Body() body: unknown) {
    const { challengeToken, code } = parseMfa(body);
    const subject = this.subjectFromChallenge(challengeToken);
    return this.identity.completeMfa({ ...subject, code });
  }

  /** The authenticated caller. The first thing a UI asks after login. */
  @Get('me')
  @UseGuards(TenantGuard)
  async me() {
    return this.identityService.currentUser();
  }

  /**
   * Turn a challenge token back into a subject.
   *
   * `verifyMfaChallengeToken` demands `typ: 'mfa_challenge'` — an access token
   * will NOT verify here, and (the direction that matters) a challenge token
   * will not verify as an access token anywhere else. The tenant and user come
   * from the signed claims, never from the request body, so a caller cannot
   * complete MFA on behalf of somebody else by editing a field.
   */
  private subjectFromChallenge(token: string): ChallengeSubject {
    try {
      const claims = this.tokens.verifyMfaChallengeToken(token);
      return { tenantId: claims.tenant_id, userId: claims.sub };
    } catch {
      throw new UnauthorizedException('Your sign-in session expired. Please sign in again.');
    }
  }
}
