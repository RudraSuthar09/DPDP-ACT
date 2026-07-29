import { Injectable } from '@nestjs/common';
import type { DashboardActivityEntry, DashboardSummary } from '@dpdp/shared';
import { RegisterService } from '../inventory/register.service';
import { ConsentService } from '../consent/consent.service';
import { WorkflowJobsRepository } from '../workflow/workflow-jobs.repository';
import { AuditVerifierService } from '../audit/audit-verifier.service';
import { describeAction } from './activity-labels';

/**
 * Compliance dashboard (FR-DSH-01). Every counter and the activity feed come
 * from the OWNING module's own service/repository — never a query against
 * another module's table (R2). This service only aggregates and shapes what
 * those calls return; it holds no table names of its own.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly register: RegisterService,
    private readonly consent: ConsentService,
    private readonly workflowJobs: WorkflowJobsRepository,
    private readonly auditVerifier: AuditVerifierService,
  ) {}

  async summary(): Promise<DashboardSummary> {
    const [inventory, activeConsents, openIncidents, openTickets, openRequests] = await Promise.all([
      this.register.summary(),
      this.consent.countActiveConsents(),
      this.workflowJobs.countOpenByKind('breach'),
      this.workflowJobs.countOpenByKind('grievance'),
      this.workflowJobs.countOpenByKind('dprequest'),
    ]);

    return {
      inventory,
      consent: { activeConsents },
      breach: { openIncidents },
      grievance: { openTickets },
      dprequest: { openRequests },
    };
  }

  async recentActivity(limit: number): Promise<DashboardActivityEntry[]> {
    const entries = await this.auditVerifier.list(limit);
    return entries.map((e) => ({
      id: e.id,
      seq: e.seq,
      occurredAt: e.occurredAt,
      actorLabel: e.actorLabel ?? null,
      action: e.action,
      description: describeAction(e.action),
      outcome: e.outcome,
      targetType: e.targetType ?? null,
    }));
  }
}
