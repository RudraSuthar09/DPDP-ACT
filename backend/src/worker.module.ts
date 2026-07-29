import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenancyModule } from './tenancy/tenancy.module';
import { DatabaseModule } from './database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { WorkflowWorker } from './modules/workflow/workflow.worker';
import { NotifyModule } from './modules/notify/notify.module';
import { WebhookDeliveryWorker } from './modules/notify/webhook-delivery.worker';

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
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    TenancyModule,
    DatabaseModule,
    WorkflowModule,
    NotifyModule,
  ],
  providers: [WorkflowWorker, WebhookDeliveryWorker],
})
export class WorkerModule {}
