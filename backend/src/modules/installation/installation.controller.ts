import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { InstallationService } from './installation.service';
import { parseRegisterInstallation } from './installation.dto';

const MANAGE = ['owner', 'dpo', 'compliance_officer'] as const;

/**
 * Installation registration (locked architecture §11): the "Install DPDP ->
 * Enter License Key -> Register Installation" step. Staff-authenticated
 * (JWT + TenantGuard) — the license key proves entitlement, the JWT proves
 * which tenant it's being registered against. Tenant isolation is never
 * bypassable: RLS scopes every read/write to the caller's own tenant.
 */
@Controller('installations')
@UseGuards(TenantGuard)
export class InstallationController {
  constructor(private readonly installations: InstallationService) {}

  @Post()
  @Roles(...MANAGE)
  @Audited('installation.installation.registered')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown) {
    return this.installations.register(parseRegisterInstallation(body));
  }

  @Get('active')
  @Roles(...MANAGE)
  async getActive() {
    return { installation: await this.installations.getActive() };
  }
}
