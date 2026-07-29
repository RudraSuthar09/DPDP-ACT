import { Injectable } from '@nestjs/common';
import { TenantDatabaseService } from '../../database/database.service';

export interface WebhookConfigRow {
  tenant_id: string;
  url: string | null;
  enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
}

/**
 * Where (and whether) a tenant wants signed consent-change webhooks delivered
 * (FR-CON-07). Ordinary mutable settings — not evidence in the I4 sense the
 * consent log is — so a plain upsert is fine; every change is still recorded
 * in the S5 audit log via the controller's @Audited action.
 */
@Injectable()
export class WebhookConfigRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  get(tenantId: string): Promise<WebhookConfigRow | null> {
    return this.db.withTenantIdDetached(tenantId, async (client) => {
      const { rows } = await client.query<WebhookConfigRow>(
        'SELECT * FROM tenant_webhook_config WHERE tenant_id = $1',
        [tenantId],
      );
      return rows[0] ?? null;
    });
  }

  /** Read under the request's own tenant context (RLS scopes it automatically). */
  getForCurrentTenant(): Promise<WebhookConfigRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<WebhookConfigRow>('SELECT * FROM tenant_webhook_config LIMIT 1');
      return rows[0] ?? null;
    });
  }

  upsert(input: { url: string | null; enabled: boolean; actorId: string | null }): Promise<WebhookConfigRow> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<WebhookConfigRow>(
        `INSERT INTO tenant_webhook_config (url, enabled, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE
           SET url = EXCLUDED.url, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [input.url, input.enabled, input.actorId],
      );
      return rows[0]!;
    });
  }
}
