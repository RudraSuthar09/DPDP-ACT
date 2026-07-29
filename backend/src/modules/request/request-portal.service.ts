import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ANONYMOUS_PORTAL_ACTOR_LABEL,
  type ContactChannel,
  type PortalRequestView,
  type RequestType,
} from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { FixedWindowRateLimiter, type RateLimitRule } from '../../tenancy/fixed-window-rate-limiter';
import { AuditContextService } from '../audit/audit-context.service';
import { NotificationDispatcher } from '../notify/notification-dispatcher';
import { RequestTicketsRepository, type TicketRow } from './request-tickets.repository';
import { RequestVerificationRepository } from './request-verification.repository';
import { RequestSlaService } from './request-sla.service';
import {
  hashOtp,
  maskContact,
  mintOtpCode,
  mintReferenceCode,
  otpMatches,
} from './request-identifiers';
import { signPortalToken } from './portal-token';
import type { SubmitRequestBody } from './dto';

/**
 * THE PUBLIC INTAKE (FR-GRV-01/03/04). Everything a member of the public can
 * cause to happen, with no account and no credential.
 *
 * The flow, and where the line between the platform and the client falls:
 *
 *   1. submit()  — a stranger posts a form. A ticket exists, status `created`,
 *                  and a one-time code goes to the channel they gave. NOTHING
 *                  else has happened: no clock, no task, no notification to
 *                  staff. An unverified submission is a claim, not a request.
 *   2. verify()  — the code comes back. Now the platform knows the channel is
 *                  real, and that is the LAST thing it will ever know about this
 *                  person. It moves the ticket to `contact_verified` and
 *                  immediately to `pending_identity_verification`, opens the
 *                  handoff task, and starts the SLA clock.
 *   3. …and stops. Who this person actually is gets answered by a human at the
 *      Data Fiduciary against their own records (FR-GRV-04). See
 *      RequestService.completeIdentityVerification.
 *
 * ABUSE PROTECTION lives here rather than in a guard, deliberately. Guards run
 * before interceptors in Nest, so a rejection in a guard is invisible to the S5
 * audit interceptor — and "someone tried to file 400 grievances against this
 * tenant" is exactly the kind of thing an audit log should contain. Throwing
 * from inside the handler means every refusal below is recorded with
 * outcome='denied', its source IP, and its correlation id.
 *
 * The crude per-IP cap that protects the database itself is upstream in
 * PortalTenantMiddleware and is NOT audited — see its comment for why writing an
 * audit row per flood request would make the log the amplification target.
 */

/** Bursts. The durable per-contact limit below is what stops a patient attacker. */
const SUBMIT_PER_CONTACT: RateLimitRule = { limit: 3, windowMs: 15 * 60_000 };
const OTP_SEND_PER_TICKET: RateLimitRule = { limit: 5, windowMs: 60 * 60_000 };
const OTP_VERIFY_PER_TICKET: RateLimitRule = { limit: 10, windowMs: 15 * 60_000 };

/** The durable backstop, counted in Postgres so it survives a restart. */
const MAX_TICKETS_PER_CONTACT = 10;
const CONTACT_WINDOW_SECONDS = 24 * 60 * 60;

const OTP_TTL_SECONDS = 10 * 60;
const PORTAL_TOKEN_TTL_SECONDS = 60 * 60;

@Injectable()
export class RequestPortalService {
  private readonly logger = new Logger(RequestPortalService.name);
  private readonly rateLimiter = new FixedWindowRateLimiter();
  private readonly otpSecret: string;
  private readonly jwtSecret: string;

  constructor(
    private readonly db: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly tickets: RequestTicketsRepository,
    private readonly verification: RequestVerificationRepository,
    private readonly slaService: RequestSlaService,
    private readonly notifier: NotificationDispatcher,
    private readonly audit: AuditContextService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.get<string>('JWT_SECRET') ?? '';
    // A dedicated secret if one is configured, otherwise the JWT secret — both
    // are environment-only, which is the property that matters: the OTP hash
    // must not be reversible from a database dump alone.
    this.otpSecret = config.get<string>('REQUEST_OTP_SECRET') ?? this.jwtSecret;
    if (!this.otpSecret) {
      throw new Error(
        'REQUEST_OTP_SECRET (or JWT_SECRET) is required: one-time codes must be stored ' +
          'HMAC-hashed with a secret held outside the database.',
      );
    }
  }

  /**
   * Step 1. A stranger files a request.
   *
   * Everything in one transaction — the ticket, the first correspondence entry,
   * the lifecycle row, the OTP challenge — and the audit interceptor's entry
   * commits with them. A submission the requester was told succeeded is either
   * entirely there, with evidence, or entirely absent.
   */
  async submit(
    input: SubmitRequestBody,
    provenance: { sourceIp: string | null; userAgent: string | null },
  ): Promise<{
    ticketId: string;
    referenceCode: string;
    status: string;
    contactChannel: ContactChannel;
    maskedContact: string;
    otpExpiresAt: string;
    devOtp?: string;
  }> {
    this.labelAnonymous();
    this.enforce('portal_submit_contact', input.contactValue, SUBMIT_PER_CONTACT);

    const result = await this.db.withTenant(async (client) => {
      // The durable half of the limit. Cheap (one indexed count) and, unlike the
      // in-memory window, still true after a deploy.
      const recent = await this.tickets.countRecentByContact(
        client,
        input.contactValue,
        CONTACT_WINDOW_SECONDS,
      );
      if (recent >= MAX_TICKETS_PER_CONTACT) {
        throw new HttpException(
          'This contact has filed too many requests recently. Please contact the organisation directly.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const ticket = await this.tickets.insert(client, {
        requestType: input.requestType,
        referenceCode: mintReferenceCode(input.requestType),
        subject: input.subject,
        contactChannel: input.contactChannel,
        contactValue: input.contactValue,
        sourceIp: provenance.sourceIp,
        userAgent: provenance.userAgent,
      });

      // The submission itself IS the first entry in the append-only
      // correspondence trail — which is why the ticket table has no body column.
      await this.tickets.appendCorrespondence(client, {
        ticketId: ticket.id,
        direction: 'inbound',
        authorType: 'public_submitter',
        authorUserId: null,
        authorLabel: ANONYMOUS_PORTAL_ACTOR_LABEL,
        body: input.body,
      });

      const challenge = await this.issueOtp(client, ticket);
      return { ticket, challenge };
    });

    this.annotateAnonymous({
      action: 'request.submitted',
      ticket: result.ticket,
      reason: 'Request submitted through the public portal; contact verification issued',
      afterState: {
        status: result.ticket.status,
        requestType: result.ticket.request_type,
        contactChannel: result.ticket.contact_channel,
        // Masked in the audit entry too. The log is read by staff and auditors
        // for whom the address is not the point, and an unverified address is
        // not yet a fact about anyone.
        contact: maskContact(result.ticket.contact_channel, result.ticket.contact_value),
      },
    });

    return {
      ticketId: result.ticket.id,
      referenceCode: result.ticket.reference_code,
      status: result.ticket.status,
      contactChannel: result.ticket.contact_channel,
      maskedContact: maskContact(result.ticket.contact_channel, result.ticket.contact_value),
      otpExpiresAt: result.challenge.expiresAt.toISOString(),
      ...(result.challenge.devEcho ? { devOtp: result.challenge.code } : {}),
    };
  }

  /** Step 1b. Resend — same challenge machinery, and it supersedes the old code. */
  async resendOtp(
    ticketId: string,
  ): Promise<{ otpExpiresAt: string; maskedContact: string; devOtp?: string }> {
    this.labelAnonymous();
    this.enforce('portal_otp_send', ticketId, OTP_SEND_PER_TICKET);

    const result = await this.db.withTenant(async (client) => {
      const ticket = await this.requireUnverifiedTicket(client, ticketId);
      const challenge = await this.issueOtp(client, ticket);
      return { ticket, challenge };
    });

    this.annotateAnonymous({
      action: 'request.contact_verification.reissued',
      ticket: result.ticket,
      reason: 'Requester asked for a new one-time code',
    });

    return {
      otpExpiresAt: result.challenge.expiresAt.toISOString(),
      maskedContact: maskContact(result.ticket.contact_channel, result.ticket.contact_value),
      ...(result.challenge.devEcho ? { devOtp: result.challenge.code } : {}),
    };
  }

  /**
   * Step 2. The code comes back — the handoff's first half completes and its
   * second half begins.
   *
   * The wrong-code path is the subtle one. A wrong code must throw (the caller
   * has to be told), and the audit interceptor rolls the request transaction
   * back when a handler throws — which would roll back the attempt counter with
   * it, so the ceiling would never be reached and brute-force protection would
   * be silently absent while every happy-path test still passed. The counter is
   * therefore incremented on a DETACHED transaction that survives the rollback.
   * This is the identical trap the failed-login counter documents, and it is the
   * kind that fails invisibly.
   */
  async verifyContact(
    ticketId: string,
    code: string,
  ): Promise<{ referenceCode: string; status: string; portalToken: string; slaDueAt: string }> {
    this.labelAnonymous();
    this.enforce('portal_otp_verify', ticketId, OTP_VERIFY_PER_TICKET);

    const tenantId = this.tenantContext.getOrThrow().tenantId;

    // Read the challenge on the request's transaction; judge it here.
    const challenge = await this.db.withTenant(async (client) => {
      const ticket = await this.requireUnverifiedTicket(client, ticketId);
      const live = await this.verification.findLiveChallenge(client, ticket.id);
      if (!live) {
        throw new BadRequestException('No verification code is outstanding. Request a new one.');
      }
      return { ticket, live };
    });

    if (challenge.live.expires_at.getTime() <= Date.now()) {
      throw new BadRequestException('That code has expired. Request a new one.');
    }
    if (challenge.live.attempts >= challenge.live.max_attempts) {
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }

    const candidate = hashOtp(this.otpSecret, challenge.ticket.id, code);
    if (!otpMatches(challenge.live.code_hash, candidate)) {
      // Detached, so it outlives the rollback this throw is about to cause.
      const attempts = await this.db.withTenantIdDetached(tenantId, (client) =>
        this.verification.recordFailedAttempt(client, challenge.live.id),
      );
      if (attempts >= challenge.live.max_attempts) {
        await this.db.withTenantIdDetached(tenantId, (client) =>
          this.verification.burnChallenge(client, challenge.live.id),
        );
      }
      this.annotateAnonymous({
        action: 'request.contact_verification.failed',
        ticket: challenge.ticket,
        reason: `Incorrect one-time code (attempt ${attempts} of ${challenge.live.max_attempts})`,
      });
      throw new UnauthorizedException('That code is not correct.');
    }

    const verified = await this.db.withTenant(async (client) => {
      await this.verification.consumeChallenge(client, challenge.live.id);

      // The channel is proved. This is the whole of what the platform verifies.
      const contactVerified = await this.tickets.transition(client, {
        ticketId: challenge.ticket.id,
        expectedFrom: ['created'],
        to: 'contact_verified',
        actorType: 'public_submitter',
        actorUserId: null,
        reason: 'One-time code returned: control of the contact channel proved',
        contactVerified: true,
      });
      if (!contactVerified) {
        throw new BadRequestException('This request has already been verified.');
      }

      // ...and immediately hands the OTHER question to the tenant's own staff.
      // Two transitions rather than one, because they are two different facts
      // and the trail should say so: "we proved the channel" and "we are now
      // waiting on you" are not the same event, and only the second one has an
      // owner who can be chased about it.
      const ticket =
        (await this.tickets.transition(client, {
          ticketId: challenge.ticket.id,
          expectedFrom: ['contact_verified'],
          to: 'pending_identity_verification',
          actorType: 'system',
          actorUserId: null,
          reason:
            'Contact channel verified. Identity match against the Data Fiduciary own customer records is required (FR-GRV-04).',
        })) ?? contactVerified;

      await this.verification.openIdentityTask(client, ticket.id);

      // Only now does a clock start. See RequestSlaService.startClock.
      const { dueAt } = await this.slaService.startClock(client, ticket);

      await this.tickets.appendCorrespondence(client, {
        ticketId: ticket.id,
        direction: 'outbound',
        authorType: 'system',
        authorUserId: null,
        authorLabel: 'platform',
        body:
          `Your contact ${maskContact(ticket.contact_channel, ticket.contact_value)} has been verified. ` +
          `Reference ${ticket.reference_code}. The organisation must now confirm your identity against ` +
          `their own records before responding. Response due by ${dueAt.toISOString()}.`,
      });

      return { ticket, dueAt };
    });

    this.annotateAnonymous({
      action: 'request.contact_verified',
      ticket: verified.ticket,
      reason: 'Contact channel verified by one-time code; identity-verification task opened',
      beforeState: { status: 'created' },
      afterState: {
        status: 'pending_identity_verification',
        slaDueAt: verified.dueAt.toISOString(),
      },
    });

    return {
      referenceCode: verified.ticket.reference_code,
      status: 'pending_identity_verification',
      portalToken: signPortalToken(
        this.jwtSecret,
        { ticketId: verified.ticket.id, tenantId },
        PORTAL_TOKEN_TTL_SECONDS,
      ),
      slaDueAt: verified.dueAt.toISOString(),
    };
  }

  /** What the requester may read back — strictly narrower than the staff view. */
  async portalView(ticketId: string): Promise<PortalRequestView> {
    return this.db.withTenant(async (client) => {
      const ticket = await this.tickets.findById(client, ticketId);
      if (!ticket) {
        throw new NotFoundException('Request not found.');
      }
      const correspondence = await this.tickets.listCorrespondence(client, ticket.id);
      return {
        referenceCode: ticket.reference_code,
        requestType: ticket.request_type as RequestType,
        status: ticket.status,
        subject: ticket.subject,
        contactChannel: ticket.contact_channel,
        contactVerified: ticket.contact_verified_at !== null,
        slaDueAt: ticket.sla_due_at?.toISOString() ?? null,
        createdAt: ticket.created_at.toISOString(),
        // Internal notes are filtered out HERE, at the projection, rather than
        // by a WHERE clause a future query could forget: a staff member's
        // working note about a complainant is not correspondence with them.
        correspondence: correspondence
          .filter((entry) => entry.direction !== 'internal_note')
          .map((entry) => ({
            direction: entry.direction as 'inbound' | 'outbound',
            authorType: entry.author_type,
            body: entry.body,
            createdAt: entry.created_at.toISOString(),
          })),
      };
    });
  }

  /** The requester adds to their own request. Append-only, like everything on
   *  this trail — they cannot edit what they said earlier either (I4). */
  async addRequesterMessage(ticketId: string, body: string): Promise<{ createdAt: string }> {
    this.labelAnonymous();
    const result = await this.db.withTenant(async (client) => {
      const ticket = await this.tickets.findById(client, ticketId);
      if (!ticket) {
        throw new NotFoundException('Request not found.');
      }
      if (ticket.contact_verified_at === null) {
        throw new BadRequestException('Verify your contact channel before adding to this request.');
      }
      const entry = await this.tickets.appendCorrespondence(client, {
        ticketId: ticket.id,
        direction: 'inbound',
        authorType: 'public_submitter',
        authorUserId: null,
        authorLabel: ANONYMOUS_PORTAL_ACTOR_LABEL,
        body,
      });
      return { ticket, entry };
    });

    this.annotateAnonymous({
      action: 'request.correspondence.added',
      ticket: result.ticket,
      reason: 'Requester added a message through the portal',
    });

    return { createdAt: result.entry.created_at.toISOString() };
  }

  // --- internals ------------------------------------------------------------

  private async issueOtp(
    client: import('pg').PoolClient,
    ticket: TicketRow,
  ): Promise<{ code: string; expiresAt: Date; devEcho: boolean }> {
    const code = mintOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

    await this.verification.issueChallenge(client, {
      ticketId: ticket.id,
      channel: ticket.contact_channel,
      // Never the code. HMAC'd with an environment secret so a database dump is
      // not a list of valid codes — see hashOtp.
      codeHash: hashOtp(this.otpSecret, ticket.id, code),
      expiresAt,
    });

    // Best effort, and deliberately not awaited into the transaction's success
    // condition: a mail relay being down must not destroy a submission the
    // requester has already been told about. They can ask for a resend.
    const delivery = await this.notifier.send({
      channel: ticket.contact_channel,
      to: ticket.contact_value,
      subject: `Your verification code for request ${ticket.reference_code}`,
      body:
        `Your one-time verification code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes.\n\n` +
        `Request reference: ${ticket.reference_code}\n` +
        'If you did not make this request, ignore this message.',
      kind: 'otp',
      context: { ticketId: ticket.id },
    });
    if (!delivery.delivered) {
      this.logger.warn(
        `Could not deliver the one-time code for ${ticket.reference_code}: ${delivery.error ?? 'unknown'}`,
      );
    }

    return { code, expiresAt, devEcho: this.notifier.isDevOtpEchoEnabled() };
  }

  private async requireUnverifiedTicket(
    client: import('pg').PoolClient,
    ticketId: string,
  ): Promise<TicketRow> {
    const ticket = await this.tickets.findById(client, ticketId);
    if (!ticket) {
      throw new NotFoundException('Request not found.');
    }
    if (ticket.contact_verified_at !== null) {
      throw new BadRequestException('This request has already been verified.');
    }
    return ticket;
  }

  /**
   * Everything a public submitter does is attributed to nobody, by name.
   *
   * `actor_id` is NULL (the interceptor enforces that for anonymous contexts)
   * and this label is what distinguishes a public submission from a staff action
   * when someone reads the log in three years. Same job and same shape as
   * `consent_sdk:<keyId>` for the SDK — a label where a user id would be, saying
   * exactly what kind of nothing we know.
   */
  /**
   * Stamp the anonymous actor label BEFORE anything that can throw.
   *
   * The refusals are the entries most worth attributing — a rate-limited flood
   * of submissions is precisely the thing someone reviewing this log is looking
   * for — and the audit interceptor records a rejected request using whatever
   * annotation existed at the moment it threw. Annotating only on the success
   * path (as this originally did) left every 429 in the log with a null actor,
   * indistinguishable from an unattributed internal failure. It costs one call
   * at the top of each public entry point; `annotate` merges, so the richer
   * facts added later still land.
   */
  private labelAnonymous(): void {
    this.audit.annotate({ actorLabel: ANONYMOUS_PORTAL_ACTOR_LABEL });
  }

  private annotateAnonymous(input: {
    action: string;
    ticket: TicketRow;
    reason: string;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
  }): void {
    this.audit.annotate({
      action: input.action,
      actorLabel: ANONYMOUS_PORTAL_ACTOR_LABEL,
      targetType: 'request_ticket',
      targetId: input.ticket.id,
      reason: input.reason,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
    });
  }

  private enforce(bucket: string, key: string, rule: RateLimitRule): void {
    const verdict = this.rateLimiter.hit(bucket, key, rule);
    if (!verdict.allowed) {
      throw new HttpException(
        `Too many attempts. Try again in ${verdict.retryAfterSeconds}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
