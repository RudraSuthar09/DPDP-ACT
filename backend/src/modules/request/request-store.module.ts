import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.module';
import { RequestTicketsRepository } from './request-tickets.repository';
import { RequestVerificationRepository } from './request-verification.repository';
import { RequestSlaRepository } from './request-sla.repository';
import { RequestEscalationService } from './request-escalation.service';

/**
 * The WORKER-SAFE half of the request substrate: the repositories, plus the one
 * service both processes need (escalation).
 *
 * It exists because of a specific, previously-learned failure. The API half
 * (RequestModule) imports IdentityModule to resolve the escalation ladder;
 * IdentityModule pulls in IdentityService, which depends on the @Global
 * AuditContextService — present in the API's module graph and never loaded into
 * the worker's. If WorkerModule imported RequestModule to reach the
 * repositories, the worker process would fail to boot the moment Nest resolved
 * that graph. NotifyModule documents having hit exactly this; this split is the
 * same answer, applied before it happened again.
 *
 * So the rule for this module is one sentence: nothing in here may depend on
 * identity, on the audit context, or on anything else that only exists in the
 * API. If a new provider cannot honour that, it belongs in RequestModule.
 */
@Module({
  // NOT DeadlinePolicyModule. Policy resolution happens in RequestSlaService,
  // which is API-side (RequestModule) — and DeadlinePolicyService depends on the
  // audit context, which the worker process deliberately does not have. Adding
  // it here boot-crashes the worker, which is the whole reason this split
  // module exists.
  imports: [NotifyModule],
  providers: [
    RequestTicketsRepository,
    RequestVerificationRepository,
    RequestSlaRepository,
    RequestEscalationService,
  ],
  exports: [
    RequestTicketsRepository,
    RequestVerificationRepository,
    RequestSlaRepository,
    RequestEscalationService,
  ],
})
export class RequestStoreModule {}
