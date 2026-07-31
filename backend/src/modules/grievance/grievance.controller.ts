import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles, AllowReadOnly } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { parseStatusFilter } from '../request/dto';
import { GrievanceService } from './grievance.service';
import { parseGrievanceCategory } from './dto';

/** Same set as `REQUEST_HANDLERS` in `request.controller.ts` — kept as a local
 *  constant rather than imported (that one isn't exported, deliberately: the
 *  substrate doesn't hand out a "who may handle a ticket" list for a
 *  specialising module to inherit, since Breach or a future module could need
 *  a different answer). Grievance's answer happens to be identical today. */
const GRIEVANCE_HANDLERS = ['owner', 'dpo', 'compliance_officer', 'grievance_officer'] as const;

/**
 * The STAFF surface of the Grievance Register (FR-GRV-02/06) — everything
 * generic still goes through `/requests/*` (assign, status, correspondence,
 * identity-verification, escalate: see `request.controller.ts`, unmodified).
 * This controller adds only what is genuinely grievance-specific: reading and
 * setting a complaint's category, and the resolution export.
 */
@Controller('grievance/tickets')
@UseGuards(TenantGuard)
export class GrievanceController {
  constructor(private readonly grievance: GrievanceService) {}

  @Get()
  async list(@Query('status') status?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return {
      tickets: await this.grievance.list({
        status: parseStatusFilter(status),
        limit: Number.isInteger(parsed) && parsed > 0 && parsed <= 200 ? parsed : 50,
      }),
    };
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.grievance.detail(id);
  }

  @Post(':id/category')
  @Roles(...GRIEVANCE_HANDLERS)
  @Audited('grievance.category.set')
  @HttpCode(HttpStatus.OK)
  async setCategory(@Param('id') id: string, @Body() body: unknown) {
    return this.grievance.setCategory(id, parseGrievanceCategory(body));
  }

  /**
   * FR-GRV-06. POST, not GET, for the same reason RopaController/
   * ConsentProofController are POST: the audit interceptor only records
   * non-safe HTTP methods, and generating a regulator-facing certificate is
   * exactly the compliance-significant act R3's trail exists to catch.
   * @AllowReadOnly is required alongside @Roles because Auditor is a
   * read-only role and reviewing closed complaints' proof is the documented
   * exception that decorator exists for.
   */
  @Post(':id/resolution-export')
  @Roles(...GRIEVANCE_HANDLERS, 'auditor')
  @AllowReadOnly()
  @Audited('grievance.resolution.exported')
  @HttpCode(HttpStatus.OK)
  async exportResolution(@Param('id') id: string): Promise<StreamableFile> {
    const { buffer, filename } = await this.grievance.exportResolution(id);
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
