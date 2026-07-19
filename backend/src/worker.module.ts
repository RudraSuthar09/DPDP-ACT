import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenancyModule } from './tenancy/tenancy.module';
import { DatabaseModule } from './database/database.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { WorkflowWorker } from './modules/workflow/workflow.worker';

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
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    TenancyModule,
    DatabaseModule,
    WorkflowModule,
  ],
  providers: [WorkflowWorker],
})
export class WorkerModule {}
