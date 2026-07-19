import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import type { Role } from '@dpdp/shared';
import { TenantDatabaseService } from '../../../database/database.service';
import { AuditContextService } from '../../audit/audit-context.service';
import { PASSWORD_HASHER, makeDummyHash, type PasswordHasher } from '../crypto/password-hasher';
import { SECRET_CIPHER, type SecretCipher } from '../crypto/secret-cipher';
import { base32Encode } from '../crypto/base32';
import { generateTotpSecret, totpAuthUri, verifyTotp } from '../crypto/totp';
import { TokenService } from '../token.service';
import { UsersRepository, type UserRow } from '../users.repository';
import type {
  AcceptedInvitation,
  AcceptInvitationInput,
  AuthenticateInput,
  AuthenticationResult,
  ChallengeSubject,
  CompleteMfaInput,
  IdentityProvider,
  MfaEnrolment,
  MfaEnrolmentConfirmed,
  RegisterOrganisationInput,
  RegisteredOrganisation,
} from './identity-provider';

/** How many wrong passwords before the account locks, and for how long. */
const LOCK_AFTER_ATTEMPTS = 10;
const LOCK_FOR_SECONDS = 900;
const RECOVERY_CODE_COUNT = 10;

/**
 * The Stage 1, in-app implementation of the identity seam (FR-IDN-01/02/03).
 *
 * The shape of every flow here is the same, and it is the shape Seam S1 forces:
 * resolve the tenant FIRST (from a token, or — at login only — from the
 * peephole), then do all real work inside `withTenantId()`, under RLS, with the
 * tenant bound in Postgres. No branch of this file reads or writes a user row
 * outside a tenant context.
 */
@Injectable()
export class LocalIdentityProvider implements IdentityProvider {
  private readonly logger = new Logger(LocalIdentityProvider.name);
  private readonly issuer: string;
  /** Lazily-built hash used to keep unknown-email logins as slow as real ones. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly db: TenantDatabaseService,
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    // Annotates this request's audit entry (Seam S5). NOT the audit sink — that
    // is not exported from AuditModule and cannot be injected here, which is how
    // R3 ("services never write audit rows") is enforced rather than requested.
    private readonly audit: AuditContextService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher,
    config: ConfigService,
  ) {
    this.issuer = config.get<string>('MFA_ISSUER') ?? 'DPDP Platform';
  }

  // --- FR-IDN-01 — organisation self-registration --------------------------

  async registerOrganisation(input: RegisterOrganisationInput): Promise<RegisteredOrganisation> {
    const passwordHash = await this.hasher.hash(input.password);

    // The tenant id is minted HERE, client-side, before the database is touched.
    // That is what lets sign-up run under the same RLS as everything else: we
    // bind the GUC to the new id and insert the organisation under it. There is
    // no "create the tenant as owner, then switch" path to get wrong.
    const tenantId = randomUUID();

    try {
      const { ownerUserId, modules } = await this.db.withTenantId(tenantId, async (client) => {
        await this.users.insertOrganisation(client, tenantId, input.organisationName.trim());

        // The registrant is always the Owner. Nothing else would make sense: an
        // org with no Owner cannot invite anyone (FR-IDN-05) and is a dead
        // workspace. Every other role arrives by invitation from this one.
        const owner = await this.users.insertUser(client, {
          tenantId,
          email: input.ownerEmail,
          fullName: input.ownerName,
          passwordHash,
          role: 'owner' satisfies Role,
        });

        const provisioned = await this.users.provisionWorkspaceModules(client, tenantId);

        // The first entry in this tenant's chain, appended by the interceptor
        // inside this same transaction. Note actorId: the Owner did not exist
        // when the request arrived, so the request context cannot name the
        // actor — only this code can, and only now.
        this.audit.annotate({
          actorId: owner.id,
          targetType: 'organisation',
          targetId: tenantId,
          reason: 'Organisation self-registration',
          // No before-state: nothing existed. That absence IS the fact.
          beforeState: null,
          afterState: {
            organisationName: input.organisationName.trim(),
            ownerEmail: owner.email,
            ownerRole: owner.role,
            modules: provisioned,
          },
        });

        return { ownerUserId: owner.id, modules: provisioned };
      });

      this.logger.log(`Provisioned tenant ${tenantId} with ${modules.length} module areas`);

      return {
        tenantId,
        organisationName: input.organisationName.trim(),
        ownerUserId,
        modules,
        // NOT a session. Registration ends with MFA still un-enrolled, and the
        // only thing this token opens is the enrolment endpoints (FR-IDN-02).
        mfaEnrolmentToken: this.tokens.mintMfaChallengeToken({
          userId: ownerUserId,
          tenantId,
          role: 'owner',
        }),
      };
    } catch (err) {
      // The whole transaction — organisation, Owner, all five module areas —
      // rolls back together, so a taken email cannot leave a half-built tenant.
      if (isUniqueViolation(err)) {
        throw new ConflictException('An account already exists for that email address.');
      }
      throw err;
    }
  }

  // --- FR-IDN-05 — accepting an invitation into an EXISTING tenant ---------

  async acceptInvitation(input: AcceptInvitationInput): Promise<AcceptedInvitation> {
    let claims;
    try {
      claims = this.tokens.verifyInviteToken(input.inviteToken);
    } catch {
      throw new UnauthorizedException('This invitation link is invalid or has expired.');
    }

    const passwordHash = await this.hasher.hash(input.password);

    try {
      const result = await this.db.withTenantId(claims.tenantId, async (client) => {
        const invitation = await this.users.findInvitationById(client, claims.invitationId);

        // Re-check the ROW, not just the token: this is what makes a revoked
        // invite actually stop working even though the bearer JWT itself
        // remains cryptographically valid until it expires (same reasoning as
        // "removed" users — the credential is not the source of truth).
        if (
          !invitation ||
          invitation.status !== 'pending' ||
          invitation.email !== claims.email ||
          invitation.expires_at.getTime() <= Date.now()
        ) {
          throw new BadRequestException(
            'This invitation is no longer valid. Ask an admin to send a new one.',
          );
        }

        const user = await this.users.insertUser(client, {
          tenantId: claims.tenantId,
          email: invitation.email,
          fullName: input.fullName,
          passwordHash,
          role: invitation.role,
        });
        await this.users.markInvitationAccepted(client, invitation.id, user.id);

        const profile = await this.users.findProfile(client, user.id);

        this.audit.annotate({
          // The invitee performed this action — there is no session to attribute
          // it to otherwise, exactly as with organisation self-registration.
          actorId: user.id,
          actorLabel: user.email,
          targetType: 'invitation',
          targetId: invitation.id,
          reason: `Invitation accepted (invited by user ${invitation.invited_by})`,
          beforeState: { status: 'pending', email: invitation.email, role: invitation.role },
          afterState: { status: 'accepted', userId: user.id },
        });

        return { user, organisationName: profile?.organisation_name ?? '' };
      });

      this.logger.log(`Invitation ${claims.invitationId} accepted by new user ${result.user.id}`);

      return {
        tenantId: claims.tenantId,
        organisationName: result.organisationName,
        userId: result.user.id,
        role: result.user.role,
        // NOT a session — MFA is still unenrolled, same as registerOrganisation.
        mfaEnrolmentToken: this.tokens.mintMfaChallengeToken({
          userId: result.user.id,
          tenantId: claims.tenantId,
          role: result.user.role,
        }),
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('An account already exists for that email address.');
      }
      throw err;
    }
  }

  // --- FR-IDN-02 step 1 — email + password ---------------------------------

  async authenticate(input: AuthenticateInput): Promise<AuthenticationResult> {
    const resolution = await this.db.resolveLogin(input.email);

    // Unknown email: still pay the hashing cost, then fail identically to a
    // wrong password. Skipping this turns response latency into an account
    // -existence oracle for every address an attacker cares to try.
    if (!resolution) {
      await this.burnTime(input.password);
      return { outcome: 'failed' };
    }

    // Suspended/removed users are rejected here, before any password work, and
    // with the same opaque failure as everyone else (never-hard-delete: a
    // `removed` user is a row that exists and can never authenticate again).
    if (resolution.status !== 'active') {
      await this.burnTime(input.password);
      this.logger.warn(`Login attempt on ${resolution.status} account ${resolution.userId}`);
      return { outcome: 'failed' };
    }

    return this.db.withTenantId(resolution.tenantId, async (client) => {
      const user = await this.users.findById(client, resolution.userId);
      if (!user) {
        // The directory says this user exists but RLS says otherwise. Either the
        // trigger is broken or the directory is inconsistent — fail closed, loudly.
        this.logger.error(
          `Directory/RLS mismatch: ${resolution.userId} resolved to tenant ${resolution.tenantId} but is not visible there.`,
        );
        await this.burnTime(input.password);
        return { outcome: 'failed' };
      }

      if (user.locked_until && user.locked_until > new Date()) {
        await this.burnTime(input.password);
        return { outcome: 'failed' };
      }

      const passwordOk = await this.hasher.verify(input.password, user.password_hash);
      if (!passwordOk) {
        await this.recordFailedAttempt(user);
        this.audit.annotate({
          actorId: user.id,
          actorLabel: user.email,
          targetType: 'user',
          targetId: user.id,
          reason: 'Incorrect password',
        });
        return { outcome: 'failed' };
      }

      await this.users.recordSuccessfulLogin(client, user.id);
      await this.rehashIfNeeded(client, user, input.password);

      const subject = { userId: user.id, tenantId: user.tenant_id, role: user.role };
      const challengeToken = this.tokens.mintMfaChallengeToken(subject);

      // A password check that passed is not a session — but it IS an event worth
      // recording: it is the half of a login an attacker with a stolen password
      // can reach, and a run of these against one account is what a breach looks
      // like early. No state goes in before/after: nothing changed but the clock.
      this.audit.annotate({
        actorId: user.id,
        actorLabel: user.email,
        targetType: 'user',
        targetId: user.id,
        reason: user.mfa_enrolled_at
          ? 'Password verified; MFA required'
          : 'Password verified; MFA enrolment required',
      });

      // The password was right — and that is still not a session. The only exit
      // from this method is a challenge (FR-IDN-02).
      return user.mfa_enrolled_at
        ? { outcome: 'mfa_required', challengeToken }
        : { outcome: 'mfa_enrolment_required', challengeToken };
    });
  }

  // --- FR-IDN-02 step 2 — TOTP or recovery code ----------------------------

  async completeMfa(input: CompleteMfaInput): Promise<ReturnType<TokenService['mintAccessToken']>> {
    return this.db.withTenantId(input.tenantId, async (client) => {
      const user = await this.requireActiveUser(client, input.userId);

      if (!user.mfa_enrolled_at || !user.mfa_secret_ciphertext) {
        throw new UnauthorizedException('MFA is not enrolled for this account.');
      }

      const viaTotp = await this.tryTotp(client, user, input.code);
      const viaRecoveryCode = viaTotp
        ? false
        : await this.tryRecoveryCode(client, user, input.code);

      if (!viaTotp && !viaRecoveryCode) {
        await this.recordFailedAttempt(user);
        this.audit.annotate({
          actorId: user.id,
          actorLabel: user.email,
          targetType: 'user',
          targetId: user.id,
          reason: 'Invalid or replayed verification code',
        });
        throw new UnauthorizedException('Invalid verification code.');
      }

      await this.users.recordSuccessfulLogin(client, user.id);

      // Which factor was used matters: a burst of recovery-code logins means
      // either a lost-phone story or someone working through a stolen list.
      this.audit.annotate({
        actorId: user.id,
        actorLabel: user.email,
        targetType: 'user',
        targetId: user.id,
        reason: viaRecoveryCode ? 'Session issued via recovery code' : 'Session issued via TOTP',
        afterState: { factor: viaRecoveryCode ? 'recovery_code' : 'totp' },
      });

      return this.tokens.mintAccessToken({
        userId: user.id,
        tenantId: user.tenant_id,
        role: user.role,
      });
    });
  }

  // --- FR-IDN-02 — TOTP enrolment ------------------------------------------

  async beginMfaEnrolment(subject: ChallengeSubject): Promise<MfaEnrolment> {
    return this.db.withTenantId(subject.tenantId, async (client) => {
      const user = await this.requireActiveUser(client, subject.userId);

      // Re-enrolment is allowed (new phone), and it is safe because the new
      // secret only replaces the old one once a code from it is CONFIRMED —
      // mfa_enrolled_at is cleared by staging and re-set by confirmation.
      const secret = generateTotpSecret();
      await this.users.stageMfaSecret(
        client,
        user.id,
        this.cipher.encrypt(secret, aadFor(user.tenant_id, user.id)),
      );

      // Recorded even though enrolment is not finished: someone starting an
      // enrolment on an account that already had MFA is what an account takeover
      // looks like from the inside. Obviously the secret itself is NOT recorded.
      this.audit.annotate({
        actorId: user.id,
        actorLabel: user.email,
        targetType: 'user',
        targetId: user.id,
        reason: 'TOTP enrolment started',
        beforeState: { mfaEnrolled: user.mfa_enrolled_at !== null },
        afterState: { mfaEnrolled: false, enrolmentPending: true },
      });

      return {
        otpauthUri: totpAuthUri({ secret, account: user.email, issuer: this.issuer }),
        secret: base32Encode(secret),
      };
    });
  }

  async confirmMfaEnrolment(input: CompleteMfaInput): Promise<MfaEnrolmentConfirmed> {
    return this.db.withTenantId(input.tenantId, async (client) => {
      const user = await this.requireActiveUser(client, input.userId);

      if (!user.mfa_secret_ciphertext) {
        throw new UnauthorizedException('Start MFA enrolment before confirming it.');
      }

      const secret = this.decryptSecret(user);
      // lastUsedStep is deliberately not passed: enrolment has no history to
      // replay against, and mfa_last_step was cleared when the secret was staged.
      const result = verifyTotp(secret, input.code);
      if (!result.valid || result.step === undefined) {
        throw new UnauthorizedException('That code did not match. Check your authenticator app.');
      }

      await this.users.markMfaEnrolled(client, user.id, result.step);

      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
        generateRecoveryCode(),
      );
      await this.users.replaceRecoveryCodes(client, {
        tenantId: user.tenant_id,
        userId: user.id,
        hashes: recoveryCodes.map(hashRecoveryCode),
      });

      await this.users.recordSuccessfulLogin(client, user.id);

      this.audit.annotate({
        actorId: user.id,
        actorLabel: user.email,
        targetType: 'user',
        targetId: user.id,
        reason: 'TOTP enrolment confirmed',
        beforeState: { mfaEnrolled: false },
        // The codes themselves are never recorded — only that they were issued.
        afterState: { mfaEnrolled: true, recoveryCodesIssued: RECOVERY_CODE_COUNT },
      });

      return {
        session: this.tokens.mintAccessToken({
          userId: user.id,
          tenantId: user.tenant_id,
          role: user.role,
        }),
        // Returned once, in this response, and never again — only hashes were stored.
        recoveryCodes,
      };
    });
  }

  // --- internals -----------------------------------------------------------

  private async tryTotp(client: PoolClient, user: UserRow, code: string): Promise<boolean> {
    const result = verifyTotp(this.decryptSecret(user), code, {
      lastUsedStep: user.mfa_last_step === null ? null : Number(user.mfa_last_step),
    });
    if (!result.valid || result.step === undefined) {
      return false;
    }
    // Compare-and-set. A valid code that loses this race was already spent by a
    // concurrent request, and a spent code is not a valid one (RFC 6238 §5.2).
    return this.users.consumeMfaStep(client, user.id, result.step);
  }

  private async tryRecoveryCode(client: PoolClient, user: UserRow, code: string): Promise<boolean> {
    const normalised = code.trim().toUpperCase();
    if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(normalised)) {
      return false;
    }
    return this.users.consumeRecoveryCode(client, user.id, hashRecoveryCode(normalised));
  }

  private decryptSecret(user: UserRow): Buffer {
    if (!user.mfa_secret_ciphertext) {
      throw new UnauthorizedException('MFA is not enrolled for this account.');
    }
    return this.cipher.decrypt(user.mfa_secret_ciphertext, aadFor(user.tenant_id, user.id));
  }

  /** Every MFA/enrolment path re-checks status: a challenge token issued a minute
   *  ago must not still work for an account suspended since. */
  private async requireActiveUser(client: PoolClient, userId: string): Promise<UserRow> {
    const user = await this.users.findById(client, userId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Account is not active.');
    }
    return user;
  }

  /**
   * Opportunistic rehash: when policy strengthens, existing users migrate on
   * their next successful login rather than in a big-bang re-hash they cannot
   * have (we do not hold plaintext) or a forced reset they would resent.
   */
  private async rehashIfNeeded(client: PoolClient, user: UserRow, password: string): Promise<void> {
    if (!this.hasher.needsRehash(user.password_hash)) {
      return;
    }
    try {
      const rehashed = await this.hasher.hash(password);
      await client.query('UPDATE users SET password_hash = $2, password_algo = $3 WHERE id = $1', [
        user.id,
        rehashed,
        'scrypt',
      ]);
    } catch (err) {
      // A failed rehash must never fail a valid login — the old hash still works.
      this.logger.warn(`Password rehash failed for ${user.id}: ${String(err)}`);
    }
  }

  /**
   * Increment the lockout counter in its OWN transaction.
   *
   * This must not use the request's unit of work. A rejected login throws, the
   * audit interceptor rolls the request transaction back, and the increment
   * would roll back with it — leaving a lockout that never triggers and a
   * brute-force defence that silently does nothing while every happy-path test
   * still passes. Detached, it survives the rejection, which is the entire point
   * of counting failures. See TenantDatabaseService.withTenantIdDetached.
   */
  private async recordFailedAttempt(user: UserRow): Promise<void> {
    await this.db.withTenantIdDetached(user.tenant_id, (client) =>
      this.users.recordFailedLogin(client, user.id, LOCK_AFTER_ATTEMPTS, LOCK_FOR_SECONDS),
    );
  }

  /** Verify against a throwaway hash purely to spend the same time a real check would. */
  private async burnTime(password: string): Promise<void> {
    this.dummyHash ??= makeDummyHash(this.hasher);
    await this.hasher.verify(password, await this.dummyHash);
  }
}

function aadFor(tenantId: string, userId: string): string {
  // Binds the ciphertext to its row: a TOTP secret copied into another user's
  // record (or another tenant's) fails its auth tag instead of quietly working.
  return `mfa:${tenantId}:${userId}`;
}

/**
 * ~60 bits from a Crockford-ish alphabet (no I/L/O/U — the characters people
 * misread when copying a code off a screen at the worst possible moment).
 */
function generateRecoveryCode(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [chars.slice(0, 4).join(''), chars.slice(4, 8).join(''), chars.slice(8, 12).join('')].join(
    '-',
  );
}

/**
 * SHA-256, unsalted — and that is correct here, unlike for passwords. These
 * codes are 60 bits of uniform randomness that we generated, so there is no
 * dictionary to run and no reuse across sites to exploit; the slow, salted KDF a
 * password needs would buy nothing and cost a second per login attempt across
 * the set. Determinism is also what lets the lookup+burn be one atomic UPDATE.
 */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
