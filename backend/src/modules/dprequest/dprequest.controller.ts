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
import { DPRequestService } from './dprequest.service';

/** DPRequest surface (FR-DPR). The SLA clock is the WorkflowRunner's (S3) —
 *  the same mechanism as Breach's deadline (FR-DPR-03), not a second one. */
@Controller('dprequest')
@UseGuards(TenantGuard)
export class DPRequestController {
  constructor(private readonly dprequest: DPRequestService) {}

  @Post('requests')
  @Roles('owner', 'dpo', 'grievance_officer')
  @Audited('dprequest.request.opened')
  @HttpCode(HttpStatus.CREATED)
  async open(@Body() body: unknown) {
    const value = (body as { slaInSeconds?: unknown } | null)?.slaInSeconds;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 3_155_760_000) {
      throw new BadRequestException('slaInSeconds must be a positive number of seconds.');
    }
    return this.dprequest.openRequest(Math.floor(n));
  }
}
