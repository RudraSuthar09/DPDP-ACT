import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { GrievanceService } from './grievance.service';

/** Grievance surface (FR-GRV). The SLA clock is the WorkflowRunner's (S3), never
 *  a countdown computed in this controller. */
@Controller('grievance')
@UseGuards(TenantGuard)
export class GrievanceController {
  constructor(private readonly grievance: GrievanceService) {}

  @Post('tickets')
  @Roles('owner', 'dpo', 'grievance_officer')
  @Audited('grievance.ticket.opened')
  @HttpCode(HttpStatus.CREATED)
  async open(@Body() body: unknown) {
    const value = (body as { slaInSeconds?: unknown } | null)?.slaInSeconds;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 3_155_760_000) {
      throw new BadRequestException('slaInSeconds must be a positive number of seconds.');
    }
    return this.grievance.openTicket(Math.floor(n));
  }
}
