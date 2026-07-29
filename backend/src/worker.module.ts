import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenancyModule } from './tenancy/tenancy.module';
import { DatabaseModule } from './database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { WorkflowWorker } from './modules/workflow/workflow.worker';
import { NotifyModule } from './modules/notify/notify.module';
import { WebhookDeliveryWorker } from './modules/notify/webhook-delivery.worker';
import { DEADLINE_HANDLERS } from './modules/workflow/deadline-handler';
import { RequestStoreModule } from './modules/request/request-store.module';
import { RequestDeadlineHandler } from './modules/request/request-deadline.handler';

/**
 * Root module for the worker process — the second Stage 1 container.
 *
 * It hosts the CONSUMING half of the WorkflowRunner seam (S3): the pg-boss job
 * handler and the reconciliation ticker (WorkflowWorker). The API process
 * schedules deadlines; this process fires them. Same modules, different
 * entrypoint (§ deploy: two containers, not Kubernetes).
 *
 * WorkflowWorker lives here and NOT in the @Global WorkflowModule precisely so it
 * runs only in the worker — the API loads WorkflowModule to schedule, but never
 * registers a consumer. It needs the tenant database gateway (DatabaseModule +
 * TenancyModule) and the pg-boss engine + jobs repository (WorkflowModule).
 *
 * WebhookDeliveryWorker (FR-CON-07) is the same split, one module over: the API
 * loads NotifyModule to SCHEDULE a webhook delivery; only the worker process
 * loads the handler that actually signs the payload and calls a
 * client-controlled URL. NotifyModule is imported here for its repositories
 * (config/secrets/deliveries), not registered as a provider a second time.
 *
 * RequestDeadlineHandler is the third instance of the pattern, and the first to
 * be registered through a token rather than called directly. WorkflowWorker no
 * longer has an empty `onDeadline`: it dispatches to whichever DeadlineHandlers
 * are bound to DEADLINE_HANDLERS, so the request substrate's SLA escalation
 * ladder (FR-GRV-05) runs without the deadline substrate ever importing the
 * domain that uses it (R2). Adding Breach's escalating alerts later is one more
 * entry in the multi-provider array below and no change to WorkflowWorker at all.
 *
 * It imports RequestStoreModule — the worker-safe half — and NOT RequestModule,
 * which pulls in IdentityModule and would boot-crash this process. That file
 * explains why in full.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    TenancyModule,
    DatabaseModule,
    WorkflowModule,
    NotifyModule,
    RequestStoreModule,
  ],
  providers: [
    WorkflowWorker,
    WebhookDeliveryWorker,
    RequestDeadlineHandler,
    {
      // One token, many handlers. Nest has no Angular-style `multi: true`, so
      // the array is assembled here explicitly — which is arguably better: the
      // complete list of things a fired deadline can trigger is one readable
      // literal in the process that fires them. Breach's escalating alerts
      // (FR-BRC-04) join by being injected and added to this array.
      provide: DEADLINE_HANDLERS,
      useFactory: (requests: RequestDeadlineHandler) => [requests],
      inject: [RequestDeadlineHandler],
    },
  ],
})
export class WorkerModule {}
