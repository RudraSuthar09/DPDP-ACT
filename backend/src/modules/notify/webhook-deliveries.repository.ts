import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface WebhookDeliveryRow {
  id: string;
  tenant_id: string;
  event_type: string;
  consent_event_id: string;
  subject_ref: string;
  purpose_id: string;
  payload: unknown;
  url: string;
  status: 'pending' | 'success' | 'failed';
  attempt_count: number;
  last_response_code: number | null;
  last_error: string | null;
  created_at: Date;
  last_attempted_at: Date | null;
  delivered_at: Date | null;
}

/**
 * The durable log of every attempted webhook delivery (FR-CON-07). One row per
 * consent-change event, created 'pending' at the moment the event is written
 * (same transaction — see WebhookDeliveryService), then updated by the worker
 * as attempts happen. Prompt 23's settings UI reads this table; this file is
 * the only one that writes it.
 */
@Injectable()
export class WebhookDeliveriesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /**
   * `db.withTenant` JOINS the request's open unit of work when there is one
   * (same mechanism PostgresEventSink relies on) — called from
   * WebhookDeliveryService right after the consent event itself is written,
   * this lands in the SAME transaction as that event and its audit entry. If
   * the request later rolls back for any reason, this row never existed
   * either; there is no path that leaves a delivery intent for an event that
   * was not, in fact, recorded.
   */
  create(input: {
    eventType: string;
    consentEventId: string;
    subjectRef: string;
    purposeId: string;
    payload: unknown;
    url: string;
  }): Promise<WebhookDeliveryRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<WebhookDeliveryRow>(
        `INSERT INTO webhook_deliveries (event_type, consent_event_id, subject_ref, purpose_id, payload, url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [input.eventType, input.consentEventId, input.subjectRef, input.purposeId, input.payload, input.url],
      );
      return rows[0]!;
    });
  }

  findById(tenantId: string, deliveryId: string): Promise<WebhookDeliveryRow | null> {
    return this.db.withTenantIdDetached(tenantId, async (client) => {
      const { rows } = await client.query<WebhookDeliveryRow>(
        'SELECT * FROM webhook_deliveries WHERE id = $1',
        [deliveryId],
      );
      return rows[0] ?? null;
    });
  }

  markAttempt(
    tenantId: string,
    deliveryId: string,
    result: { status: 'success' | 'failed'; responseCode: number | null; error: string | null },
  ): Promise<void> {
    return this.db.withTenantIdDetached(tenantId, async (client) => {
      await client.query(
        `UPDATE webhook_deliveries
            SET status = $2,
                attempt_count = attempt_count + 1,
                last_response_code = $3,
                last_error = $4,
                last_attempted_at = now(),
                delivered_at = CASE WHEN $2 = 'success' THEN now() ELSE delivered_at END
          WHERE id = $1`,
        [deliveryId, result.status, result.responseCode, result.error],
      );
    });
  }

  listRecent(limit: number): Promise<WebhookDeliveryRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<WebhookDeliveryRow>(
        `SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    });
  }
}
