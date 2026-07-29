import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ContactChannel } from '@dpdp/shared';

/**
 * Transactional email/SMS — the half of NotifyModule that was a skeleton until
 * the public request portal needed to actually deliver a one-time code
 * (FR-GRV-01/04) and an escalation alert (FR-GRV-05).
 *
 * DELIBERATELY SMALL. There is no template engine, no queue, no provider SDK and
 * no new npm dependency. Adding a real ESP integration before a single message
 * has ever needed to leave a developer's laptop is exactly the kind of
 * infrastructure R1 exists to stop. What is here is the SEAM: one interface, one
 * dispatcher, two trivial transports. When a paying tenant names a provider,
 * that is a third transport in this file and nothing above it changes.
 *
 *   NOTIFY_TRANSPORT=console  (default)  — log it. Dev, CI, and demos.
 *   NOTIFY_TRANSPORT=http                — POST the message as JSON to
 *                                          NOTIFY_HTTP_ENDPOINT.
 *
 * The `http` transport is the pragmatic escape hatch: it lets ops wire the
 * platform to MSG91, Gupshup, SES, or a Zapier webhook — whatever they already
 * pay for — without this repository taking a dependency on any of them, and
 * without a provider-shaped abstraction nobody has yet had to satisfy twice.
 *
 * Delivery is BEST EFFORT and says so in its return type. An OTP that could not
 * be sent must not roll back the ticket it belongs to (the requester would lose
 * their submission and be told nothing); an escalation that could not be
 * delivered is still an escalation that HAPPENED, and the difference is recorded
 * on the escalation row rather than thrown away.
 */

export type NotificationKind = 'otp' | 'escalation' | 'acknowledgement' | 'status_update';

export interface NotificationMessage {
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

@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly transport: string;
  private readonly httpEndpoint: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.transport = (config.get<string>('NOTIFY_TRANSPORT') ?? 'console').trim().toLowerCase();
    this.httpEndpoint = config.get<string>('NOTIFY_HTTP_ENDPOINT');

    if (this.transport === 'http' && !this.httpEndpoint) {
      // Loud, at boot, rather than a silent fallback to console in production —
      // "we thought the OTPs were going out" is not a discovery to make later.
      this.logger.error(
        'NOTIFY_TRANSPORT=http but NOTIFY_HTTP_ENDPOINT is unset. Notifications will NOT be delivered.',
      );
    }
  }

  async send(message: NotificationMessage): Promise<NotificationResult> {
    try {
      if (this.transport === 'http') {
        return await this.sendHttp(message);
      }
      return this.sendConsole(message);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`Notification (${message.kind}) to ${mask(message.to)} failed: ${error}`);
      return { delivered: false, transport: this.transport, error };
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
    const timer = setTimeout(() => controller.abort(), 10_000);
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
   */
  isDevOtpEchoEnabled(): boolean {
    const nodeEnv = (this.config.get<string>('NODE_ENV') ?? 'development').trim().toLowerCase();
    if (nodeEnv === 'production') {
      return false;
    }
    return (this.config.get<string>('NOTIFY_DEV_ECHO_OTP') ?? '').trim().toLowerCase() === 'true';
  }
}

/** Partial redaction for log lines: enough to correlate, not enough to harvest. */
function mask(value: string): string {
  if (value.includes('@')) {
    const [local, domain] = value.split('@');
    return `${(local ?? '').slice(0, 2)}***@${domain ?? ''}`;
  }
  return `***${value.slice(-3)}`;
}
