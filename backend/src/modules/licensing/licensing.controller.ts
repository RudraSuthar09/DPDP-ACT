import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { LicensingService } from './licensing.service';
import { parseIssueLicense } from './licensing.dto';

const MANAGE = ['owner', 'dpo'] as const;

/**
 * Staff issuance/management of license entitlements (locked architecture §9).
 * Validation of a presented key against a requested deployment configuration
 * happens in InstallationModule (POST /installations), which is the only
 * place a license actually gets consumed — this controller only issues and
 * lists/revokes. The raw key is returned exactly once, here, and never again.
 */
@Controller('licenses')
@UseGuards(TenantGuard)
export class LicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Post()
  @Roles(...MANAGE)
  @Audited('licensing.license.issued')
  @HttpCode(HttpStatus.CREATED)
  async issue(@Body() body: unknown) {
    return this.licensing.issue(parseIssueLicense(body));
  }

  @Get()
  @Roles(...MANAGE)
  async list() {
    return { licenses: await this.licensing.list() };
  }

  @Post(':id/revoke')
  @Roles(...MANAGE)
  @Audited('licensing.license.revoked')
  @HttpCode(HttpStatus.OK)
  async revoke(@Param('id') id: string, @Body() body: unknown) {
    const reason = body && typeof body === 'object' && 'reason' in body ? String((body as { reason?: unknown }).reason ?? '') || null : null;
    return this.licensing.revoke(id, reason);
  }
}
