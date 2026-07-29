import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EscalationRung, RequestType, WorkflowRunner } from '@dpdp/shared';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';
import { IdentityService } from '../identity/identity.service';
import type { Designation } from '../identity/dto';
import { RequestSlaRepository } from './request-sla.repository';
import { RequestTicketsRepository, type TicketRow } from './request-tickets.repository';
import { deadlineWorkflowId } from './request-identifiers';
import { defaultPolicyFor, planTimers, slaDueAt, type SlaPolicyValue } from './request-sla-policy';

/**
 * Starting and stopping a request's clock — the substrate's only conversation
 * with Seam S3.
 *
 * Every deadline in the request substrate is scheduled here and cancelled here,
 * through `WorkflowRunner.schedule` / `.cancel` and nothing else. No file in this
 * module names the deadline register, no controller compares a timestamp to
 * `now`, and nothing polls. That is the seam being kept rather than described:
 * when Stage 5 replaces pg-boss with Temporal, this file is the entire surface
 * that has to still make sense.
 */
@Injectable()
export class RequestSlaService {
  private readonly logger = new Logger(RequestSlaService.name);

  constructor(
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
    private readonly identity: IdentityService,
    private readonly sla: RequestSlaRepository,
    private readonly tickets: RequestTicketsRepository,
  ) {}

  /** The tenant's policy for a request type, or the platform default. */
  async policyFor(client: PoolClient, requestType: RequestType): Promise<SlaPolicyValue> {
    const row = await this.sla.findPolicy(client, requestType);
    return row ? { slaSeconds: row.sla_seconds, ladder: row.ladder } : defaultPolicyFor(requestType);
  }

  /**
   * Start the clock, and schedule the whole escalation ladder.
   *
   * WHEN the clock starts is a real decision, and it starts at CONTACT
   * VERIFICATION, not at submission. Running the SLA from the moment an
   * unverified stranger posts a form would mean anyone could burn a tenant's
   * response window by submitting junk, and would put the tenant on a deadline
   * for a request nobody has yet shown is even reachable. The clock starts when
   * there is a real, reachable requester on the other end.
   *
   * All N rungs are scheduled now, as N independent deadlines with derived
   * workflow ids — see request_sla_timers in the migration for why a
   * self-rescheduling chain would be the fragile choice.
   */
  async startClock(client: PoolClient, ticket: TicketRow): Promise<{ dueAt: Date }> {
    const policy = await this.policyFor(client, ticket.request_type);
    const startedAt = new Date();
    const dueAt = slaDueAt(policy, startedAt);

    await this.tickets.setSla(client, ticket.id, {
      seconds: policy.slaSeconds,
      startedAt,
      dueAt,
    });

    const holders = await this.resolveLadderHolders(policy);

    for (const timer of planTimers(policy, startedAt)) {
      const holder = holders.get(timer.rung) ?? null;
      const workflowId = deadlineWorkflowId(ticket.id, timer.level);

      // The domain's record of what this deadline MEANS, written first so a
      // deadline can never fire against a timer row that does not exist yet.
      await this.sla.insertTimer(client, {
        ticketId: ticket.id,
        level: timer.level,
        rung: timer.rung,
        trigger: timer.trigger,
        workflowId,
        dueAt: timer.dueAt,
        notifyUserId: holder?.userId ?? null,
        notifyContact: holder?.email ?? null,
      });

      // ...and then the deadline itself, through the seam. `kind` is the
      // ticket's own request type, so Grievance and DPRequest deadlines stay
      // distinguishable in the register with no translation layer.
      await this.runner.schedule({
        workflowId,
        kind: ticket.request_type,
        runAt: timer.dueAt.toISOString(),
        // Ids and metadata only — never the requester's words or contact (I1).
        payload: { policy: 'request.sla', level: timer.level, rung: timer.rung },
      });
    }

    this.logger.log(
      `SLA started for ${ticket.reference_code}: due ${dueAt.toISOString()}, ${policy.ladder.length} ladder step(s).`,
    );
    return { dueAt };
  }

  /**
   * Stop the clock — the ticket was resolved or closed.
   *
   * Order matters. The domain rows are marked cancelled first (in the request's
   * transaction, so it is atomic with the closure and its audit entry), then the
   * engine jobs are pulled. If the process died between the two, the deadline
   * would still fire and find a `cancelled` timer, which the handler treats as a
   * no-op — the failure mode is a wasted wake-up, never a spurious escalation of
   * a closed complaint.
   */
  async cancelClock(client: PoolClient, ticketId: string): Promise<void> {
    const workflowIds = await this.sla.cancelTimers(client, ticketId);
    for (const workflowId of workflowIds) {
      await this.runner.cancel(workflowId);
    }
  }

  /**
   * Which rung of the ladder a manual escalation should climb to next, and who
   * holds it. Used only by the staff "escalate now" path — the automatic path
   * uses the snapshot on the timer row instead.
   */
  async nextManualRung(
    client: PoolClient,
    ticket: TicketRow,
  ): Promise<{ level: number; rung: EscalationRung; holder: LadderHolder | null } | null> {
    const policy = await this.policyFor(client, ticket.request_type);
    const current = await this.sla.currentEscalationLevel(client, ticket.id);
    const next = policy.ladder.find((step) => step.level === current + 1);
    if (!next) {
      return null;
    }
    const holders = await this.resolveLadderHolders(policy);
    return { level: next.level, rung: next.rung, holder: holders.get(next.rung) ?? null };
  }

  /**
   * Ask identity who currently holds each rung this ladder mentions (R2 — the
   * request module never reads `org_designations` or `users` itself).
   *
   * The result is a SNAPSHOT that gets written onto the timer rows. That is
   * deliberate on both counts: the worker process must not load the identity
   * module to answer this later, and who an escalation was aimed at is a fact
   * about the moment it was set up.
   */
  private async resolveLadderHolders(
    policy: SlaPolicyValue,
  ): Promise<Map<EscalationRung, LadderHolder | null>> {
    const rungs = [...new Set(policy.ladder.map((step) => step.rung))];
    // EscalationRung and Designation are the same three strings — one is the
    // ladder's vocabulary, the other identity's. The cast is where they meet,
    // and it is here rather than spread across call sites so a future divergence
    // has exactly one place to break.
    const resolved = await this.identity.resolveEscalationLadder(rungs as unknown as Designation[]);
    return resolved as unknown as Map<EscalationRung, LadderHolder | null>;
  }
}

export interface LadderHolder {
  userId: string;
  email: string;
  fullName: string;
}
