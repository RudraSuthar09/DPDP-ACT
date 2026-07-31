import { Module } from '@nestjs/common';
import { RequestModule } from '../request/request.module';
import { ConsentModule } from '../consent/consent.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IdentityModule } from '../identity/identity.module';
import { NotifyModule } from '../notify/notify.module';
import { DPRequestPortalController } from './dprequest-portal.controller';
import { DPRequestController } from './dprequest.controller';
import { DPRequestService } from './dprequest.service';
import { DPRequestDetailsRepository } from './dprequest-details.repository';
import { DprSummaryController } from './dpr-summary.controller';
import { PersonalDataSummaryService } from './personal-data-summary.service';
import { PurposeLinksService } from './purpose-links.service';
import { PurposeLinksRepository } from './purpose-links.repository';
import { FulfilmentService } from './fulfilment.service';
import { FulfilmentRepository } from './fulfilment.repository';
import { DprRegisterService } from './dpr-register.service';

/**
 * Data Principal Request Tracker — rights requests (DPDP §§11-14, §6(4)).
 *
 * Built ON the shared request substrate (`RequestModule`), never inside it —
 * the same discipline `GrievanceModule` follows, and for the same reason: the
 * moment a `if (requestType === 'dprequest')` appears in `request/*`, the
 * substrate has stopped being shared. This module owns one table
 * (`dprequest_details`, keyed by ticket id) and no others. It has no repository
 * for `request_tickets` and never will (R2).
 *
 * Requirements: FR-DPR-01/02/03/06.  Seams: S1, S3, S5.  Invariants: I1, I2, I4.
 *
 * `ConsentModule` is imported for ONE thing: `ConsentService.deriveSubjectRef`
 * / `.currentStatus`, so subject-reference resolution runs through the same
 * `SubjectRefHasher` and the same per-tenant secret that wrote every consent
 * event (FR-CON-04), instead of this module owning a second copy of the HMAC
 * scheme. That is a service call across a module boundary, which is exactly
 * what R2 asks for — DPR reaches none of the consent module's own tables, and
 * writes no consent event of its own (R3: the sink is the only writer).
 */
@Module({
  imports: [
    RequestModule,
    ConsentModule,
    // FR-DPR-04 Tier 1: the register's current state, through RopaService — a
    // service call, never RopaRepository and never an inventory table (R2).
    InventoryModule,
    // Organisation name for the summary header and the register export, the
    // same reason Grievance and Consent import it for their own PDFs.
    IdentityModule,
    // FR-DPR-05/07: the fulfilment endpoint config and the per-tenant webhook
    // SECRET. Reusing Prompt 22's signing scheme and its secret rather than
    // minting a second one — one scheme for a client to implement, one secret
    // to rotate.
    NotifyModule,
  ],
  controllers: [DPRequestPortalController, DPRequestController, DprSummaryController],
  providers: [
    DPRequestService,
    DPRequestDetailsRepository,
    PersonalDataSummaryService,
    PurposeLinksService,
    PurposeLinksRepository,
    FulfilmentService,
    FulfilmentRepository,
    DprRegisterService,
  ],
})
export class DPRequestModule {}
