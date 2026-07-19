import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { BreachService } from './breach.service';

/**
 * Breach surface (FR-BRC). Note what is absent: any deadline arithmetic. The
 * controller opens the incident and cancels on close; the WorkflowRunner (S3)
 * owns the clock. There is no `if (status === ... && daysSince > 3)` here — by
 * construction, not by discipline (R2/R3).
 */
@Controller('breach')
@UseGuards(TenantGuard)
export class BreachController {
  constructor(private readonly breach: BreachService) {}

  @Post('incidents')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('breach.incident.opened')
  @HttpCode(HttpStatus.CREATED)
  async open(@Body() body: unknown) {
    return this.breach.openIncident(parseDueInSeconds(body));
  }

  @Post('incidents/:id/close')
  @Roles('owner', 'dpo', 'compliance_officer')
  @Audited('breach.incident.closed')
  @HttpCode(HttpStatus.OK)
  async close(@Param('id', ParseUUIDPipe) id: string) {
    await this.breach.closeIncident(id);
    return { closed: true };
  }
}

/**
 * The deadline offset, from the caller. In Stage 1 the officer/config supplies it;
 * later it is looked up from a versioned deadline policy (FR-BRC-02). We do NOT
 * hardcode a statutory value here — the Act's Rules change, and a number baked
 * into code is how a platform silently ships a wrong deadline.
 */
export function parseDueInSeconds(body: unknown): number {
  const value = (body as { dueInSeconds?: unknown } | null)?.dueInSeconds;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 3_155_760_000 /* ~100 years */) {
    throw new BadRequestException('dueInSeconds must be a positive number of seconds.');
  }
  return Math.floor(n);
}
