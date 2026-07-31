import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { DprRightType, FulfilmentOutcome, FulfilmentRecord } from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { WebhookConfigRepository } from '../notify/webhook-config.repository';
import { WebhookSecretsRepository } from '../notify/webhook-secrets.repository';
import { signWebhookPayload } from '../notify/webhook-signer';
import { RequestService } from '../request/request.service';
import { DPRequestDetailsRepository } from './dprequest-details.repository';
import { FulfilmentRepository, type FulfilmentRow } from './fulfilment.repository';

/** How long we will wait for a client's system. Longer than the consent
 *  webhook's, because this is a synchronous round trip a human is waiting on
 *  and a client assembling a data export legitimately needs longer than a
 *  client acknowledging a notification. */
const FULFILMENT_TIMEOUT_MS = 20_000;

/** A relay is a fallback, not a document store. Anything larger than this is a
 *  client that should be handing over a link instead — and an unbounded read
 *  into process memory from a client-controlled endpoint is a denial-of-service
 *  waiting to happen. */
const MAX_RELAY_BYTES = 2 * 1024 * 1024;

/**
 * TIER 2 (FR-DPR-05) AND THE FULFILMENT WEBHOOKS (FR-DPR-07).
 *
 * ===========================================================================
 * EVERY PLACE CUSTOMER DATA TOUCHES MEMORY IN THIS FILE, AND WHY NONE OF IT
 * REACHES DISK. This list is exhaustive and is the thing to re-verify if this
 * file is ever edited.
 *
 *  1. `res` — the Response object from `fetch` to the client's endpoint.
 *     Streamed, never spooled to a temp file (undici buffers in memory only).
 *  2. `raw` — the response text, in `relayValues()`. A string in the V8 heap
 *     for the length of one request. It is passed to JSON.parse and returned
 *     up the call stack to the controller, which writes it to the HTTP
 *     response. It is never passed to any repository, any logger, or any
 *     audit annotation.
 *  3. `parsed.data` — the parsed body, returned as `FulfilmentOutcome.data`.
 *     Serialised straight to the requester by Nest. No column exists for it.
 *  4. `parsed.url` — a client-hosted link, returned as `FulfilmentOutcome.url`.
 *     Only its SHA-256 is persisted. See `describeFailure` for why not the URL.
 *
 * The three ways data normally escapes such a function, and how each is closed:
 *
 *   LOGGING     — every `this.logger` call below is passed ids, counts and
 *                 status codes. Grep this file for `logger`: none of them
 *                 interpolates `raw`, `parsed`, or `body`.
 *   ERROR PATHS — a thrown error from `fetch` or `JSON.parse` can carry a
 *                 fragment of the offending payload in its `.message`
 *                 (JSON.parse does exactly this: "Unexpected token }
 *                 in JSON at position 41" is benign, but V8 sometimes quotes
 *                 the source). `describeFailure` therefore never propagates a
 *                 caught error's message when the body was involved — it
 *                 substitutes a fixed string. This is the subtlest leak in the
 *                 feature and the one most likely to be "fixed" by a
 *                 well-meaning change to include more detail.
 *   PERSISTENCE — `FulfilmentRepository` has no method that accepts content.
 *                 See its header.
 *
 * NOTE ON LINK-FIRST. The default contract asks the client to return a link
 * into their own system, so the values never enter this process at all — case
 * (1) carries a URL and nothing else. Relay exists for clients who cannot host
 * one, and is deliberately the weaker, bounded path.
 * ===========================================================================
 */
@Injectable()
export class FulfilmentService {
  private readonly logger = new Logger(FulfilmentService.name);

  constructor(
    private readonly requests: RequestService,
    private readonly details: DPRequestDetailsRepository,
    private readonly fulfilments: FulfilmentRepository,
    private readonly webhookConfig: WebhookConfigRepository,
    private readonly secrets: WebhookSecretsRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * Tier 2: ask the client's system for the actual values behind an access or
   * portability request, and hand back whatever it returns without keeping it.
   */
  async requestValues(ticketId: string, actorUserId: string | null): Promise<FulfilmentOutcome> {
    const { referenceCode, subjectRef, rightType } = await this.requireResolvedTicket(ticketId);
    return this.call({
      ticketId,
      kind: rightType === 'portability' ? 'portability' : 'data_values',
      eventType: 'dpr.values.requested',
      referenceCode,
      subjectRef,
      rightType,
      actorUserId,
      expectValues: true,
    });
  }

  /**
   * FR-DPR-07: on approval, tell the client's system to act — and record ONLY
   * that they confirmed, and when. What was corrected or erased is their
   * business and stays in their systems; the platform's evidence is that it
   * asked, that they answered, and the timestamp of both.
   */
  async requestAction(
    ticketId: string,
    kind: 'correction' | 'erasure',
    actorUserId: string | null,
  ): Promise<FulfilmentOutcome> {
    const { referenceCode, subjectRef, rightType } = await this.requireResolvedTicket(ticketId);
    if (kind === 'correction' && rightType !== 'correction') {
      throw new BadRequestException('This request is not a correction request.');
    }
    if (kind === 'erasure' && rightType !== 'erasure') {
      throw new BadRequestException('This request is not an erasure request.');
    }
    return this.call({
      ticketId,
      kind,
      eventType: `dpr.${kind}.requested`,
      referenceCode,
      subjectRef,
      rightType,
      actorUserId,
      expectValues: false,
    });
  }

  async listForTicket(ticketId: string): Promise<FulfilmentRecord[]> {
    const rows = await this.fulfilments.listForTicket(ticketId);
    return rows.map(toRecord);
  }

  // -------------------------------------------------------------------------

  private async call(input: {
    ticketId: string;
    kind: FulfilmentRow['kind'];
    eventType: string;
    referenceCode: string;
    subjectRef: string;
    rightType: DprRightType;
    actorUserId: string | null;
    expectValues: boolean;
  }): Promise<FulfilmentOutcome> {
    const tenantId = this.tenantContext.getOrThrow().tenantId;
    const config = await this.webhookConfig.get(tenantId);
    if (!config?.fulfilment_url || !config.fulfilment_enabled) {
      throw new BadRequestException(
        'No fulfilment endpoint is configured for this organisation. Rights requests must be ' +
          'fulfilled manually until one is set.',
      );
    }

    // The OUTBOUND payload contains no customer data: ids, a reference code,
    // and the HMAC'd subject ref the client can resolve on their own side
    // because they hold the customer id that produced it (I2's asymmetry, doing
    // real work here — this is what lets us ask about a person without naming
    // one).
    const payload = {
      eventType: input.eventType,
      ticketId: input.ticketId,
      referenceCode: input.referenceCode,
      subjectRef: input.subjectRef,
      rightType: input.rightType,
      requestedAt: new Date().toISOString(),
      // Tells the client which shape of answer we can accept, so link-first is
      // a documented contract rather than a guess about their capabilities.
      accepts: input.expectValues ? ['link', 'relay'] : ['confirmation'],
    };

    const rawBody = JSON.stringify(payload);
    const secret = await this.secrets.getOrCreate(tenantId);
    const { header } = signWebhookPayload(secret, rawBody);

    // Opened before the call so a request that leaves the building is on the
    // record even if this process dies mid-flight.
    const record = await this.fulfilments.open({
      ticketId: input.ticketId,
      kind: input.kind,
      requestSignature: header,
      requestPayloadSha256: sha256(rawBody),
      requestedBy: input.actorUserId,
    });

    let res: Response;
    try {
      res = await fetch(config.fulfilment_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DPDP-Webhook-Signature': header,
          'X-DPDP-Fulfilment-Id': record.id,
        },
        body: rawBody,
        signal: AbortSignal.timeout(FULFILMENT_TIMEOUT_MS),
      });
    } catch (err) {
      // A transport error. No response body exists yet, so the message is
      // safe to keep — it is DNS/TLS/timeout text, not client content.
      const reason = err instanceof Error ? err.message : 'Transport failure';
      await this.fail(record.id, null, reason);
      return this.outcome(record, 'failed', null, { failureReason: reason });
    }

    if (!res.ok) {
      // Deliberately NOT reading res.text() here. An error page from the
      // client's system can contain anything — including a stack trace with a
      // customer row in it — and there is no reason to pull it into memory to
      // record a status code.
      const reason = `Fulfilment endpoint responded ${res.status}`;
      await this.fail(record.id, res.status, reason);
      return this.outcome(record, 'failed', res.status, { failureReason: reason });
    }

    return input.expectValues
      ? this.relayValues(record, res, input)
      : this.recordConfirmation(record, res, input);
  }

  /**
   * The one method in the platform through which a customer's actual data
   * passes. Everything it does is designed to be auditable by reading it.
   */
  private async relayValues(
    record: FulfilmentRow,
    res: Response,
    input: { ticketId: string; referenceCode: string; subjectRef: string },
  ): Promise<FulfilmentOutcome> {
    const raw = await this.readBounded(res);
    if (raw === null) {
      const reason = `Response exceeded the ${MAX_RELAY_BYTES}-byte relay limit; return a link instead.`;
      await this.fail(record.id, res.status, reason);
      return this.outcome(record, 'failed', res.status, { failureReason: reason });
    }

    let parsed: { mode?: string; url?: string; expiresAt?: string; data?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      // The caught error is DISCARDED, not reported. JSON.parse messages can
      // quote the offending source text, and the offending source text here is
      // somebody's personal data. A fixed string is the whole of what is safe.
      const reason = 'Fulfilment endpoint returned a body that is not valid JSON.';
      await this.fail(record.id, res.status, reason);
      return this.outcome(record, 'failed', res.status, { failureReason: reason });
    }

    // LINK MODE — preferred. The values never entered this process; only an
    // address did, and only its hash is kept.
    if (parsed.mode === 'link' && typeof parsed.url === 'string') {
      const expiresAt = parsed.expiresAt ? new Date(parsed.expiresAt) : null;
      await this.fulfilments.complete(record.id, {
        status: 'confirmed',
        responseKind: 'link',
        responseStatusCode: res.status,
        // The URL itself is NOT stored. A client-hosted link is free-form and
        // may well carry an account number in a query string; the platform
        // cannot police that, so it keeps only enough to prove which link was
        // handed over.
        deliveryUrlSha256: sha256(parsed.url),
        linkExpiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
        relayedBytes: null,
        failureReason: null,
      });
      this.annotate(input.ticketId, record, 'link', {
        referenceCode: input.referenceCode,
        subjectRef: input.subjectRef,
      });
      return {
        ...this.outcome(record, 'confirmed', res.status, {}),
        responseKind: 'link',
        confirmedAt: new Date().toISOString(),
        url: parsed.url,
        linkExpiresAt: expiresAt?.toISOString() ?? null,
      };
    }

    // RELAY MODE — the fallback. `parsed.data` is the person's actual data. It
    // is returned up the stack and serialised to the requester; it is passed to
    // nothing else. The only fact recorded about it is its size.
    const relayedBytes = Buffer.byteLength(raw, 'utf8');
    await this.fulfilments.complete(record.id, {
      status: 'confirmed',
      responseKind: 'relay',
      responseStatusCode: res.status,
      deliveryUrlSha256: null,
      linkExpiresAt: null,
      relayedBytes,
      failureReason: null,
    });
    this.annotate(input.ticketId, record, 'relay', {
      referenceCode: input.referenceCode,
      subjectRef: input.subjectRef,
      relayedBytes,
    });
    return {
      ...this.outcome(record, 'confirmed', res.status, {}),
      responseKind: 'relay',
      confirmedAt: new Date().toISOString(),
      data: parsed.data ?? null,
    };
  }

  /** Correction/erasure: the client acted; we keep the fact and the time. */
  private async recordConfirmation(
    record: FulfilmentRow,
    res: Response,
    input: { ticketId: string; referenceCode: string; subjectRef: string },
  ): Promise<FulfilmentOutcome> {
    // The confirmation body is read only to learn whether they accepted or
    // declined. Nothing from it is stored — not a reference, not a note. A
    // client's "we erased 4 rows from table X" is their record, not ours.
    const raw = await this.readBounded(res);
    let acknowledged = true;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { status?: string };
        acknowledged = parsed.status !== 'declined';
      } catch {
        // A 2xx with an unreadable body is still an acknowledgement at the
        // transport level. Again: the parse error is discarded, never recorded.
        acknowledged = true;
      }
    }

    const status = acknowledged ? 'confirmed' : 'declined';
    await this.fulfilments.complete(record.id, {
      status,
      responseKind: 'confirmation',
      responseStatusCode: res.status,
      deliveryUrlSha256: null,
      linkExpiresAt: null,
      relayedBytes: null,
      failureReason: acknowledged ? null : 'The client system declined to perform this action.',
    });
    this.annotate(input.ticketId, record, 'confirmation', {
      referenceCode: input.referenceCode,
      subjectRef: input.subjectRef,
      outcome: status,
    });
    return {
      ...this.outcome(record, status, res.status, {}),
      responseKind: 'confirmation',
      confirmedAt: acknowledged ? new Date().toISOString() : null,
    };
  }

  /**
   * Read at most MAX_RELAY_BYTES, returning null if the client sends more.
   *
   * Bounded by reading the stream in chunks rather than calling `res.text()`,
   * because `text()` on a 4 GB response buffers the whole thing before this
   * function could reject it — the limit has to be enforced while reading, not
   * after.
   */
  private async readBounded(res: Response): Promise<string | null> {
    if (!res.body) {
      return '';
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RELAY_BYTES) {
        // Stop pulling and drop what we have. `cancel()` closes the socket so
        // the rest is never transferred.
        await reader.cancel().catch(() => undefined);
        chunks.length = 0;
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async fail(fulfilmentId: string, statusCode: number | null, reason: string): Promise<void> {
    await this.fulfilments.complete(fulfilmentId, {
      status: 'failed',
      responseKind: null,
      responseStatusCode: statusCode,
      deliveryUrlSha256: null,
      linkExpiresAt: null,
      relayedBytes: null,
      failureReason: reason.slice(0, 500),
    });
    // Ids and a reason built from transport facts only — see the file header.
    this.logger.warn(`Fulfilment ${fulfilmentId} failed: ${reason}`);
  }

  private annotate(
    ticketId: string,
    record: FulfilmentRow,
    responseKind: string,
    extra: Record<string, unknown>,
  ): void {
    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticketId,
      reason: `Fulfilment ${record.kind} completed via ${responseKind}`,
      // Counts, ids, hashes, a subject ref. No values — the audit log is read
      // by more people than the database is, and is the last place customer
      // data should turn up.
      afterState: { fulfilmentId: record.id, kind: record.kind, responseKind, ...extra },
    });
  }

  private outcome(
    record: FulfilmentRow,
    status: FulfilmentOutcome['status'],
    _statusCode: number | null,
    extra: Partial<FulfilmentOutcome>,
  ): FulfilmentOutcome {
    return {
      fulfilmentId: record.id,
      kind: record.kind,
      status,
      responseKind: null,
      confirmedAt: null,
      ...extra,
    };
  }

  private async requireResolvedTicket(
    ticketId: string,
  ): Promise<{ referenceCode: string; subjectRef: string; rightType: DprRightType }> {
    const ticket = await this.requests.detail(ticketId);
    if (ticket.ticket.requestType !== 'dprequest') {
      throw new NotFoundException('Rights request not found.');
    }
    const detail = await this.details.find(ticketId);
    if (!detail) {
      throw new NotFoundException('Rights request not found.');
    }
    if (!detail.subject_ref) {
      throw new BadRequestException(
        'Resolve this request’s subject reference first (FR-DPR-02) — the client system is ' +
          'asked about a subject ref, and there is nothing to ask about until one exists.',
      );
    }
    return {
      referenceCode: ticket.ticket.referenceCode,
      subjectRef: detail.subject_ref,
      rightType: detail.right_type,
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toRecord(row: FulfilmentRow): FulfilmentRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    responseKind: row.response_kind,
    requestSignature: row.request_signature,
    requestPayloadSha256: row.request_payload_sha256,
    deliveryUrlSha256: row.delivery_url_sha256,
    relayedBytes: row.relayed_bytes,
    requestedAt: row.requested_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
  };
}
