import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { WorkflowJob, WorkflowRunner } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { PgBossService } from './pgboss.service';
import { WorkflowJobsRepository } from './workflow-jobs.repository';
import { WORKFLOW_QUEUE } from './workflow.constants';

export const WORKFLOW_RUNNER = Symbol('WORKFLOW_RUNNER');

/**
 * S3, Stage 1 implementation: schedule deadlines on pg-boss, record them durably
 * in workflow_jobs. Breach, Grievance, and DPRequest all inject the WorkflowRunner
 * interface (never this class, never the jobs table) — so replacing this with a
 * TemporalWorkflowRunner later touches none of them. That is the seam.
 *
 * Two stores, one truth. workflow_jobs (tenant-scoped, RLS, gated writes) is the
 * source of truth the domain reasons about; pg-boss is the engine that wakes the
 * worker at run_at. They are reconciled by the ticker, so a hiccup between them
 * (the process dies after the domain write, before the engine send) is caught and
 * fired, never silently lost — which is the one thing a deadline must never be.
 */
@Injectable()
export class PgBossWorkflowRunner implements WorkflowRunner {
  private readonly logger = new Logger(PgBossWorkflowRunner.name);

  constructor(
    private readonly pgboss: PgBossService,
    private readonly repo: WorkflowJobsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async schedule(job: Omit<WorkflowJob, 'status'>): Promise<void> {
    const tenantId = this.tenantContext.getOrThrow().tenantId;

    // Rescheduling? Retire the engine job that used to back this deadline, so a
    // superseded job cannot fire at the OLD time. (The domain upsert below resets
    // run_at; without this, the stale pg-boss job would still wake the worker.)
    const superseded = await this.repo.currentPgbossJobId(job.workflowId, job.kind);
    if (superseded) {
      await this.pgboss.instance
        .cancel(WORKFLOW_QUEUE, superseded)
        .catch((err) => this.logger.warn(`Could not retire superseded job ${superseded}: ${String(err)}`));
    }

    // We mint the engine job id ourselves so both stores reference the same id
    // without a chicken-and-egg round trip.
    const pgbossJobId = randomUUID();

    // Source of truth first (in the request's unit of work, atomic with its audit
    // entry). Then the engine.
    await this.repo.schedule({
      workflowId: job.workflowId,
      kind: job.kind,
      runAt: job.runAt,
      payload: job.payload,
      pgbossJobId,
    });

    const sent = await this.pgboss.instance.send(
      WORKFLOW_QUEUE,
      // Ids and metadata only — NEVER a customer record (I1). The tenant travels
      // with the job so the worker can bind RLS before it does anything.
      { tenantId, workflowId: job.workflowId, kind: job.kind },
      { id: pgbossJobId, startAfter: new Date(job.runAt) },
    );

    if (!sent) {
      // The domain row still exists, so the reconciliation ticker will fire it.
      // Loud, because it means the engine and the register momentarily disagree.
      this.logger.warn(
        `pg-boss did not accept deadline ${job.kind}/${job.workflowId}; the ticker will reconcile it.`,
      );
    }
  }

  async cancel(workflowId: string): Promise<void> {
    // Mark the domain row cancelled (gated) and get back the engine job ids to
    // pull. A job that already fired is not cancelled — it is history.
    const pgbossJobIds = await this.repo.cancel(workflowId);
    await Promise.all(
      pgbossJobIds.map((id) =>
        this.pgboss.instance
          .cancel(WORKFLOW_QUEUE, id)
          .catch((err) => this.logger.warn(`Could not cancel engine job ${id}: ${String(err)}`)),
      ),
    );
  }
}
