import { Body, Controller, HttpCode, HttpStatus, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles, AllowReadOnly } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { RopaService } from './ropa.service';
import { parseRopaExportInput } from './ropa.dto';

/**
 * FR-INV-09 — RoPA export. POST, not GET, even though it changes nothing:
 * exporting the whole processing register is a compliance-significant event
 * worth recording in the S5 chain ("who exported this, when, in what
 * format"), and the audit interceptor only records non-safe HTTP methods
 * (Stage 1 does not yet audit reads). @AllowReadOnly() is required alongside
 * @Roles because 'auditor' is a read-only role and generating a report is
 * exactly the documented exception that decorator exists for.
 */
@Controller('inventory/ropa')
@UseGuards(TenantGuard)
export class RopaController {
  constructor(private readonly ropa: RopaService) {}

  @Post('export')
  @Roles('owner', 'dpo', 'compliance_officer', 'auditor')
  @AllowReadOnly()
  @Audited('inventory.ropa.exported')
  @HttpCode(HttpStatus.OK)
  async export(@Body() body: unknown): Promise<StreamableFile> {
    const { format } = parseRopaExportInput(body);
    const { buffer, contentType, filename } = await this.ropa.export(format);
    return new StreamableFile(buffer, {
      type: contentType,
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
