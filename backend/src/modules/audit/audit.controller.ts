import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { Roles } from '../identity/rbac/roles.decorator';
import { AuditVerifierService } from './audit-verifier.service';

/**
 * Reading the evidence (FR-AUD-03).
 *
 * Read-only by construction: every route here is a GET, which also means the
 * interceptor does not audit reads of the audit log (see
 * AuditInterceptor.shouldAudit). The one WRITE-adjacent action this module
 * offers — exporting an evidence bundle (FR-AUD-05) — lives in
 * `AuditExportController` instead, and deliberately not here: see that file's
 * header for why the split is structural, not stylistic.
 *
 * Owner/DPO/Auditor only. Not because the log is embarrassing, but because it
 * records who did what and from which IP: it is a register of the client's
 * staff's activity, and hands it to anyone who can read it.
 */
@Controller('audit')
@UseGuards(TenantGuard)
@Roles('owner', 'dpo', 'auditor')
export class AuditController {
  constructor(private readonly verifier: AuditVerifierService) {}

  /** The tenant's log, newest first. Keyset paging on seq — the chain order. */
  @Get()
  async list(@Query('limit') limit?: string, @Query('before') before?: string) {
    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const parsedBefore = before ? Number(before) : undefined;
    return {
      entries: await this.verifier.list(
        parsedLimit,
        Number.isFinite(parsedBefore) ? parsedBefore : undefined,
      ),
    };
  }

  /**
   * Walk the whole chain and report any break. This is the endpoint that answers
   * "prove this log has not been edited" — the question the product exists to
   * let a client answer about themselves.
   */
  @Get('verify')
  async verify() {
    return this.verifier.verifyChain();
  }
}
