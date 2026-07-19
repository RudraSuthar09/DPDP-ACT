import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { WorkflowRunner } from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';

/**
 * Data Principal Request Tracker — rights requests (DPDP §§11–14). In Stage 1
 * this demonstrates that the statutory SLA clock (FR-DPR-03) runs on the SAME
 * WorkflowRunner (S3) as Breach and Grievance — "same mechanism as FR-BRC-02",
 * exactly as the requirement says. Verification, the Personal Data Summary, and
 * fulfilment webhooks land later on this foundation.
 */
@Injectable()
export class DPRequestService {
  constructor(
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
    private readonly audit: AuditContextService,
  ) {}

  async openRequest(slaInSeconds: number): Promise<{ requestId: string; slaDueAt: string }> {
    const requestId = randomUUID();
    const slaDueAt = new Date(Date.now() + slaInSeconds * 1000).toISOString();

    await this.runner.schedule({
      workflowId: requestId,
      kind: 'dprequest',
      runAt: slaDueAt,
      payload: { policy: 'dprequest.sla' },
    });

    this.audit.annotate({
      targetType: 'dprequest',
      targetId: requestId,
      reason: 'Rights request opened; statutory SLA deadline scheduled',
      afterState: { slaDueAt },
    });

    return { requestId, slaDueAt };
  }
}
