import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { DashboardService } from './dashboard.service';

/**
 * The compliance dashboard (FR-DSH-01): the counters + recent-activity feed
 * every role lands on. Both routes are GETs, so neither is written to the
 * audit log (see AuditInterceptor.shouldAudit) and neither needs @Audited.
 */
@Controller('dashboard')
@UseGuards(TenantGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Open to every role — a count is not "who did what", just "how much". */
  @Get('summary')
  async summary() {
    return this.dashboard.summary();
  }

  /**
   * Recent activity is a thinned-down read of the audit log, and it still
   * names an actor per entry — so it carries the SAME role restriction as
   * GET /audit (FR-AUD-03's rationale: it is a register of the client's own
   * staff's activity, not just a change list).
   */
  @Get('activity')
  @Roles('owner', 'dpo', 'auditor')
  async activity(@Query('limit') limit?: string) {
    const parsedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    return { entries: await this.dashboard.recentActivity(parsedLimit) };
  }
}
