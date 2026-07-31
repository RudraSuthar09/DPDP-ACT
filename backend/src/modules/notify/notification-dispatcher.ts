import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ContactChannel } from '@dpdp/shared';
import { NotificationDeliveriesRepository } from './notification-deliveries.repository';

/**
 * Transactional email/SMS — real providers behind the same seam Prompt 25 laid
 * down, not a parallel notification system.
 *
 * WHAT CHANGED, AND WHAT DID NOT. Prompt 25's console/http pair is unchanged —
 * still here, still the default, still what a laptop with no credentials in
 * its `.env` gets. What is new is two CHANNEL-SPECIFIC real transports, each
 * picked only when its own credentials are actually configured:
 *
 *   EMAIL  Postmark  — POSTMARK_API_KEY (+ POSTMARK_FROM_EMAIL)
 *   SMS    MSG91      — MSG91_AUTH_KEY (+ MSG91_SENDER_ID)
 *
 * Both are called with plain `fetch`, no provider SDK, no new npm dependency —
 * the exact discipline the original file argued for, extended rather than
 * abandoned once a provider was actually named. Both APIs are a single
 * authenticated JSON POST, which is what makes that discipline still hold.
 *
 * WHY POSTMARK OVER SES. SES's API needs AWS SigV4 request signing — real
 * cryptographic work per call, ordinarily reached for through the `aws-sdk`
 * package specifically to avoid hand-rolling it. Postmark authenticates with
 * one static header (`X-Postmark-Server-Token`) over a plain JSON REST
 * endpoint, so "no provider SDK" stays true rather than becoming "no provider
 * SDK, except the one SigV4 needs."
 *
 * WHY MSG91 OVER GUPSHUP. This platform is built for the Indian DPDP Act; MSG91
 * is the standard OTP/transactional SMS provider for the Indian market, with an
 * API shaped for exactly this message (`otp`/`escalation` to an Indian mobile
 * number) authenticated by a single `authkey` header — again one JSON POST,
 * again no SDK. Gupshup's real strength is WhatsApp template management, which
 * this platform has no channel for yet (`ContactChannel` is `'email' | 'sms'`
 * only) — see the note on WhatsApp below.
 *
 * CHANNEL, NOT KIND, PICKS THE PROVIDER. A message's `channel` (email/sms) says
 * which transport it needs; `kind` (otp/escalation/…) is metadata the provider
 * never inspects, in this file or in the ones behind it. That is what makes
 * "OTP delivery" and "urgent escalations" the SAME real SMS path rather than
 * two features to wire separately, and it is why grievance acknowledgements,
 * breach notices, or any future `kind` get the same real delivery for free —
 * they carry a channel already.
 *
 * ON "URGENT ESCALATIONS" SPECIFICALLY: today every escalation resolves to a
 * STAFF member's rung, and staff have no phone number anywhere in the identity
 * model (`users` has no phone column) — only an email. So a real escalation is
 * real Postmark email, not real MSG91 SMS, until staff phone numbers exist as
 * a captured fact. That is a genuine gap, not a shortcut taken here: adding a
 * phone field to the identity model is its own decision (a new column, an
 * invitation-flow field, UI to set and verify it) and is not something to slip
 * in behind a notification-provider prompt. The SMS transport below is fully
 * real and already exercised by OTP delivery, whose contact channel already
 * varies at the requester's own choice.
 *
 * FAILS OPEN TO THE DEV PATH, LOUDLY. If a channel's real credentials are not
 * configured, that channel falls back to the ORIGINAL console/http transport
 * exactly as before — never throws, never silently drops the message — and the
 * chosen transport is stamped onto every `NotificationResult` and logged at
 * boot, so "which path is this environment actually using" is never a guess.
 */

export type NotificationKind = 'otp' | 'escalation' | 'acknowledgement' | 'status_update';

export interface NotificationMessage {
  /** Whose chain a delivery attempt is logged against (`notification_deliveries`).
   *  Required so a worker-fired escalation — which has no ambient tenant
   *  context — can still be attributed correctly; see the two escalation
   *  services, which already carry a tenantId for exactly this reason. */
  tenantId: string;
  channel: ContactChannel;
  to: string;
  subject: string;
  body: string;
  kind: NotificationKind;
  /** Ids only — correlation, never content that could carry personal data
   *  beyond what `to`/`body` already legitimately carry. */
  context?: Record<string, string>;
}

export interface NotificationResult {
  delivered: boolean;
  transport: string;
  error?: string;
}

/** Which transport a channel actually resolved to, and why — what the settings
 *  screen's "configured / not configured" reads off directly, without probing
 *  environment variables of its own. */
export interface ChannelStatus {
  channel: 'email' | 'sms';
  configured: boolean;
  provider: string;
  /** Present only when `configured` is false — the fallback in effect instead. */
  fallback?: string;
}

const HTTP_TIMEOUT_MS = 10_000;

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly genericTransport: string;
  private readonly httpEndpoint: string | undefined;

  private readonly postmarkApiKey: string | undefined;
  private readonly postmarkFromEmail: string | undefined;
  private readonly msg91AuthKey: string | undefined;
  private readonly msg91SenderId: string | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly deliveries: NotificationDeliveriesRepository,
  ) {
    this.genericTransport = (config.get<string>('NOTIFY_TRANSPORT') ?? 'console').trim().toLowerCase();
    this.httpEndpoint = config.get<string>('NOTIFY_HTTP_ENDPOINT');

    this.postmarkApiKey = nonEmpty(config.get<string>('POSTMARK_API_KEY'));
    this.postmarkFromEmail = nonEmpty(config.get<string>('POSTMARK_FROM_EMAIL'));
    this.msg91AuthKey = nonEmpty(config.get<string>('MSG91_AUTH_KEY'));
    this.msg91SenderId = nonEmpty(config.get<string>('MSG91_SENDER_ID'));

    if (this.genericTransport === 'http' && !this.httpEndpoint) {
      // Loud, at boot, rather than a silent fallback to console in production —
      // "we thought the OTPs were going out" is not a discovery to make later.
      this.logger.error(
        'NOTIFY_TRANSPORT=http but NOTIFY_HTTP_ENDPOINT is unset. Notifications will NOT be delivered.',
      );
    }

    for (const status of this.channelStatuses()) {
      this.logger.log(
        status.configured
          ? `Channel ${status.channel}: real provider ${status.provider} configured.`
          : `Channel ${status.channel}: no real provider configured — falling back to ` +
              `${status.fallback} (dev/CI behaviour, unchanged from Prompt 25).`,
      );
    }
  }

  /** What the settings screen shows, verbatim — no probing of its own. */
  channelStatuses(): ChannelStatus[] {
    const email: ChannelStatus =
      this.postmarkApiKey && this.postmarkFromEmail
        ? { channel: 'email', configured: true, provider: 'postmark' }
        : { channel: 'email', configured: false, provider: 'postmark', fallback: this.genericTransport };
    const sms: ChannelStatus =
      this.msg91AuthKey && this.msg91SenderId
        ? { channel: 'sms', configured: true, provider: 'msg91' }
        : { channel: 'sms', configured: false, provider: 'msg91', fallback: this.genericTransport };
    return [email, sms];
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    let result: NotificationResult;
    try {
      if (message.channel === 'email' && this.postmarkApiKey && this.postmarkFromEmail) {
        result = await this.sendPostmark(message);
      } else if (message.channel === 'sms' && this.msg91AuthKey && this.msg91SenderId) {
        result = await this.sendMsg91(message);
      } else if (this.genericTransport === 'http') {
        result = await this.sendHttp(message);
      } else {
        result = this.sendConsole(message);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Notification (${message.kind}) to ${mask(message.to)} failed: ${error}`);
      result = { delivered: false, transport: 'error', error };
    }

    // Best-effort, detached logging for the status screen. A failure to WRITE
    // this row must never turn into a failure to have SENT the message — it is
    // read afterward, on its own connection, and never awaited into the
    // caller's own transaction or success condition.
    this.deliveries
      .record(message.tenantId, {
        channel: message.channel,
        kind: message.kind,
        provider: result.transport,
        toMasked: mask(message.to),
        delivered: result.delivered,
        error: result.error ?? null,
      })
      .catch((err) => {
        this.logger.warn(`Could not record delivery status for ${message.kind}: ${String(err)}`);
      });

    return result;
  }

  /**
   * Real transactional email via Postmark's REST API.
   *
   * One authenticated POST, JSON in, JSON out — no signing, no SDK. Postmark's
   * own error responses come back as 200 with an `ErrorCode`/`Message` pair as
   * often as a 4xx, so both are checked.
   */
  private async sendPostmark(message: NotificationMessage): Promise<NotificationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Postmark-Server-Token': this.postmarkApiKey!,
        },
        body: JSON.stringify({
          From: this.postmarkFromEmail,
          To: message.to,
          Subject: message.subject,
          TextBody: message.body,
          MessageStream: 'outbound',
        }),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as { ErrorCode?: number; Message?: string } | null;
      if (!res.ok || (payload?.ErrorCode && payload.ErrorCode !== 0)) {
        return {
          delivered: false,
          transport: 'postmark',
          error: payload?.Message ?? `Postmark responded ${res.status}`,
        };
      }
      return { delivered: true, transport: 'postmark' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Real transactional SMS via MSG91's REST API.
   *
   * MSG91's send-SMS endpoint takes the auth key as a header and the message as
   * a flat JSON body — the same one-POST shape as Postmark's, deliberately: it
   * is why this file has two real transports and not two different styles of
   * integration.
   *
   * WHATSAPP NOTE: MSG91 also offers a WhatsApp send API under the same
   * authkey, and adding it here later is a third branch in `send()`'s `if`, not
   * a new file — but there is no `ContactChannel` value for it today (only
   * `'email' | 'sms'`), so wiring it now would mean inventing a channel nothing
   * in the request substrate, the portal form, or the database CHECK
   * constraint can select. Left as the next transport, not built ahead of a
   * caller that can reach it.
   */
  private async sendMsg91(message: NotificationMessage): Promise<NotificationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authkey: this.msg91AuthKey!,
        },
        body: JSON.stringify({
          sender: this.msg91SenderId,
          // MSG91's flow API is template-based in production; a tenant without
          // an approved DLT template still gets a working integration via the
          // plain-body fallback most MSG91 accounts have enabled for this
          // endpoint. Recipients as E.164-ish digits, matching what the request
          // substrate's contact-value normalisation already stores.
          mobiles: message.to.replace(/^\+/, ''),
          message: message.body,
        }),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => null)) as { type?: string; message?: string } | null;
      if (!res.ok || payload?.type === 'error') {
        return {
          delivered: false,
          transport: 'msg91',
          error: payload?.message ?? `MSG91 responded ${res.status}`,
        };
      }
      return { delivered: true, transport: 'msg91' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Dev/CI transport. The body — including a one-time code — goes to the process
   * log, which is what makes local development and the end-to-end demo possible
   * without an inbox.
   *
   * That is obviously not acceptable in production, and it is not left to
   * discipline: `isDevOtpEchoEnabled()` below is what the portal consults before
   * it will ever hand a code back over HTTP, and it refuses outright when
   * NODE_ENV is production regardless of configuration.
   */
  private sendConsole(message: NotificationMessage): NotificationResult {
    this.logger.log(
      `[notify:${message.kind}] ${message.channel} -> ${message.to}\n` +
        `  subject: ${message.subject}\n` +
        `  body:    ${message.body}`,
    );
    return { delivered: true, transport: 'console' };
  }

  private async sendHttp(message: NotificationMessage): Promise<NotificationResult> {
    if (!this.httpEndpoint) {
      return { delivered: false, transport: 'http', error: 'NOTIFY_HTTP_ENDPOINT is not set' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(this.httpEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { delivered: false, transport: 'http', error: `relay responded ${response.status}` };
      }
      return { delivered: true, transport: 'http' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Whether the portal may echo a freshly-minted OTP back in its HTTP response.
   *
   * This is the single most dangerous switch in the module — it turns
   * "possession of the mailbox" into "possession of nothing at all" — so it is
   * gated twice and refuses on the safe side of both:
   *   1. NODE_ENV must not be 'production'. A misconfigured NOTIFY_DEV_ECHO_OTP
   *      in production is then inert rather than catastrophic.
   *   2. NOTIFY_DEV_ECHO_OTP must be explicitly 'true'. Off by default, in dev
   *      too, so it is a thing you turn on to run the demo and not a thing you
   *      have to remember to turn off.
   *
   * Unchanged by real providers being configured: a tenant with a live Postmark
   * key almost certainly wants OTPs to stop echoing over HTTP, but that is what
   * NODE_ENV=production is for, not an inference this method makes from
   * provider configuration.
   */
  isDevOtpEchoEnabled(): boolean {
    const nodeEnv = (this.config.get<string>('NODE_ENV') ?? 'development').trim().toLowerCase();
    if (nodeEnv === 'production') {
      return false;
    }
    return (this.config.get<string>('NOTIFY_DEV_ECHO_OTP') ?? '').trim().toLowerCase() === 'true';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Partial redaction for log lines and the delivery-status table: enough to
 *  correlate, not enough to harvest. */
function mask(value: string): string {
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${(local ?? '').slice(0, 2)}***@${domain ?? ''}`;
  }
  return `***${value.slice(-3)}`;
}
