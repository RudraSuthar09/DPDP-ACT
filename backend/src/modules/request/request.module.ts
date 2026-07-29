import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { NotifyModule } from '../notify/notify.module';
import { RequestStoreModule } from './request-store.module';
import { RequestController } from './request.controller';
import { RequestPortalController } from './request-portal.controller';
import { RequestService } from './request.service';
import { RequestPortalService } from './request-portal.service';
import { RequestSlaService } from './request-sla.service';

/**
 * THE SHARED REQUEST SUBSTRATE — the foundation the Grievance Register
 * (complaints, §13) and the Data Principal Request Tracker (rights requests,
 * §§11-14) both stand on.
 *
 * Requirements: FR-GRV-01/03/04/05 (and the FR-DPR equivalents).
 * Seams: S1 (public tenant resolution), S3 (SLA deadlines), S5 (audit).
 * Invariants: I1 (the identity handoff), I3 (RLS on every table), I4 (append-only
 * trails, nothing hard-deleted).
 *
 * WHAT IT OWNS — and this list is the boundary, not a summary:
 *   * the public, unauthenticated portal and its OTP contact-channel proof;
 *   * the identity-verification HANDOFF (FR-GRV-04) — a task handed to the
 *     tenant's staff, because the platform holds no customer records and will
 *     not start;
 *   * a generic ticket with an append-only lifecycle and correspondence trail;
 *   * SLA deadlines and the escalation ladder, through the WorkflowRunner (S3).
 *
 * WHAT IT MUST NEVER OWN: anything a complaint has that a rights request does
 * not, or the reverse. Complaint categories, rights types, the two-tier Personal
 * Data Summary, fulfilment webhooks — those belong to GrievanceModule and
 * DPRequestModule, keyed by ticket id, calling in through RequestService. The
 * moment a `if (requestType === 'grievance')` appears in this directory, the
 * substrate has stopped being shared and has become one module's ticketing
 * system that the other has to work around.
 *
 * The split from RequestStoreModule is not stylistic — see that file. The
 * consuming half of S3 (RequestDeadlineHandler) is deliberately NOT a provider
 * here: like WorkflowWorker and WebhookDeliveryWorker it is registered only in
 * WorkerModule, so the API schedules deadlines and only the worker fires them.
 */
@Module({
  imports: [
    RequestStoreModule,
    // For the escalation ladder: who currently holds each rung (FR-IDN-04). The
    // request module never reads org_designations or users itself (R2).
    IdentityModule,
    // For OTP and escalation delivery.
    NotifyModule,
  ],
  controllers: [RequestController, RequestPortalController],
  providers: [RequestService, RequestPortalService, RequestSlaService],
  // Exported for the two modules that specialise this substrate. They get the
  // service, never the repositories — the tables stay this module's business.
  exports: [RequestService],
})
export class RequestModule {}
