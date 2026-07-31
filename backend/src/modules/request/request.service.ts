import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  CLOSED_REQUEST_STATUSES,
  type IdentityVerificationTask,
  type RequestCorrespondenceEntry,
  type RequestEscalation,
  type EscalationLadderStep,
  type RequestSlaPolicy,
  type RequestStatus,
  type RequestStatusEvent,
  type RequestTicket,
  type RequestType,
} from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { RequestTicketsRepository, type TicketRow } from './request-tickets.repository';
import { RequestVerificationRepository } from './request-verification.repository';
import { RequestSlaRepository } from './request-sla.repository';
import {
  DeadlinePolicyService,
  type ResolvedPolicy,
} from '../deadlines/deadline-policy.service';
import type { DeadlinePolicyVersionRow } from '../deadlines/deadline-policy.repository';
import { RequestSlaService } from './request-sla.service';
import { RequestEscalationService } from './request-escalation.service';
import { defaultPolicyFor } from './request-sla-policy';
import type {
  AssignBody,
  ChangeStatusBody,
  CompleteIdentityVerificationBody,
  SetSlaPolicyBody,
  StaffCorrespondenceBody,
  StaffSettableStatus,
} from './dto';

/**
 * The STAFF half of the shared request substrate — everything the Data
 * Fiduciary's own people do to a ticket after the public portal has handed it
 * over.
 *
 * This service is generic on purpose and stays that way. It knows about
 * tickets, a handoff, a lifecycle, a trail and a clock. It knows nothing about
 * complaint categories or rights types: when the Grievance module (Prompt 28)
 * and the DPRequest module add those, they add their own tables keyed by ticket
 * id and their own endpoints, and they call this — they do not extend it.
 */
@Injectable()
export class RequestService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
    private readonly tickets: RequestTicketsRepository,
    private readonly verification: RequestVerificationRepository,
    private readonly slaRepo: RequestSlaRepository,
    private readonly slaService: RequestSlaService,
    private readonly escalation: RequestEscalationService,
    private readonly policies: DeadlinePolicyService,
    private readonly audit: AuditContextService,
  ) {}

  // --- reads ---------------------------------------------------------------

  async list(filters: {
    status?: RequestStatus;
    requestType?: RequestType;
    limit: number;
  }): Promise<RequestTicket[]> {
    const rows = await this.tickets.list(filters);
    return rows.map(toTicket);
  }

  async detail(ticketId: string): Promise<{
    ticket: RequestTicket;
    correspondence: RequestCorrespondenceEntry[];
    statusHistory: RequestStatusEvent[];
    escalations: RequestEscalation[];
    identityVerification: {
      status: 'pending' | 'completed';
      outcome: string | null;
      reason: string | null;
      completedBy: string | null;
      completedAt: string | null;
    } | null;
    timers: { level: number; rung: string; dueAt: string; status: string; firedAt: string | null }[];
  }> {
    return this.db.withTenant(async (client) => {
      const ticket = await this.requireTicket(client, ticketId);
      const [correspondence, statusHistory, escalations, timers] = await Promise.all([
        this.tickets.listCorrespondence(client, ticket.id),
        this.tickets.listStatusEvents(client, ticket.id),
        this.slaRepo.listEscalations(client, ticket.id),
        this.slaRepo.listTimers(client, ticket.id),
      ]);
      const pendingTask = await this.verification.findPendingIdentityTask(client, ticket.id);

      return {
        ticket: toTicket(ticket),
        correspondence: correspondence.map((row) => ({
          id: row.id,
          direction: row.direction,
          authorType: row.author_type,
          authorUserId: row.author_user_id,
          authorLabel: row.author_label,
          body: row.body,
          createdAt: row.created_at.toISOString(),
        })),
        statusHistory: statusHistory.map((row) => ({
          fromStatus: row.from_status,
          toStatus: row.to_status,
          actorType: row.actor_type,
          actorUserId: row.actor_user_id,
          reason: row.reason,
          occurredAt: row.occurred_at.toISOString(),
        })),
        escalations: escalations.map((row) => ({
          level: row.level,
          rung: row.rung,
          trigger: row.trigger_reason,
          notifiedUserId: row.notified_user_id,
          notifiedContact: row.notified_contact,
          notifiedOk: row.notified_ok,
          reason: row.reason,
          occurredAt: row.occurred_at.toISOString(),
        })),
        identityVerification: pendingTask
          ? {
              status: pendingTask.status,
              outcome: pendingTask.outcome,
              reason: pendingTask.reason,
              completedBy: pendingTask.completed_by,
              completedAt: pendingTask.completed_at?.toISOString() ?? null,
            }
          : null,
        timers: timers.map((t) => ({
          level: t.level,
          rung: t.rung,
          dueAt: t.due_at.toISOString(),
          status: t.status,
          firedAt: t.fired_at?.toISOString() ?? null,
        })),
      };
    });
  }

  /**
   * The FR-GRV-04 work queue: every request waiting on a human at this tenant to
   * answer the question the platform may not.
   *
   * What each row hands the verifier is the whole of what the platform can give
   * them — a channel it proved, and its value. Everything else is on their side
   * of the line.
   */
  async listIdentityTasks(
    status: 'pending' | 'completed',
    limit: number,
  ): Promise<IdentityVerificationTask[]> {
    const rows = await this.verification.listIdentityTasks(status, limit);
    return rows.map((row) => ({
      id: row.id,
      ticketId: row.ticket_id,
      referenceCode: row.reference_code,
      status: row.status,
      outcome: row.outcome,
      reason: row.reason,
      completedBy: row.completed_by,
      completedAt: row.completed_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      verifiedChannel: row.contact_channel,
      verifiedContact: row.contact_value,
      contactVerifiedAt: row.contact_verified_at?.toISOString() ?? null,
    }));
  }

  // --- the handoff (FR-GRV-04) ---------------------------------------------

  /**
   * A staff member answers "is this our customer?" against their own records and
   * records the verdict.
   *
   * THIS METHOD IS THE ARCHITECTURAL POINT OF THE WHOLE SUBSTRATE, so it is
   * worth being explicit about what it does not do. It performs no lookup. It
   * takes no customer identifier. It has no way to reach the client's systems
   * and never will (S4 has no readRows, permanently). The platform orchestrates
   * the workflow — it created the task, it is holding a clock over it, and it
   * will record who answered and when — and the answer itself comes from a human
   * with access the platform does not have (I1).
   *
   * The three outcomes go three different ways, and the difference matters:
   *   matched      -> the request proceeds; it becomes assignable work.
   *   not_matched  -> the request is closed with a stated reason, and the clock
   *                   is cancelled. The trail keeps the whole thing forever: a
   *                   refusal is evidence too, and "we decided you were not our
   *                   customer" is exactly the decision a regulator reviews.
   *   inconclusive -> nothing moves. The task stays open, the clock keeps
   *                   running, and the escalation ladder keeps climbing —
   *                   because an unanswerable identity check is a problem that
   *                   should reach the DPO, not one that quietly stalls.
   */
  async completeIdentityVerification(
    ticketId: string,
    input: CompleteIdentityVerificationBody,
  ): Promise<{ ticket: RequestTicket; outcome: string }> {
    const ctx = this.tenantContext.getOrThrow();

    const result = await this.db.withTenant(async (client) => {
      const ticket = await this.requireTicket(client, ticketId);
      if (ticket.status !== 'pending_identity_verification') {
        throw new ConflictException(
          `This request is ${ticket.status}; it is not awaiting identity verification.`,
        );
      }
      const task = await this.verification.findPendingIdentityTask(client, ticket.id);
      if (!task) {
        throw new ConflictException('No identity-verification task is open for this request.');
      }

      const completed = await this.verification.completeIdentityTask(client, {
        taskId: task.id,
        outcome: input.outcome,
        reason: input.reason,
        completedBy: ctx.userId,
      });
      if (!completed) {
        throw new ConflictException('That task was completed by someone else.');
      }

      if (input.outcome === 'inconclusive') {
        // Re-open a fresh task: the question is still open and still owned by
        // someone. Leaving no task would drop it out of the queue while the
        // ticket sat in pending_identity_verification forever.
        await this.verification.openIdentityTask(client, ticket.id);
        await this.tickets.appendCorrespondence(client, {
          ticketId: ticket.id,
          direction: 'internal_note',
          authorType: 'staff',
          authorUserId: ctx.userId,
          authorLabel: null,
          body: `Identity verification inconclusive: ${input.reason}`,
        });
        return { ticket, outcome: input.outcome, moved: null as TicketRow | null };
      }

      if (input.outcome === 'not_matched') {
        const closed = await this.tickets.transition(client, {
          ticketId: ticket.id,
          expectedFrom: ['pending_identity_verification'],
          to: 'closed',
          actorType: 'staff',
          actorUserId: ctx.userId,
          reason: `Identity could not be matched to a customer record: ${input.reason}`,
          resolution: 'Closed: requester could not be identified as a data principal of this organisation.',
        });
        await this.slaService.cancelClock(client, ticket.id);
        return { ticket, outcome: input.outcome, moved: closed };
      }

      const assigned = await this.tickets.transition(client, {
        ticketId: ticket.id,
        expectedFrom: ['pending_identity_verification'],
        to: 'assigned',
        actorType: 'staff',
        actorUserId: ctx.userId,
        // The verifier owns it unless they hand it to someone else in the same
        // breath — a request that is verified and unowned is how SLAs are missed.
        assignedTo: input.assignTo ?? ctx.userId,
        reason: `Identity verified against the organisation own records: ${input.reason}`,
      });
      return { ticket, outcome: input.outcome, moved: assigned };
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: result.ticket.id,
      reason: input.reason,
      beforeState: { status: result.ticket.status, identityVerification: 'pending' },
      afterState: {
        status: result.moved?.status ?? result.ticket.status,
        identityVerification: 'completed',
        outcome: input.outcome,
      },
    });

    return { ticket: toTicket(result.moved ?? result.ticket), outcome: input.outcome };
  }

  // --- lifecycle -----------------------------------------------------------

  async assign(ticketId: string, input: AssignBody): Promise<RequestTicket> {
    const ctx = this.tenantContext.getOrThrow();
    const ticket = await this.db.withTenant(async (client) => {
      const existing = await this.requireTicket(client, ticketId);
      const moved = await this.tickets.transition(client, {
        ticketId: existing.id,
        expectedFrom: ['assigned', 'in_progress'],
        to: existing.status === 'in_progress' ? 'in_progress' : 'assigned',
        actorType: 'staff',
        actorUserId: ctx.userId,
        assignedTo: input.assigneeUserId,
        reason: input.reason,
      });
      if (!moved) {
        throw new ConflictException(
          `A ${existing.status} request cannot be assigned. Complete identity verification first.`,
        );
      }
      return { existing, moved };
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticket.moved.id,
      reason: input.reason,
      beforeState: { assignedTo: ticket.existing.assigned_to },
      afterState: { assignedTo: input.assigneeUserId },
    });
    return toTicket(ticket.moved);
  }

  /**
   * Move a ticket along. The permitted moves are declared as data below rather
   * than as a chain of `if`s, so "what can follow what" is one table a reviewer
   * can read — and so the lifecycle in the migration's CHECK, the one in
   * @dpdp/shared, and the one enforced here cannot quietly diverge.
   */
  async changeStatus(ticketId: string, input: ChangeStatusBody): Promise<RequestTicket> {
    const ctx = this.tenantContext.getOrThrow();
    const allowedFrom = STAFF_TRANSITIONS[input.status];

    const result = await this.db.withTenant(async (client) => {
      const existing = await this.requireTicket(client, ticketId);
      const moved = await this.tickets.transition(client, {
        ticketId: existing.id,
        expectedFrom: allowedFrom,
        to: input.status,
        actorType: 'staff',
        actorUserId: ctx.userId,
        reason: input.reason,
        resolution: input.resolution ?? null,
      });
      if (!moved) {
        throw new ConflictException(
          `A ${existing.status} request cannot move to ${input.status}. ` +
            `Allowed from: ${allowedFrom.join(', ')}.`,
        );
      }

      // Closing early stops the clock — nobody should be chased about a
      // complaint that has been answered.
      if (CLOSED_REQUEST_STATUSES.includes(input.status)) {
        await this.slaService.cancelClock(client, moved.id);
      }
      return { existing, moved };
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: result.moved.id,
      reason: input.reason,
      beforeState: { status: result.existing.status },
      afterState: { status: result.moved.status, resolution: result.moved.resolution },
    });
    return toTicket(result.moved);
  }

  async addCorrespondence(
    ticketId: string,
    input: StaffCorrespondenceBody,
  ): Promise<{ id: string; createdAt: string }> {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.db.withTenant(async (client) => {
      const ticket = await this.requireTicket(client, ticketId);
      const entry = await this.tickets.appendCorrespondence(client, {
        ticketId: ticket.id,
        direction: input.direction,
        authorType: 'staff',
        authorUserId: ctx.userId,
        authorLabel: null,
        body: input.body,
      });
      return { ticket, entry };
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: result.ticket.id,
      reason: `Staff added ${input.direction} correspondence`,
      afterState: { correspondenceId: result.entry.id, direction: input.direction },
    });
    return { id: result.entry.id, createdAt: result.entry.created_at.toISOString() };
  }

  /** Escalate now, without waiting for the clock (FR-GRV-05). Climbs to the next
   *  rung of the same ladder the deadlines would have climbed, so a manual
   *  escalation and an automatic one are the same ladder, not two. */
  async escalateNow(ticketId: string, reason: string): Promise<RequestEscalation> {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.db.withTenant(async (client) => {
      const ticket = await this.requireTicket(client, ticketId);
      if (CLOSED_REQUEST_STATUSES.includes(ticket.status)) {
        throw new BadRequestException(`A ${ticket.status} request cannot be escalated.`);
      }
      const next = await this.slaService.nextManualRung(client, ticket);
      if (!next) {
        throw new BadRequestException('This request is already at the top of its escalation ladder.');
      }
      const escalation = await this.escalation.escalate(client, {
        tenantId: ctx.tenantId,
        ticketId: ticket.id,
        referenceCode: ticket.reference_code,
        subject: ticket.subject,
        level: next.level,
        rung: next.rung,
        trigger: 'manual',
        notify: next.holder ? { userId: next.holder.userId, contact: next.holder.email } : null,
        reason,
        slaDueAt: ticket.sla_due_at,
      });
      if (!escalation) {
        throw new ConflictException('This request has already been escalated to that level.');
      }
      return { ticket, escalation };
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: result.ticket.id,
      reason,
      afterState: {
        escalationLevel: result.escalation.level,
        rung: result.escalation.rung,
        trigger: 'manual',
        notified: result.escalation.notified_ok,
      },
    });

    return {
      level: result.escalation.level,
      rung: result.escalation.rung,
      trigger: result.escalation.trigger_reason,
      notifiedUserId: result.escalation.notified_user_id,
      notifiedContact: result.escalation.notified_contact,
      notifiedOk: result.escalation.notified_ok,
      reason: result.escalation.reason,
      occurredAt: result.escalation.occurred_at.toISOString(),
    };
  }

  // --- SLA policy (deadlines are data) -------------------------------------

  async listPolicies(): Promise<RequestSlaPolicy[]> {
    const rows = await this.slaRepo.listPolicies();
    const byType = new Map(rows.map((r) => [r.request_type, r]));
    return (['grievance', 'dprequest'] as RequestType[]).map((requestType) => {
      const row = byType.get(requestType);
      if (row) {
        return {
          requestType,
          slaSeconds: row.sla_seconds,
          ladder: row.ladder,
          isDefault: false,
          updatedAt: row.updated_at.toISOString(),
        };
      }
      const fallback = defaultPolicyFor(requestType);
      return { requestType, ...fallback, isDefault: true, updatedAt: null };
    });
  }

  /**
   * Set a tenant's SLA policy.
   *
   * Note what changing it does NOT do: it does not move any existing ticket's
   * deadline. Each ticket snapshotted the policy that applied when its clock
   * started, and re-judging yesterday's complaint against today's rules would
   * destroy the one thing the snapshot is for (I4). New requests get the new
   * policy; open ones keep the one they were filed under.
   */
  async setPolicy(input: SetSlaPolicyBody): Promise<RequestSlaPolicy> {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.db.withTenant(async (client) => {
      const before = await this.slaRepo.findPolicy(client, input.requestType);
      const row = await this.slaRepo.upsertPolicy(client, {
        requestType: input.requestType,
        slaSeconds: input.slaSeconds,
        ladder: input.ladder,
        updatedBy: ctx.userId,
      });
      return { before, row };
    });

    this.audit.annotate({
      targetType: 'request_sla_policy',
      targetId: input.requestType,
      reason: 'SLA policy updated',
      beforeState: result.before
        ? { slaSeconds: result.before.sla_seconds, ladder: result.before.ladder }
        : { source: 'platform default' },
      afterState: { slaSeconds: input.slaSeconds, ladder: input.ladder },
    });

    return {
      requestType: result.row.request_type,
      slaSeconds: result.row.sla_seconds,
      ladder: result.row.ladder,
      isDefault: false,
      updatedAt: result.row.updated_at.toISOString(),
    };
  }

  // --- versioned deadline policy ------------------------------------------
  //
  // Thin delegations to DeadlinePolicyService, which Breach uses identically.
  // They stay on RequestService so the substrate's own callers (and its HTTP
  // surface) do not have to learn a second service — but the mechanism itself
  // is no longer this module's, and that is deliberate: three domains sharing
  // one deadline register is the whole point of FR-BRC-02.

  listPolicyVersions(requestType: RequestType): Promise<DeadlinePolicyVersionRow[]> {
    return this.policies.listVersions(requestType);
  }

  /** The policy a NEW ticket with this key would be judged under right now. */
  effectivePolicy(requestType: RequestType, policyKey: string): Promise<ResolvedPolicy> {
    return this.db.withTenant((client) => this.slaService.policyFor(client, requestType, policyKey));
  }

  supersedePolicy(input: {
    requestType: RequestType;
    policyKey: string;
    slaSeconds: number;
    ladder: EscalationLadderStep[];
    effectiveFrom: Date;
    note: string | null;
  }): Promise<DeadlinePolicyVersionRow> {
    const { requestType, ...rest } = input;
    return this.policies.supersede({ domain: requestType, ...rest });
  }

  ensurePolicyVersions(
    requestType: RequestType,
    seeds: { policyKey: string; slaSeconds: number; ladder: EscalationLadderStep[]; note: string }[],
  ): Promise<number> {
    return this.policies.ensureSeeded(requestType, seeds);
  }

  private async requireTicket(client: PoolClient, ticketId: string): Promise<TicketRow> {
    const ticket = await this.tickets.findById(client, ticketId);
    if (!ticket) {
      throw new NotFoundException('Request not found.');
    }
    return ticket;
  }
}

/**
 * Which statuses a staff member may move a ticket FROM, for each status they may
 * move it TO. Everything before `assigned` is absent by construction: those
 * states are reached by the requester proving their channel and by the handoff
 * being completed, and nobody gets to declare them.
 */
const STAFF_TRANSITIONS: Record<StaffSettableStatus, RequestStatus[]> = {
  in_progress: ['assigned', 'in_progress'],
  resolved: ['assigned', 'in_progress'],
  // A request can be closed from anywhere it is still live — including while it
  // waits on identity verification, which is how a duplicate or withdrawn
  // request leaves the queue.
  closed: ['pending_identity_verification', 'assigned', 'in_progress', 'resolved'],
};

function toTicket(row: TicketRow): RequestTicket {
  return {
    id: row.id,
    requestType: row.request_type,
    referenceCode: row.reference_code,
    status: row.status,
    subject: row.subject,
    contactChannel: row.contact_channel,
    contactValue: row.contact_value,
    contactVerifiedAt: row.contact_verified_at?.toISOString() ?? null,
    escalationLevel: row.escalation_level,
    assignedTo: row.assigned_to,
    slaDueAt: row.sla_due_at?.toISOString() ?? null,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}
