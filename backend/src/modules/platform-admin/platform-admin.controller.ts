import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { NoAudit } from '../audit/audited.decorator';
import { PlatformAdminGuard, type RequestWithPlatformAdmin } from '../../tenancy/platform-admin.guard';
import { parseIssueLicense } from '../licensing/licensing.dto';
import { parseLicenseIdParam, parsePlatformAdminLogin, parseTenantIdParam } from './platform-admin.dto';
import { PlatformAdminService } from './platform-admin.service';

/**
 * The cross-tenant support tool behind the frontend's /admin/licenses page —
 * not linked from the main app (see that page's own comment). Auth is
 * PlatformAdminGuard, not TenantGuard/RBAC: see the platform-admin
 * migration for why this is a deliberately separate system.
 *
 * Both POST routes carry @NoAudit: the global AuditInterceptor unconditionally
 * records on success through the ambient request-tenant context, which does
 * not exist here (this credential crosses tenants by design) — without the
 * decorator every successful call would 500 trying to record evidence with
 * no tenant to record it against. `login` genuinely has nothing to audit
 * (platform_admins carries no tenant chain of its own). `issueLicense` very
 * much does, and IS evidenced — through SystemAuditService inside
 * LicensingService.issueForPlatformAdmin, landing a real entry in the target
 * tenant's own chain. @NoAudit here only stops the GLOBAL interceptor's
 * redundant (and tenant-context-less) attempt, it does not mean unaudited.
 */
@Controller('platform-admin')
export class PlatformAdminController {
  constructor(private readonly admin: PlatformAdminService) {}

  @Post('login')
  @NoAudit()
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown) {
    const { email, password } = parsePlatformAdminLogin(body);
    return this.admin.login(email, password);
  }

  @Get('organisations')
  @UseGuards(PlatformAdminGuard)
  async organisations() {
    return { organisations: await this.admin.listOrganisations() };
  }

  @Get('organisations/:tenantId/licenses')
  @UseGuards(PlatformAdminGuard)
  async licenses(@Param('tenantId') tenantId: string) {
    return { licenses: await this.admin.listLicenses(parseTenantIdParam(tenantId)) };
  }

  @Post('organisations/:tenantId/licenses')
  @UseGuards(PlatformAdminGuard)
  @NoAudit()
  @HttpCode(HttpStatus.CREATED)
  async issueLicense(
    @Param('tenantId') tenantId: string,
    @Req() req: RequestWithPlatformAdmin,
    @Body() body: unknown,
  ) {
    return this.admin.issueLicense(
      parseTenantIdParam(tenantId),
      req.platformAdmin!.adminId,
      req.platformAdmin!.email,
      parseIssueLicense(body),
    );
  }

  @Post('organisations/:tenantId/licenses/:licenseId/approve')
  @UseGuards(PlatformAdminGuard)
  @NoAudit()
  @HttpCode(HttpStatus.OK)
  async approveLicense(
    @Param('tenantId') tenantId: string,
    @Param('licenseId') licenseId: string,
    @Req() req: RequestWithPlatformAdmin,
  ) {
    return this.admin.approveLicense(
      parseTenantIdParam(tenantId),
      parseLicenseIdParam(licenseId),
      req.platformAdmin!.adminId,
      req.platformAdmin!.email,
    );
  }
}
