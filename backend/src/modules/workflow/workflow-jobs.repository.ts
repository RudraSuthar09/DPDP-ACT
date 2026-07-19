import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { WorkflowKind, WorkflowJobStatus } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Every SQL statement that touches workflow_jobs, in one file — and every WRITE
 * goes through a SECURITY DEFINER `app.workflow_*` function, never a raw INSERT
 * or UPDATE (R3). dpdp_app has SELECT on the table and nothing else, so the reads
 * below are direct and the writes could not be direct even if this file tried.
 *
 * No other module names workflow_jobs or the app.workflow_* functions
 * (workflow-write-path.spec.ts pins that); Breach/Grievance/DPRequest schedule
 * through the WorkflowRunner interface instead.
 */

export interface WorkflowJobRow {
  status: WorkflowJobStatus;
  run_at: Date;
  attempts: number;
  fired_at: Date | null;
  cancelled_at: Date | null;
  pgboss_job_id: string | null;
}

export interface DueJob {
  tenantId: string;
  workflowId: string;
  kind: WorkflowKind;
}

@Injectable()
export class WorkflowJobsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /** Upsert the durable deadline row. The only INSERT path (R3). Returns its id. */
  schedule(input: {
    workflowId: string;
    kind: WorkflowKind;
    runAt: string;
    payload: Record<string, unknown>;
    pgbossJobId: string | null;
  }): Promise<string> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT app.workflow_schedule($1, $2, $3, $4::jsonb, $5) AS id',
        [
          input.workflowId,
          input.kind,
          input.runAt,
          JSON.stringify(input.payload ?? {}),
          input.pgbossJobId,
        ],
      );
      return rows[0]!.id;
    });
  }

  /** Cancel the scheduled deadline(s) for a workflow; returns the pg-boss job ids
   *  the runner should pull from the engine. */
  cancel(workflowId: string): Promise<string[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ workflow_cancel: string | null }>(
        'SELECT app.workflow_cancel($1) AS workflow_cancel',
        [workflowId],
      );
      return rows.map((r) => r.workflow_cancel).filter((id): id is string => Boolean(id));
    });
  }

  /** The pg-boss job id currently backing a workflow deadline, if any. Used to
   *  retire a superseded engine job on reschedule. RLS scopes it to the tenant. */
  currentPgbossJobId(workflowId: string, kind: WorkflowKind): Promise<string | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{ pgboss_job_id: string | null }>(
        'SELECT pgboss_job_id FROM workflow_jobs WHERE workflow_id = $1 AND kind = $2',
        [workflowId, kind],
      );
      return rows[0]?.pgboss_job_id ?? null;
    });
  }

  /** The deadline's current state — for the demo and for the handler's guard. */
  get(workflowId: string, kind: WorkflowKind): Promise<WorkflowJobRow | null> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<WorkflowJobRow>(
        `SELECT status, run_at, attempts, fired_at, cancelled_at, pgboss_job_id
           FROM workflow_jobs WHERE workflow_id = $1 AND kind = $2`,
        [workflowId, kind],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Transition a scheduled deadline to fired, under the tenant already bound on
   * `client`. Returns true only if it actually moved a scheduled job — so a
   * cancelled, superseded, or already-fired deadline is a no-op and a duplicate
   * delivery cannot double-fire. The worker owns the transaction (it passes its
   * own client), so the state change and any side effect commit together.
   */
  async markFired(client: PoolClient, workflowId: string, kind: WorkflowKind): Promise<boolean> {
    const { rows } = await client.query<{ workflow_mark_fired: boolean }>(
      'SELECT app.workflow_mark_fired($1, $2) AS workflow_mark_fired',
      [workflowId, kind],
    );
    return rows[0]?.workflow_mark_fired ?? false;
  }

  async markFailed(
    client: PoolClient,
    workflowId: string,
    kind: WorkflowKind,
    error: string,
  ): Promise<void> {
    await client.query('SELECT app.workflow_mark_failed($1, $2, $3)', [workflowId, kind, error]);
  }

  /**
   * The cross-tenant sweep for the reconciliation ticker — due deadlines across
   * ALL tenants, ids and kind only (no business data, I1). Runs untenanted
   * because the question ("which tenants have a deadline due?") cannot be asked
   * under one tenant's RLS; app.workflow_due_all is a SECURITY DEFINER peephole,
   * the sibling of resolve_login. See TenantDatabaseService.runUntenanted.
   */
  dueAcrossAllTenants(): Promise<DueJob[]> {
    return this.db.runUntenanted(async (client) => {
      const { rows } = await client.query<{ tenant_id: string; workflow_id: string; kind: WorkflowKind }>(
        'SELECT tenant_id, workflow_id, kind FROM app.workflow_due_all()',
      );
      return rows.map((r) => ({ tenantId: r.tenant_id, workflowId: r.workflow_id, kind: r.kind }));
    });
  }
}
