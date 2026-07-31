import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AuditExportController } from './audit-export.controller';
import { EvidenceBundleService } from './evidence-bundle.service';

/**
 * The API-only satellite that FR-AUD-05 needs and `AuditModule` must not
 * gain — see `AuditExportController`'s header for the full reasoning. Imported
 * by `app.module.ts` ONLY, never by `worker.module.ts`.
 *
 * `EvidenceBundleService` reaches `AuditVerifierService` through
 * `AuditModule`'s `@Global()` export (no explicit import needed) and
 * `IdentityService` through the `IdentityModule` import here — the same
 * org-name lookup every other export module (Inventory, DPRequest, Breach,
 * Grievance) already does for its own PDF, just isolated here instead of
 * inside the module the worker also loads.
 */
@Module({
  imports: [IdentityModule],
  controllers: [AuditExportController],
  providers: [EvidenceBundleService],
})
export class AuditExportModule {}
