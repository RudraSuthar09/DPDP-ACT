import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { WorkflowKind } from '@dpdp/shared';
import type { DeadlineHandler } from '../workflow/deadline-handler';
import { RetentionRepository } from './retention.repository';

/**
 * The consuming edge of Seam S3 for retention tracking — the fourth
 * DeadlineHandler. When a retention clock reaches its (frozen) retention_end,
 * this flags the record expired: a durable "the retention period has passed"
 * marker set on the worker's firing transaction, independent of anyone opening
 * the dashboard.
 *
 * Deliberately narrow (see DeadlineHandler's contract): it flips one timestamp
 * and never throws for anything it can absorb. It NEVER deletes or touches the
 * client's data (I1) — the platform only surfaces the fact. It also never
 * changes retention_end (I4); flagging expiry is not recomputing it.
 *
 * Registered only in WorkerModule via a worker-safe RetentionStoreModule (which
 * carries just RetentionRepository, not the whole ConsentModule that would drag
 * IdentityModule into this process).
 */
@Injectable()
export class RetentionDeadlineHandler implements DeadlineHandler {
  private readonly logger = new Logger(RetentionDeadlineHandler.name);

  constructor(private readonly repo: RetentionRepository) {}

  handles(kind: WorkflowKind): boolean {
    return kind === 'retention';
  }

  async onDeadline(
    client: PoolClient,
    context: { tenantId: string; workflowId: string; kind: WorkflowKind },
  ): Promise<void> {
    // workflowId IS the retention record id (see RetentionService.scheduleExpiry).
    await this.repo.flagExpired(client, context.workflowId);
    this.logger.log(`Retention record ${context.workflowId}: retention period reached, flagged past.`);
  }
}
