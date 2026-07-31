import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface NotificationDeliveryRow {
  id: string;
  channel: 'email' | 'sms';
  kind: string;
  provider: string;
  to_masked: string;
  delivered: boolean;
  error: string | null;
  occurred_at: Date;
}

/**
 * `notification_deliveries` — recent email/SMS attempts, for the channel
 * status screen. Written best-effort from `NotificationDispatcher.send()`
 * itself, detached from whatever transaction the caller happens to be in: a
 * status-screen row must not roll back because the ticket update around it
 * failed, and must not delay a time-sensitive OTP/escalation send while it
 * waits on a transaction that has nothing to do with it.
 */
@Injectable()
export class NotificationDeliveriesRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  async record(
    tenantId: string,
    input: {
      channel: 'email' | 'sms';
      kind: string;
      provider: string;
      toMasked: string;
      delivered: boolean;
      error: string | null;
    },
  ): Promise<void> {
    await this.db.withTenantIdDetached(tenantId, (client) =>
      client.query(
        `INSERT INTO notification_deliveries (channel, kind, provider, to_masked, delivered, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.channel, input.kind, input.provider, input.toMasked, input.delivered, input.error],
      ),
    );
  }

  /** Most recent attempts for one channel — enough for a status screen's
   *  "recent delivery success/failure" without paging machinery. */
  listRecent(channel: 'email' | 'sms', limit = 20): Promise<NotificationDeliveryRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<NotificationDeliveryRow>(
        `SELECT id, channel, kind, provider, to_masked, delivered, error, occurred_at
           FROM notification_deliveries
          WHERE channel = $1
          ORDER BY occurred_at DESC
          LIMIT $2`,
        [channel, limit],
      );
      return rows;
    });
  }
}
