import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { NotificationDispatcher } from './notification-dispatcher';
import { NotificationDeliveriesRepository } from './notification-deliveries.repository';

/**
 * The settings surface this prompt adds: is each notification channel really
 * delivering, or falling back to the dev/CI path?
 *
 * Deliberately a GET-only, read-only controller — there is nothing to
 * configure here (the provider is chosen by which env vars are set, not by a
 * form; see NotificationDispatcher's header for why). What this answers is
 * "what is actually true right now", sourced from the dispatcher's own
 * resolved configuration and from real recorded attempts, never from a static
 * description of what Prompt 25/this prompt intended.
 */
@Controller('notify/channels')
@UseGuards(TenantGuard)
@Roles('owner', 'dpo', 'compliance_officer')
export class NotificationChannelsController {
  constructor(
    private readonly dispatcher: NotificationDispatcher,
    private readonly deliveries: NotificationDeliveriesRepository,
  ) {}

  @Get('status')
  async status() {
    const channels = await Promise.all(
      this.dispatcher.channelStatuses().map(async (status) => {
        const recent = await this.deliveries.listRecent(status.channel, 10);
        return {
          channel: status.channel,
          configured: status.configured,
          provider: status.provider,
          fallback: status.fallback ?? null,
          recentDeliveries: recent.map((d) => ({
            id: d.id,
            kind: d.kind,
            provider: d.provider,
            toMasked: d.to_masked,
            delivered: d.delivered,
            error: d.error,
            occurredAt: d.occurred_at.toISOString(),
          })),
        };
      }),
    );
    return { channels };
  }
}
