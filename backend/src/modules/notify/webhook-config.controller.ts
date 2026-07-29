import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { Roles, AllowReadOnly } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { WebhookConfigRepository } from './webhook-config.repository';
import { WebhookSecretsRepository } from './webhook-secrets.repository';
import { WebhookDeliveriesRepository } from './webhook-deliveries.repository';
import { parseWebhookConfigInput } from './webhook-config.dto';

/**
 * Settings surface for the FR-CON-07 webhook pipeline — the backend Prompt 23
 * builds its UI against. Not itself a Prompt-23 deliverable; the endpoints
 * exist now because the pipeline they configure exists now, same as every
 * other module's settings have shipped alongside the feature they configure.
 */
@Controller('notify/webhooks')
@UseGuards(TenantGuard)
export class WebhookConfigController {
  constructor(
    private readonly config: WebhookConfigRepository,
    private readonly secrets: WebhookSecretsRepository,
    private readonly deliveries: WebhookDeliveriesRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('config')
  @Roles('owner', 'dpo', 'compliance_officer')
  async getConfig() {
    const row = await this.config.getForCurrentTenant();
    return {
      url: row?.url ?? null,
      enabled: row?.enabled ?? true,
      updatedAt: row?.updated_at ?? null,
    };
  }

  @Put('config')
  @Roles('owner', 'dpo')
  @Audited('notify.webhook_config.updated')
  async setConfig(@Body() body: unknown) {
    const input = parseWebhookConfigInput(body);
    const ctx = this.tenantContext.getOrThrow();
    // Ensure a signing secret exists as soon as a URL is configured, so
    // GET /notify/webhooks/secret never 404s on a tenant that just set one.
    if (input.url) {
      await this.secrets.getOrCreate(ctx.tenantId);
    }
    const row = await this.config.upsert({ url: input.url, enabled: input.enabled, actorId: ctx.userId });
    return { url: row.url, enabled: row.enabled, updatedAt: row.updated_at };
  }

  /**
   * The tenant's own signing secret, in the clear — analogous to showing a
   * TOTP secret during MFA enrolment. Gated to owner/dpo (a step higher than
   * config read) and audited every time, because handing this out is handing
   * out the ability to forge a valid signature.
   *
   * POST, not GET, despite reading and changing nothing — same reasoning as
   * RopaController's export and ConsentProofController's certificate: the S5
   * interceptor only records non-safe HTTP methods, so a GET here would carry
   * an @Audited decorator that silently never fires. Revealing a signing
   * secret is exactly the kind of act that must not go unrecorded.
   */
  @Post('secret/reveal')
  @Roles('owner', 'dpo')
  @AllowReadOnly()
  @Audited('notify.webhook_secret.revealed')
  async revealSecret() {
    const ctx = this.tenantContext.getOrThrow();
    const secret = await this.secrets.getOrCreate(ctx.tenantId);
    return { secret: secret.toString('base64') };
  }

  @Get('deliveries')
  @Roles('owner', 'dpo', 'compliance_officer', 'auditor')
  async listDeliveries(@Query('limit') limit?: string) {
    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await this.deliveries.listRecent(parsedLimit);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        eventType: d.event_type,
        consentEventId: d.consent_event_id,
        subjectRef: d.subject_ref,
        purposeId: d.purpose_id,
        url: d.url,
        status: d.status,
        attemptCount: d.attempt_count,
        lastResponseCode: d.last_response_code,
        lastError: d.last_error,
        createdAt: d.created_at,
        lastAttemptedAt: d.last_attempted_at,
        deliveredAt: d.delivered_at,
      })),
    };
  }
}
