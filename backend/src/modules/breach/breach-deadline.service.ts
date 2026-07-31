import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  BREACH_GATES,
  breachPolicyKey,
  type BreachGate,
  type EscalationLadderStep,
  type EscalationRung,
  type WorkflowRunner,
} from '@dpdp/shared';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';
import { IdentityService } from '../identity/identity.service';
import type { Designation } from '../identity/dto';
import { DeadlinePolicyService } from '../deadlines/deadline-policy.service';
import { BreachRepository, type IncidentRow } from './breach.repository';
import { BREACH_POLICY_SEEDS, FALLBACK_LADDER, breachDeadlineWorkflowId } from './breach-deadlines';

/**
 * Scheduling and cancelling an incident's deadlines — this module's ONLY
 * conversation with Seam S3 (FR-BRC-04).
 *
 * Every breach deadline is scheduled here and cancelled here, through
 * `WorkflowRunner.schedule`/`.cancel` and nothing else. No controller compares
 * a timestamp to `now`, nothing polls, and no file in this module names the
 * deadline register. When Stage 5 swaps pg-boss for Temporal, this file is the
 * whole surface that has to still make sense.
 *
 * THE DIFFERENCE FROM A REQUEST'S CLOCK, and it is the reason this is not just
 * a call into `RequestSlaService`: a ticket has one SLA with a ladder of
 * warnings inside it. An incident runs SEVERAL statutory clocks at once — the
 * Board and the Data Principals must both be told within 72 hours of discovery,
 * while remediation runs for 30 days — so this schedules a full ladder per
 * GATE, all anchored to `discovered_at`.
 *
 * Anchoring to discovery rather than to row creation is the load-bearing
 * choice. An incident found on Monday and logged on Wednesday has one day of
 * its 72 left, not three. Getting that wrong would let a tenant reset a
 * statutory clock by logging late, which is precisely the behaviour a breach
 * register exists to make impossible.
 */
@Injectable()
export class BreachDeadlineService {
  private readonly logger = new Logger(BreachDeadlineService.name);

  constructor(
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
    private readonly identity: IdentityService,
    private readonly policies: DeadlinePolicyService,
    private readonly repo: BreachRepository,
  ) {}

  /** Make sure this tenant has a v1 for every gate. Cheap when there is nothing
   *  to do; see DeadlinePolicyService.ensureSeeded for why it exists at all. */
  async ensureSeeded(): Promise<number> {
    return this.policies.ensureSeeded('breach', BREACH_POLICY_SEEDS);
  }

  /**
   * Schedule every gate's ladder for a newly opened incident.
   *
   * All rungs of all gates are scheduled up front, as independent deadlines with
   * derived workflow ids — rather than a self-rescheduling chain, for the same
   * reason the request substrate gives: a chain that breaks once stops for good,
   * while N independent deadlines fail independently.
   *
   * A gate whose deadline has ALREADY passed at intake (a breach discovered
   * four days ago is past its 72-hour notification window before it is even
   * logged) is still scheduled, with a `runAt` in the past. The runner fires it
   * immediately, which is the correct behaviour: the obligation was missed and
   * somebody should be told now, not never.
   */
  async scheduleAll(client: PoolClient, incident: IncidentRow): Promise<void> {
    const holders = await this.resolveLadderHolders();

    for (const gate of BREACH_GATES) {
      const policyKey = breachPolicyKey(gate);
      const policy = await this.policies.resolve(client, 'breach', policyKey, {
        slaSeconds: 72 * 3600,
        ladder: FALLBACK_LADDER,
      });

      for (const step of policy.ladder) {
        const dueAt = new Date(
          incident.discovered_at.getTime() + policy.slaSeconds * 1000 * (step.atPercent / 100),
        );
        const workflowId = breachDeadlineWorkflowId(incident.id, gate, step.level);
        const trigger = step.atPercent >= 100 ? 'sla_breach' : 'sla_proximity';
        const holder = holders.get(step.rung) ?? null;

        // The domain's record of what this deadline MEANS, written FIRST so a
        // deadline can never fire against a row that does not exist yet.
        await this.repo.insertDeadline(client, {
          incidentId: incident.id,
          gate,
          policyKey,
          policyVersion: policy.version,
          dueAt,
          level: step.level,
          rung: step.rung,
          trigger,
          workflowId,
          notifyUserId: holder?.userId ?? null,
          notifyContact: holder?.email ?? null,
        });

        await this.runner.schedule({
          workflowId,
          kind: 'breach',
          runAt: dueAt.toISOString(),
          // Ids and metadata only — never what the incident is about (I1).
          payload: { policy: 'breach.gate', gate, level: step.level, rung: step.rung },
        });
      }

      this.logger.log(
        `Breach ${incident.reference_code}: ${gate} scheduled under ${policyKey} ` +
          `v${policy.version ?? '-'} (${policy.ladder.length} rung(s)).`,
      );
    }
  }

  /**
   * Stop a gate's clock because the gate was passed — or the whole incident's
   * because it closed.
   *
   * Domain rows first (in the caller's transaction, atomic with the gate event
   * and its audit entry), then the engine jobs. If the process died between the
   * two, the deadline still fires and finds a `cancelled` row, which the handler
   * treats as a no-op: a wasted wake-up, never a spurious escalation of a gate
   * that was completed on time.
   */
  async cancel(client: PoolClient, incidentId: string, gate?: BreachGate): Promise<void> {
    const workflowIds = await this.repo.cancelDeadlines(client, incidentId, gate);
    for (const workflowId of workflowIds) {
      await this.runner.cancel(workflowId);
    }
  }

  /**
   * Ask identity who currently holds each rung (FR-IDN-04) — the breach module
   * never reads `org_designations` or `users` itself (R2).
   *
   * The result is SNAPSHOTTED onto each deadline row, deliberately on both
   * counts: the worker must not load the identity module to answer this later,
   * and who an escalation was aimed at is a fact about the moment it was set up.
   */
  private async resolveLadderHolders(): Promise<
    Map<EscalationRung, { userId: string; email: string } | null>
  > {
    const rungs = [...new Set(FALLBACK_LADDER.map((s) => s.rung))];
    const resolved = await this.identity.resolveEscalationLadder(rungs as unknown as Designation[]);
    return resolved as unknown as Map<EscalationRung, { userId: string; email: string } | null>;
  }
}

export type { EscalationLadderStep };
