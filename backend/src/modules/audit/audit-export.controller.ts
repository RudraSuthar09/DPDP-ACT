import { Controller, HttpCode, HttpStatus, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowReadOnly, Roles } from '../identity/rbac/roles.decorator';
import { Audited } from './audited.decorator';
import { EvidenceBundleService } from './evidence-bundle.service';

/**
 * FR-AUD-05 — the one export route, deliberately in its OWN small controller
 * and module rather than folded into `AuditController`/`AuditModule`.
 *
 * `AuditModule` is `@Global()` and imported into the WORKER process too (it
 * has to be — `SystemAuditService` is how a fired deadline reaches the hash
 * chain). Generating a bundle needs the tenant's organisation name, which
 * means `IdentityService`, which means `IdentityModule` — and importing
 * `IdentityModule` into `AuditModule` would drag it into the worker's module
 * graph as well, exactly the boot-crash `RequestModule`/`BreachModule` avoid by
 * keeping a separate worker-safe half. Rather than make `AuditModule` a third
 * module that has to explain that split, this route lives in a small,
 * API-only satellite that imports `IdentityModule` freely — `AuditExportModule`
 * is never imported by `WorkerModule`, so the question does not arise.
 *
 * It still reads `AuditVerifierService` — resolved for free, since
 * `AuditModule` is `@Global()` and already loaded by the time this module's
 * providers are constructed; no explicit import needed for that half.
 */
@Controller('audit')
@UseGuards(TenantGuard)
@Roles('owner', 'dpo', 'auditor')
export class AuditExportController {
  constructor(private readonly bundle: EvidenceBundleService) {}

  /**
   * Auditor is included (unlike most POSTs, which are staff-only) — see
   * @AllowReadOnly's own documentation: reviewing evidence is the documented
   * exception to Auditor's read-only floor, and this route reads every
   * existing entry and writes none, so it fits that exception exactly.
   *
   * POST despite generating nothing new in the database: the interceptor only
   * records non-safe HTTP methods, and producing the document a tenant hands a
   * regulator is exactly the compliance-significant act that trail exists to
   * catch — same reasoning as RopaController's export, the DPR register
   * export, and the Breach closure packet.
   */
  @Post('evidence-bundle')
  @AllowReadOnly()
  @Audited('audit.evidence_bundle.exported')
  @HttpCode(HttpStatus.OK)
  async evidenceBundle(): Promise<StreamableFile> {
    const { buffer, filename } = await this.bundle.generate();
    return new StreamableFile(buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
