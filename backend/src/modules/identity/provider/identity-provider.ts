import type { ModuleArea, Role } from '@dpdp/shared';
import type { AccessToken } from '../token.service';
import type { ProductTourStatus } from '../users.repository';

/**
 * The identity seam (FR-IDN-01/02/03).
 *
 * Stage 1 implements this in-app (`LocalIdentityProvider`). It is an interface
 * because Stage 2 brings SSO/SCIM (FR-IDN-06), and that is the point at which a
 * Keycloak or WorkOS adapter earns its keep — at which time it implements this
 * and nothing above it changes.
 *
 * Why not adopt Keycloak/Auth0 now: Stage 1 deploys as exactly two containers
 * (app + worker), and Keycloak is a third — plus a realm-per-tenant provisioning
 * story we do not need before we have tenants. Auth0 means shipping our clients'
 * staff directory to a third party, on the product whose entire premise is that
 * compliance data lives here. R1 says do not cross a stage boundary without a
 * trigger metric; "the first prospect asked for SAML" is that metric, and when
 * it arrives, this interface is where the swap happens.
 *
 * ---------------------------------------------------------------------------
 * MFA IS NOT OPTIONAL IN THIS CONTRACT.
 * There is deliberately no operation that returns an access token in exchange
 * for a password. `authenticate()` returns a CHALLENGE; only `completeMfa()` and
 * `confirmMfaEnrolment()` mint sessions. A future implementation that hands back
 * a token from a password alone is not implementing this interface — it is
 * silently deleting FR-IDN-02.
 * ---------------------------------------------------------------------------
 */
export interface IdentityProvider {
  /**
   * FR-IDN-01 — organisation self-registration. Provisions the tenant, its
   * workspace (all five module areas), and the Owner, atomically.
   */
  registerOrganisation(input: RegisterOrganisationInput): Promise<RegisteredOrganisation>;

  /**
   * FR-IDN-02, step 1 — email + password. Never returns a session: the outcome
   * is always a challenge or a failure.
   */
  authenticate(input: AuthenticateInput): Promise<AuthenticationResult>;

  /** FR-IDN-02, step 2 — a TOTP code (or a recovery code) for an enrolled user. */
  completeMfa(input: CompleteMfaInput): Promise<AccessToken>;

  /** FR-IDN-02 — start TOTP enrolment: returns the secret as an otpauth:// URI. */
  beginMfaEnrolment(subject: ChallengeSubject): Promise<MfaEnrolment>;

  /**
   * FR-IDN-02 — prove the authenticator works before we start demanding codes
   * from it. Returns the session AND the one-time recovery codes.
   */
  confirmMfaEnrolment(input: CompleteMfaInput): Promise<MfaEnrolmentConfirmed>;

  /**
   * FR-IDN-05 — the invited person completing sign-up. Structurally identical
   * to `registerOrganisation` (hash the password, create the user, provision
   * nothing else, mint an MFA enrolment token) EXCEPT it never mints a tenant:
   * the tenant is fixed by the invite token, and the new user joins THAT
   * workspace with the role the invite offered.
   */
  acceptInvitation(input: AcceptInvitationInput): Promise<AcceptedInvitation>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');

export interface RegisterOrganisationInput {
  organisationName: string;
  ownerEmail: string;
  ownerName: string;
  password: string;
}

export interface RegisteredOrganisation {
  /** The tenant id. This is the value that becomes the JWT `tenant_id` claim. */
  tenantId: string;
  organisationName: string;
  ownerUserId: string;
  /** Proof of FR-IDN-01's "all five module areas" — returned so the caller can see it. */
  modules: ModuleArea[];
  /**
   * The workspace exists but has no session yet: the Owner must enrol MFA before
   * the platform will issue one. This token is the only thing that gets them there.
   */
  mfaEnrolmentToken: string;
}

export interface AuthenticateInput {
  email: string;
  password: string;
}

/**
 * The outcome of a password check.
 *
 * `failed` is deliberately opaque — no "unknown email" vs "wrong password" vs
 * "suspended". Each of those is an oracle: the first two enumerate a client's
 * staff, and the third leaks HR events ("she's been suspended") to anyone with
 * an email address. The user gets one message; the audit log gets the detail.
 */
export type AuthenticationResult =
  | { outcome: 'mfa_required'; challengeToken: string }
  | { outcome: 'mfa_enrolment_required'; challengeToken: string }
  | { outcome: 'failed' };

/** A user mid-login: password proven, MFA not yet. Comes from a challenge token. */
export interface ChallengeSubject {
  tenantId: string;
  userId: string;
}

export interface CompleteMfaInput extends ChallengeSubject {
  code: string;
}

export interface MfaEnrolment {
  /** For the QR code. */
  otpauthUri: string;
  /** The same secret, base32 — for "can't scan it?" manual entry. */
  secret: string;
}

export interface MfaEnrolmentConfirmed {
  session: AccessToken;
  /**
   * Shown EXACTLY once — only their hashes are stored. Without these, a lost
   * phone becomes a support ticket that ends with someone turning MFA off over
   * email, which is the whole control defeated at its weakest moment.
   */
  recoveryCodes: string[];
}

export interface AcceptInvitationInput {
  inviteToken: string;
  fullName: string;
  password: string;
}

export interface AcceptedInvitation {
  tenantId: string;
  organisationName: string;
  userId: string;
  role: Role;
  /** Not a session, same as registration: MFA enrolment is not yet proven. */
  mfaEnrolmentToken: string;
}

/** The authenticated user behind a request (GET /auth/me). */
export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: Role;
  organisationName: string;
  /**
   * The tenant's public request-portal identifier (FR-GRV-01). Staff need it to
   * know — and to publish — the address their data principals file grievances
   * at, which is otherwise a fact stored about them that they cannot see.
   *
   * Safe to return here and NOT a credential: it authorises nothing (see
   * portal-tenant.middleware.ts). It is on the profile rather than on a portal
   * endpoint because it is a fact about the caller's own organisation.
   */
  portalSlug: string;
  mfaEnrolled: boolean;
  /**
   * Guided-tour state. On the profile because the shell must decide whether to
   * auto-launch the tour on the very first render, and a second round trip for
   * one enum would just make the tour flash in and out on every page load.
   */
  productTourStatus: ProductTourStatus;
}
