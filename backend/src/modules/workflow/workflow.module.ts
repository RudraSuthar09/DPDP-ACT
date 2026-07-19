import { Global, Module } from '@nestjs/common';
import { PgBossService } from './pgboss.service';
import { WorkflowJobsRepository } from './workflow-jobs.repository';
import { PgBossWorkflowRunner, WORKFLOW_RUNNER } from './pg-boss-workflow-runner';

/**
 * WorkflowRunner — Seam S3. The durable deadline substrate shared by Breach,
 * Grievance, and DPRequest (they have the same physics: a deadline-bound,
 * must-not-be-lost state machine). Stage 1: a jobs table + a pg-boss engine +
 * a reconciliation ticker. Later: Temporal, behind this same interface.
 *
 * Requirements: FR-BRC-02/04, FR-GRV (SLA), FR-DPR-03.  Seams: S3.  Invariants: I4.
 *
 * @Global, and it EXPORTS the runner — unlike the audit and event sinks, which
 * are deliberately un-exported. That difference is the design: the audit/consent
 * sinks are locked to one writer (R3), whereas the WorkflowRunner is MEANT to be
 * injected widely — three modules schedule deadlines through it. What stays locked
 * is the table: workflow_jobs and the app.workflow_* functions are named only in
 * this module's repository (workflow-write-path.spec.ts pins that), so "no ad-hoc
 * INSERT into workflow tables" (R3) holds even though the runner is shared.
 *
 * The CONSUMING half — WorkflowWorker (the pg-boss handler + the ticker) — is NOT
 * here. It is a provider of WorkerModule only, so it runs in the worker process,
 * never the API. The API schedules; the worker fires.
 *
 * Swapping pg-boss for Temporal later changes only the useClass below and the
 * worker; Breach/Grievance/DPRequest never learn it happened.
 */
@Global()
@Module({
  providers: [
    PgBossService,
    WorkflowJobsRepository,
    { provide: WORKFLOW_RUNNER, useClass: PgBossWorkflowRunner },
  ],
  exports: [WORKFLOW_RUNNER, PgBossService, WorkflowJobsRepository],
})
export class WorkflowModule {}
