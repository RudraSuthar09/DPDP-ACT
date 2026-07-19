import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { WorkflowKind } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { PgBossService } from './pgboss.service';
import { WorkflowJobsRepository } from './workflow-jobs.repository';
import { TICKER_INTERVAL_MS, WORKFLOW_QUEUE } from './workflow.constants';

interface DeadlinePayload {
  tenantId: string;
  workflowId: string;
  kind: WorkflowKind;
}

/**
 * The consuming half of Seam S3 — registered ONLY in the worker process (it is a
 * provider of WorkerModule, not of the @Global WorkflowModule the API loads). The
 * API schedules; the worker fires. Two containers, one seam.
 *
 * There are two ways a deadline fires, and they converge on the same transition:
 *
 *   1. pg-boss delivery — the engine wakes us at run_at with the job. The normal
 *      path, durable, per-job.
 *   2. The reconciliation ticker — a periodic cross-tenant sweep for scheduled
 *      deadlines already past due that the engine, for any reason, did not
 *      deliver (a send that never landed, a job lost to a crash). Belt to the
 *      engine's braces: a deadline is the one thing that must never be silently
 *      missed, so we check independently of the queue.
 *
 * Both call markFired, which is idempotent (it only moves a `scheduled` job), so
 * a job seen by both paths fires exactly once.
 */
@Injectable()
export class WorkflowWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWorker.name);
  private ticker: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly pgboss: PgBossService,
    private readonly repo: WorkflowJobsRepository,
    private readonly db: TenantDatabaseService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 1. Consume the engine's deliveries.
    await this.pgboss.instance.work<DeadlinePayload>(WORKFLOW_QUEUE, async (jobs) => {
      for (const job of jobs) {
        const { tenantId, workflowId, kind } = job.data;
        await this.fire(tenantId, workflowId, kind);
      }
    });

    // 2. The reconciliation ticker. A plain interval — no Redis, no cron infra —
    //    that sweeps for missed deadlines across every tenant.
    this.ticker = setInterval(() => void this.sweep(), TICKER_INTERVAL_MS);
    this.logger.log(
      `Workflow worker up: consuming ${WORKFLOW_QUEUE}, reconciling every ${TICKER_INTERVAL_MS / 1000}s`,
    );

    // Sweep once at startup so deadlines that came due while the worker was down
    // are picked up immediately, not on the next tick.
    void this.sweep();
  }

  onModuleDestroy(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** The reconciliation sweep. Cross-tenant read via the SECURITY DEFINER peephole,
   *  then per-tenant firing under RLS. */
  private async sweep(): Promise<void> {
    if (this.sweeping) {
      return; // never let two sweeps overlap
    }
    this.sweeping = true;
    try {
      const due = await this.repo.dueAcrossAllTenants();
      for (const d of due) {
        await this.fire(d.tenantId, d.workflowId, d.kind);
      }
    } catch (err) {
      this.logger.error(`Reconciliation sweep failed: ${String(err)}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Fire one deadline, under its tenant. markFired + the side effect share one
   * transaction (withTenantIdDetached — the worker has no HTTP unit of work), so
   * either both happen or neither does. A no-op markFired means the deadline was
   * cancelled or already fired: nothing to do.
   */
  private async fire(tenantId: string, workflowId: string, kind: WorkflowKind): Promise<void> {
    try {
      await this.db.withTenantIdDetached(tenantId, async (client) => {
        const fired = await this.repo.markFired(client, workflowId, kind);
        if (fired) {
          await this.onDeadline(client, tenantId, workflowId, kind);
          this.logger.log(`Deadline fired: ${kind}/${workflowId} (tenant ${tenantId.slice(0, 8)}…)`);
        }
      });
    } catch (err) {
      this.logger.error(`Failed to fire ${kind}/${workflowId}: ${String(err)}`);
      await this.db
        .withTenantIdDetached(tenantId, (client) =>
          this.repo.markFailed(client, workflowId, kind, String(err)),
        )
        .catch(() => undefined);
    }
  }

  /**
   * What a fired deadline DOES. Stage 1: nothing beyond the state transition and a
   * log line — enough to prove the seam. This is the single place Breach's
   * escalating alerts (FR-BRC-04), Grievance's SLA breach, and DPRequest's
   * overdue escalation hook in, each dispatched by `kind`, all reusing the notify
   * module (R2). Deliberately empty for now: the seam is the point, not the payload.
   */
  private async onDeadline(
    _client: PoolClient,
    _tenantId: string,
    _workflowId: string,
    _kind: WorkflowKind,
  ): Promise<void> {
    // no-op in Stage 1
  }
}
