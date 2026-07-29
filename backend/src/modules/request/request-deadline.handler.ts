import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CLOSED_REQUEST_STATUSES, type WorkflowKind } from '@dpdp/shared';
import type { DeadlineHandler } from '../workflow/deadline-handler';
import { RequestSlaRepository } from './request-sla.repository';
import { RequestTicketsRepository } from './request-tickets.repository';
import { RequestEscalationService } from './request-escalation.service';

/**
 * The request substrate's consuming half of Seam S3 — a provider of
 * WorkerModule ONLY, never of the API's module graph. The API schedules the
 * ladder; this fires it. Same split, and the same reasoning, as WorkflowWorker
 * and WebhookDeliveryWorker.
 *
 * It runs inside the worker's firing transaction on the worker's client, so the
 * deadline's own `fired` transition and the escalation it caused commit
 * together. If this throws, the whole firing rolls back and the reconciliation
 * ticker will present the deadline again — which is the correct behaviour for a
 * transient failure and the reason nothing in here swallows errors it has not
 * deliberately decided to absorb.
 */
@Injectable()
export class RequestDeadlineHandler implements DeadlineHandler {
  private readonly logger = new Logger(RequestDeadlineHandler.name);

  constructor(
    private readonly tickets: RequestTicketsRepository,
    private readonly sla: RequestSlaRepository,
    private readonly escalation: RequestEscalationService,
  ) {}

  /** Both request kinds, and deliberately not 'breach': the Breach Register has
   *  its own deadline semantics (FR-BRC-02/04) and will register its own
   *  handler. Claiming a kind you do not own is how two modules end up silently
   *  acting on the same deadline. */
  handles(kind: WorkflowKind): boolean {
    return kind === 'grievance' || kind === 'dprequest';
  }

  async onDeadline(
    client: PoolClient,
    context: { tenantId: string; workflowId: string; kind: WorkflowKind },
  ): Promise<void> {
    // The join between the two vocabularies: S3 knows an id fired; only this
    // table knows the id meant "warn the DPO at 80%".
    const timer = await this.sla.findTimerByWorkflowId(client, context.workflowId);
    if (!timer) {
      // Not ours. A deadline of the same kind scheduled by something else (the
      // Prompt 6 demo endpoint still does exactly this) is not an error — it
      // simply has no ladder behind it.
      this.logger.debug(`Deadline ${context.workflowId} has no request timer; nothing to escalate.`);
      return;
    }

    // Claim it. Belt to the braces of the S3 register's own exactly-once
    // transition one layer down: if this timer was already fired or was
    // cancelled, stop here rather than escalating a ticket twice or escalating
    // one that has been resolved.
    if (!(await this.sla.markTimerFired(client, timer.id))) {
      return;
    }

    const ticket = await this.tickets.findById(client, timer.ticket_id);
    if (!ticket) {
      this.logger.warn(`Timer ${timer.id} points at a ticket that no longer exists.`);
      return;
    }

    // A ticket resolved between the deadline being scheduled and it firing gets
    // no escalation. Closing SHOULD have cancelled the timers; this is the
    // second line of defence, because "we chased the DPO about a complaint that
    // was answered last week" is a cheap mistake to make and an expensive one to
    // explain.
    if (CLOSED_REQUEST_STATUSES.includes(ticket.status)) {
      this.logger.debug(
        `Ticket ${ticket.reference_code} is ${ticket.status}; skipping level ${timer.level} escalation.`,
      );
      return;
    }

    await this.escalation.escalate(client, {
      ticketId: ticket.id,
      referenceCode: ticket.reference_code,
      subject: ticket.subject,
      level: timer.level,
      rung: timer.rung,
      trigger: timer.trigger_reason,
      // The snapshot taken when the clock started, not a lookup now: the worker
      // process has no identity module to ask, and who a deadline was aimed at
      // is itself evidence (see request_sla_timers in the migration).
      notify: { userId: timer.notify_user_id, contact: timer.notify_contact },
      reason:
        timer.trigger_reason === 'sla_breach'
          ? 'SLA deadline reached with the request still open'
          : `SLA deadline approaching (level ${timer.level})`,
      slaDueAt: ticket.sla_due_at,
    });

    this.logger.log(
      `Escalated ${ticket.reference_code} to level ${timer.level} (${timer.rung}) on ${timer.trigger_reason}.`,
    );
  }
}
