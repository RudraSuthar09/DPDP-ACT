import { Module } from '@nestjs/common';
import { RequestModule } from '../request/request.module';
import { IdentityModule } from '../identity/identity.module';
import { GrievancePortalController } from './grievance-portal.controller';
import { GrievanceController } from './grievance.controller';
import { GrievanceService } from './grievance.service';
import { GrievanceCategoryRepository } from './grievance-category.repository';

/**
 * Grievance Register — complaints (DPDP §13, FR-GRV-02/06).
 *
 * Built ON the shared request substrate (`RequestModule`), never inside it.
 * This module owns exactly one thing the substrate does not: a complaint's
 * category (`grievance_details`, keyed by ticket id). Everything else —
 * public intake mechanics, OTP, the identity-verification handoff, ticket
 * lifecycle, correspondence, SLA timers, the escalation ladder — is
 * `RequestService`/`RequestPortalService`, imported and called, never
 * reimplemented (R2). `GrievanceModule` has no repository for
 * `request_tickets` and never will.
 *
 * `IdentityModule` is imported directly (not inherited through `RequestModule`,
 * which does not export `IdentityService`) purely so the resolution export can
 * read the tenant's organisation name — same reasoning as
 * `InventoryModule`/`ConsentModule` importing it for their own PDF exports.
 */
@Module({
  imports: [RequestModule, IdentityModule],
  controllers: [GrievancePortalController, GrievanceController],
  providers: [GrievanceService, GrievanceCategoryRepository],
})
export class GrievanceModule {}
