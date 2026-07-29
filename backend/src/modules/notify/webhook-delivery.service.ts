import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConsentEventEnvelope } from '@dpdp/shared';
import { PgBossService } from '../workflow/pgboss.service';
import { WebhookConfigRepository } from './webhook-config.repository';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { WEBHOOK_QUEUE, WEBHOOK_RETRY_LIMIT } from './notify.constants';

/** What a consent-change webhook payload actually contains — the fields a
 *  client's system needs to react to a grant or withdrawal (FR-CON-07). No
 *  raw customer id anywhere in it (I1/I2): subjectRef is the only identifier,
 *  exactly as it is everywhere else consent is read back. */
export interface ConsentChangeNotification {
  eventId: string;
  subjectRef: string;
  purposeId: string;
  purposeName: string | null;
  status: ConsentEventEnvelope['status'];
  noticeVersionId: string | null;
  occurredAt: string;
  recordedAt: string;
  source: ConsentEventEnvelope['source'];
  evidenceHash: string;
  evidenceHashOrigin: ConsentEventEnvelope['evidenceHashOrigin'];
}

/**
 * Schedules a signed webhook delivery for one consent change (FR-CON-07). The
 * consuming half — WebhookDeliveryWorker, which actually signs and POSTs — is
 * NOT here; like WorkflowRunner/WorkflowWorker, it is a provider of
 * WorkerModule only, so the signing secret and the outbound HTTP call never
 * touch the API process.
 *
 * Two things happen, in this order, and only the first is transactional:
 *
 *   1. A 'pending' webhook_deliveries row, via `db.withTenant` — this joins
 *      the SAME unit of work the consent event and its audit entry are in
 *      (Seam S5's interceptor opened it). If that request later fails for any
 *      reason, this row rolls back with everything else.
 *
 *   2. A pg-boss `send()` to the worker — a DIFFERENT connection (pg-boss's
 *      own engine), so it is NOT part of that transaction. This is sent
 *      optimistically, before the enclosing HTTP transaction has committed.
 *
 * KNOWN GAP, same shape as WorkflowRunner's: on the vanishingly rare occasion
 * the transaction rolls back AFTER step 2 (e.g. the audit append itself
 * fails), a pg-boss job exists for a delivery row that no longer does. The
 * worker handles that as "nothing to do", not a crash — see its comment. No
 * reconciliation ticker is built for this in Stage 1; unlike a missed
 * regulatory deadline, a missed consent-change webhook is not itself a
 * compliance breach, so the WorkflowRunner's belt-and-braces sweep was judged
 * not worth building twice for this lower-stakes case.
 */
@Injectable()
export class WebhookDeliveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly pgboss: PgBossService,
    private readonly config: WebhookConfigRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
  ) {}

  /** pg-boss v10 requires the queue to exist before send/work — created here,
   *  on application bootstrap, so it is ready before the first HTTP request
   *  the process serves (OnApplicationBootstrap fires after every module's
   *  OnModuleInit, including PgBossService's — see WorkflowWorker's identical
   *  reasoning for the same ordering guarantee). Idempotent. */
  async onApplicationBootstrap(): Promise<void> {
    await this.pgboss.instance.createQueue(WEBHOOK_QUEUE);
  }

  /**
   * tenantId is required explicitly (rather than read off tenant context)
   * because WebhookConfigRepository.get() is a detached, cross-request-safe
   * read — this method may be called from contexts where the ambient tenant
   * context and the tenant the event belongs to are the same thing, but
   * naming it explicitly keeps the contract honest about whose config is
   * being read.
   */
  async notifyConsentChange(tenantId: string, event: ConsentChangeNotification): Promise<void> {
    const config = await this.config.get(tenantId);
    if (!config?.url || !config.enabled) {
      // Opt-in: no endpoint configured, or the tenant has paused delivery.
      // Nothing to attempt, nothing to log.
      return;
    }

    const eventType = `consent.${event.status.toLowerCase()}`;
    const payload = {
      eventType,
      eventId: event.eventId,
      subjectRef: event.subjectRef,
      purposeId: event.purposeId,
      purposeName: event.purposeName,
      status: event.status,
      noticeVersionId: event.noticeVersionId,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      source: event.source,
      evidenceHash: event.evidenceHash,
      evidenceHashOrigin: event.evidenceHashOrigin,
    };

    const delivery = await this.deliveries.create({
      eventType,
      consentEventId: event.eventId,
      subjectRef: event.subjectRef,
      purposeId: event.purposeId,
      payload,
      url: config.url,
    });

    const sent = await this.pgboss.instance.send(
      WEBHOOK_QUEUE,
      // Ids only (I1) — the worker re-reads the stored payload/url itself.
      { tenantId, deliveryId: delivery.id },
      { retryLimit: WEBHOOK_RETRY_LIMIT, retryBackoff: true },
    );

    if (!sent) {
      this.logger.warn(
        `pg-boss did not accept webhook delivery ${delivery.id}; it will remain 'pending' with no automatic retry.`,
      );
    }
  }
}
