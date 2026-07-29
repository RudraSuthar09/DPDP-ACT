import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PgBossService } from '../workflow/pgboss.service';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { WebhookSecretsRepository } from './webhook-secrets.repository';
import { signWebhookPayload } from './webhook-signer';
import { WEBHOOK_QUEUE, WEBHOOK_TIMEOUT_MS } from './notify.constants';

interface WebhookJobPayload {
  tenantId: string;
  deliveryId: string;
}

/**
 * The consuming half of the webhook delivery pipeline (FR-CON-07) — registered
 * ONLY in the worker process, exactly like WorkflowWorker: the API schedules,
 * the worker signs and sends. The signing secret (WebhookSecretsRepository)
 * and the outbound `fetch` to a client-controlled URL both live here and
 * nowhere in the API process.
 *
 * Retries are pg-boss's own (WEBHOOK_RETRY_LIMIT, exponential backoff) — this
 * handler just needs to throw on a retriable failure and pg-boss redelivers
 * the same job later. `status` on the delivery row reflects the OUTCOME OF
 * THE MOST RECENT ATTEMPT, not "permanently gave up": a row that reads
 * 'failed' after attempt 2 of 5 will flip back to 'success' if attempt 3
 * lands. `attempt_count` is the running total either way.
 */
@Injectable()
export class WebhookDeliveryWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);

  constructor(
    private readonly pgboss: PgBossService,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly secrets: WebhookSecretsRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Idempotent (pg-boss v10 requires the queue to exist before work()); the
    // API process also creates it, so whichever starts first wins.
    await this.pgboss.instance.createQueue(WEBHOOK_QUEUE);
    await this.pgboss.instance.work<WebhookJobPayload>(WEBHOOK_QUEUE, async (jobs) => {
      for (const job of jobs) {
        await this.deliver(job.data.tenantId, job.data.deliveryId);
      }
    });
    this.logger.log(`Webhook delivery worker up: consuming ${WEBHOOK_QUEUE}`);
  }

  private async deliver(tenantId: string, deliveryId: string): Promise<void> {
    const delivery = await this.deliveries.findById(tenantId, deliveryId);
    if (!delivery) {
      // The KNOWN GAP documented on WebhookDeliveryService: the enclosing HTTP
      // transaction was sent to pg-boss optimistically and then rolled back.
      // Nothing to do — there is no delivery to make.
      this.logger.warn(`Webhook delivery ${deliveryId} (tenant ${tenantId.slice(0, 8)}…) not found; skipping.`);
      return;
    }

    const secret = await this.secrets.getOrCreate(tenantId);
    // Sign EXACTLY the bytes stored on the row, not a re-derivation of the
    // payload object — "what we logged" and "what we signed" must be the same
    // JSON text, or the stored record would not actually prove what was sent.
    const rawBody = JSON.stringify(delivery.payload);
    const { header } = signWebhookPayload(secret, rawBody);

    let responseCode: number | null = null;
    let error: string | null = null;
    let ok = false;

    try {
      const res = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DPDP-Webhook-Signature': header,
          'X-DPDP-Webhook-Id': delivery.id,
        },
        body: rawBody,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      responseCode = res.status;
      ok = res.ok;
      if (!ok) {
        error = `Endpoint responded ${res.status}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    await this.deliveries.markAttempt(tenantId, deliveryId, {
      status: ok ? 'success' : 'failed',
      responseCode,
      error,
    });

    if (!ok) {
      this.logger.warn(`Webhook delivery ${deliveryId} attempt failed: ${error}`);
      // Throwing tells pg-boss to retry (WEBHOOK_RETRY_LIMIT, backoff). A
      // deliberate rethrow, not a swallow — the delivery row already has the
      // failure recorded, which is what makes it safe to let pg-boss retry
      // without losing evidence of the earlier attempts.
      throw new Error(error ?? 'Webhook delivery failed');
    }
  }
}
