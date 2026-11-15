import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { NoAudit } from '../audit/audited.decorator';
import { PlatformAdminGuard, type RequestWithPlatformAdmin } from '../../tenancy/platform-admin.guard';
import { parseIssueLicense } from '../licensing/licensing.dto';
import {
  parseLicenseIdParam,
  parseLimit,
  parsePlatformAdminLogin,
  parseRejectLicense,
  parseTenantIdParam,
} from './platform-admin.dto';
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
  async login(@Body() body: unknown, @Req() req: Request) {
    const { email, password } = parsePlatformAdminLogin(body);
    // req.ip honours TRUST_PROXY (the real client behind Caddy), same source
    // as the public portals' per-IP limits.
    return this.admin.login(email, password, req.ip ?? req.socket?.remoteAddress ?? 'unknown');
  }

  /** Every organisation's licences, with organisation name/owner email —
   *  the admin portal's overview and licence list. Read-only. */
  @Get('licenses')
  @UseGuards(PlatformAdminGuard)
  async allLicenses() {
    return { licenses: await this.admin.listAllLicenses() };
  }

  /** Read-only list of platform administrators (email, created, last login). */
  @Get('admins')
  @UseGuards(PlatformAdminGuard)
  async admins() {
    return { admins: await this.admin.listAdmins() };
  }

  /** One organisation's licensing audit entries, newest first. Read-only. */
  @Get('organisations/:tenantId/audit')
  @UseGuards(PlatformAdminGuard)
  async audit(@Param('tenantId') tenantId: string, @Query('limit') limit?: string) {
    return { entries: await this.admin.listLicensingAudit(parseTenantIdParam(tenantId), parseLimit(limit, 100, 500)) };
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

  /** Reject a pending, unapproved licence request. Reason mandatory. @NoAudit
   *  for the same reason as approve: the evidence is written by
   *  SystemAuditService into the target tenant's own chain. */
  @Post('organisations/:tenantId/licenses/:licenseId/reject')
  @UseGuards(PlatformAdminGuard)
  @NoAudit()
  @HttpCode(HttpStatus.OK)
  async rejectLicense(
    @Param('tenantId') tenantId: string,
    @Param('licenseId') licenseId: string,
    @Req() req: RequestWithPlatformAdmin,
    @Body() body: unknown,
  ) {
    const { reason } = parseRejectLicense(body);
    return this.admin.rejectLicense(
      parseTenantIdParam(tenantId),
      parseLicenseIdParam(licenseId),
      req.platformAdmin!.email,
      reason,
    );
  }
}
