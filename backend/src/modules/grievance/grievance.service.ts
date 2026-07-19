import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowRunner } from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';

/**
 * Grievance Register — complaints (DPDP §13). In Stage 1 this demonstrates that
 * the grievance SLA clock runs on the SAME WorkflowRunner (S3) as Breach and
 * DPRequest — one substrate, three callers (R2). The ticket, OTP, portal, and
 * escalation ladder land later on this same foundation.
 */
@Injectable()
export class GrievanceService {
  constructor(
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
    private readonly audit: AuditContextService,
  ) {}

  async openTicket(slaInSeconds: number): Promise<{ ticketId: string; slaDueAt: string }> {
    const ticketId = randomUUID();
    const slaDueAt = new Date(Date.now() + slaInSeconds * 1000).toISOString();

    await this.runner.schedule({
      workflowId: ticketId,
      kind: 'grievance',
      runAt: slaDueAt,
      payload: { policy: 'grievance.sla' },
    });

    this.audit.annotate({
      targetType: 'grievance_ticket',
      targetId: ticketId,
      reason: 'Grievance opened; SLA deadline scheduled',
      afterState: { slaDueAt },
    });

    return { ticketId, slaDueAt };
  }
}
