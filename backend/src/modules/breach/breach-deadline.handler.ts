import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { WorkflowKind } from '@dpdp/shared';
import type { DeadlineHandler } from '../workflow/deadline-handler';
import { BreachRepository } from './breach.repository';
import { BreachEscalationService } from './breach-escalation.service';

/**
 * The consuming edge of Seam S3 for the Breach Register (FR-BRC-04) — the
 * second implementation of `DeadlineHandler`, alongside the request substrate's.
 *
 * Registered ONLY in WorkerModule, so the API schedules deadlines and only the
 * worker fires them. It runs inside the worker's firing transaction, on the
 * worker's client, with the tenant already bound (S1), which is what makes "the
 * deadline fired" and "the DPO was told" one atomic fact.
 *
 * It absorbs everything it can rather than throwing: an exception here rolls
 * back the firing itself and the reconciliation ticker will replay the whole
 * thing. The one case it deliberately treats as a no-op is a deadline whose row
 * is no longer `scheduled` — cancelled because the gate was passed, or already
 * fired. That is the exactly-once guard, and it is why a deadline seen by both
 * pg-boss and the ticker escalates once.
 */
@Injectable()
export class BreachDeadlineHandler implements DeadlineHandler {
  private readonly logger = new Logger(BreachDeadlineHandler.name);

  constructor(
    private readonly repo: BreachRepository,
    private readonly escalation: BreachEscalationService,
  ) {}

  handles(kind: WorkflowKind): boolean {
    return kind === 'breach';
  }

  async onDeadline(
    client: PoolClient,
    context: { tenantId: string; workflowId: string; kind: WorkflowKind },
  ): Promise<void> {
    const deadline = await this.repo.findDeadlineByWorkflowId(client, context.workflowId);
    if (!deadline) {
      // A deadline in the S3 register with no domain row behind it. Same known
      // gap the request substrate documents: the schedule call is made
      // optimistically before the enclosing transaction commits, so a rollback
      // can leave a job pointing at nothing. Nothing to escalate.
      this.logger.warn(`Breach deadline ${context.workflowId} has no incident row; skipping.`);
      return;
    }

    const claimed = await this.repo.markDeadlineFired(client, deadline.id);
    if (!claimed) {
      // Cancelled (the gate was passed in time) or already fired. Both are
      // correct outcomes, not errors.
      return;
    }

    const reason =
      deadline.trigger_reason === 'sla_breach'
        ? `The ${deadline.gate.replace(/_/g, ' ')} deadline for this incident has been reached.`
        : `The ${deadline.gate.replace(/_/g, ' ')} deadline for this incident is approaching.`;

    await this.escalation.escalate(client, {
      tenantId: context.tenantId,
      incidentId: deadline.incident_id,
      referenceCode: deadline.reference_code,
      title: deadline.title,
      gate: deadline.gate,
      level: deadline.level,
      rung: deadline.rung,
      trigger: deadline.trigger_reason,
      // The snapshot taken when the deadline was scheduled. Resolved by the API
      // then, not by the worker now — this process must not load IdentityModule.
      notify: { userId: deadline.notify_user_id, contact: deadline.notify_contact },
      reason,
      dueAt: deadline.due_at,
    });

    this.logger.log(
      `Breach ${deadline.reference_code}: ${deadline.gate} L${deadline.level} (${deadline.rung}) escalated.`,
    );
  }
}
