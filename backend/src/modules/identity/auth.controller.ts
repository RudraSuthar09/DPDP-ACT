import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowReadOnly } from './rbac/roles.decorator';
import { Audited, NoAudit } from '../audit/audited.decorator';
import { TokenService } from './token.service';
import { IdentityService } from './identity.service';
import {
  IDENTITY_PROVIDER,
  type ChallengeSubject,
  type IdentityProvider,
} from './provider/identity-provider';
import {
  parseAcceptInvitation,
  parseChallenge,
  parseLogin,
  parseMfa,
  parseRegisterOrganisation,
} from './dto';

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
      // This organisation's own license — shown ONCE, here, at issuance. Use
      // it to activate DPDP's first installation (POST /installations); it is
      // never retrievable again after this response (only its hash/prefix
      // are persisted).
      license: result.license,
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

  /**
   * FR-IDN-05 — the invited person completing sign-up. Public, like register:
   * you cannot present a token to get your first token. Ends in the SAME
   * MFA-enrolment token shape registration does, so the client drives it
   * through the identical enroll → confirm screens.
   */
  @Post('invitations/accept')
  @Audited('identity.invitation.accepted')
  @HttpCode(HttpStatus.OK)
  async acceptInvitation(@Body() body: unknown) {
    const input = parseAcceptInvitation(body);
    const result = await this.identity.acceptInvitation(input);
    return {
      tenantId: result.tenantId,
      organisationName: result.organisationName,
      userId: result.userId,
      role: result.role,
      mfaEnrolmentToken: result.mfaEnrolmentToken,
      nextStep: 'Enrol MFA with POST /auth/mfa/enroll before you can sign in.',
    };
  }

  /** The authenticated caller. The first thing a UI asks after login. */
  @Get('me')
  @UseGuards(TenantGuard)
  async me() {
    return this.identityService.currentUser();
  }

  /**
   * Dismiss or complete the guided tour, for the CALLER only (the user id comes
   * from the verified token, never the body).
   *
   * Two deliberate decorators:
   *
   * `@NoAudit()` — the S5 chain is the tenant's compliance evidence. "Someone
   * clicked Skip on a walkthrough" is interface state, and every such row
   * dilutes the log a regulator actually reads. This is the documented escape
   * hatch for exactly that, and it is greppable.
   *
   * `@AllowReadOnly()` — Auditor and Viewer are read-only roles and this is a
   * PATCH, so the RBAC read-only floor would otherwise refuse it. A read-only
   * user still has to be able to close their own tour; refusing would leave
   * them with a walkthrough that reopens on every single sign-in forever.
   */
  @Patch('me/product-tour')
  @UseGuards(TenantGuard)
  @AllowReadOnly()
  @NoAudit()
  async setProductTour(@Body() body: unknown) {
    const status = (body as { status?: unknown } | null)?.status;
    if (status !== 'completed' && status !== 'skipped') {
      throw new BadRequestException("status must be 'completed' or 'skipped'.");
    }
    return this.identityService.setProductTourStatus(status);
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
