import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowRunner } from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';

/**
 * Breach Register (FR-BRC). In Stage 1 this demonstrates the ONE thing that must
 * be right about breach handling from day one: the statutory notification
 * deadline is scheduled through the WorkflowRunner (S3), not tracked by a status
 * column and an `if (daysSince > 3)` somewhere (R2/R3, FR-BRC-02).
 *
 * The deadline VALUE arrives from the caller (later: a versioned deadline policy,
 * FR-BRC-02 — never hardcoded, because the Rules change). This service's job is
 * only to open the incident and hand its deadline to the seam.
 */
@Injectable()
export class BreachService {
  constructor(
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
    private readonly audit: AuditContextService,
  ) {}

  async openIncident(dueInSeconds: number): Promise<{ incidentId: string; deadlineAt: string }> {
    const incidentId = randomUUID();
    const deadlineAt = new Date(Date.now() + dueInSeconds * 1000).toISOString();

    await this.runner.schedule({
      workflowId: incidentId,
      kind: 'breach',
      runAt: deadlineAt,
      // Metadata only — never incident details that could carry personal data (I1).
      payload: { policy: 'breach.statutory_notification' },
    });

    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: incidentId,
      reason: 'Breach incident opened; statutory notification deadline scheduled',
      afterState: { deadlineAt },
    });

    return { incidentId, deadlineAt };
  }

  async closeIncident(incidentId: string): Promise<void> {
    // Closed before the deadline fired → cancel it. (If it already fired, cancel
    // is a no-op: a fired deadline is history.)
    await this.runner.cancel(incidentId);
    this.audit.annotate({
      targetType: 'breach_incident',
      targetId: incidentId,
      reason: 'Breach incident closed; deadline cancelled',
    });
  }
}
