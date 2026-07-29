import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EscalationRung, EscalationTrigger } from '@dpdp/shared';
import { NotificationDispatcher } from '../notify/notification-dispatcher';
import { RequestSlaRepository, type EscalationRow } from './request-sla.repository';
import { RequestTicketsRepository } from './request-tickets.repository';

/**
 * What "escalate" actually means, in one place, for both callers: the SLA
 * deadline that fired in the WORKER, and the staff member in the API who
 * decided not to wait for it (FR-GRV-05).
 *
 * It lives in the worker-safe half of the module (RequestStoreModule) precisely
 * so those two callers can share it. That constrains what it may depend on —
 * repositories and the notification dispatcher, nothing from identity, nothing
 * from the audit context — and the constraint is load-bearing: injecting
 * IdentityService here would boot-crash the worker process the moment it
 * resolved this module's graph, for exactly the reason notify.module.ts
 * documents. Whoever is to be notified is therefore resolved by the CALLER (from
 * a timer's snapshot in the worker, from IdentityService in the API) and handed
 * in as a plain address.
 *
 * ON AUDIT. An escalation raised through the API is audited by the S5
 * interceptor like every other HTTP mutation. One raised by a fired deadline is
 * NOT — the worker has no HTTP request, and the audit sink has exactly one
 * writer by design (R3), so there is no honest way for a background process to
 * append to the chain without becoming a second writer. That is a real gap and
 * it is named rather than papered over. What backs the automatic path instead is
 * `request_escalations` itself: tenant-scoped, RLS-enforced, append-only by
 * trigger for every role including the owner. It is evidence of the same
 * quality; it is simply not in the same chain. Closing the gap properly means a
 * worker-side audit path, which is a deliberate design decision and not
 * something to slip in behind an escalation feature.
 */
@Injectable()
export class RequestEscalationService {
  private readonly logger = new Logger(RequestEscalationService.name);

  constructor(
    private readonly tickets: RequestTicketsRepository,
    private readonly sla: RequestSlaRepository,
    private readonly notifier: NotificationDispatcher,
  ) {}

  /**
   * Reach a rung: notify whoever holds it, record that it happened, and move the
   * ticket's escalation level up.
   *
   * Runs entirely on the caller's `client`, so in the worker it commits with the
   * deadline's own state transition, and in the API it commits with that
   * request's audit entry. There is no path where the ticket says it escalated
   * and the trail does not, or vice versa.
   *
   * An unheld rung (nobody designated, or the holder is no longer active) is
   * recorded with notified_ok = false rather than skipped. "We had nobody to
   * tell" is a fact a regulator would want to see; a missing row would read as
   * "the deadline never came".
   */
  async escalate(
    client: PoolClient,
    input: {
      ticketId: string;
      referenceCode: string;
      subject: string;
      level: number;
      rung: EscalationRung;
      trigger: EscalationTrigger;
      notify: { userId: string | null; contact: string | null } | null;
      reason: string;
      slaDueAt: Date | null;
    },
  ): Promise<EscalationRow | null> {
    let notifiedOk: boolean | null = null;

    if (input.notify?.contact) {
      const result = await this.notifier.send({
        channel: 'email',
        to: input.notify.contact,
        subject: `[${input.referenceCode}] Escalation — ${labelFor(input.rung)}`,
        body: escalationBody(input),
        kind: 'escalation',
        // Ids only. The requester's own contact details and their complaint text
        // are deliberately not in an escalation alert: the rung holder opens the
        // ticket to see those, under RLS and with the read recorded.
        context: { ticketId: input.ticketId, level: String(input.level), rung: input.rung },
      });
      notifiedOk = result.delivered;
      if (!result.delivered) {
        this.logger.warn(
          `Escalation ${input.referenceCode} level ${input.level} (${input.rung}) could not be delivered: ${result.error ?? 'unknown'}`,
        );
      }
    } else {
      notifiedOk = false;
      this.logger.warn(
        `Escalation ${input.referenceCode} level ${input.level}: no active holder for rung "${input.rung}". ` +
          'Recorded as undeliverable — the tenant has not designated one (FR-IDN-04).',
      );
    }

    const escalation = await this.sla.recordEscalation(client, {
      ticketId: input.ticketId,
      level: input.level,
      rung: input.rung,
      trigger: input.trigger,
      notifiedUserId: input.notify?.userId ?? null,
      notifiedContact: input.notify?.contact ?? null,
      notifiedOk,
      reason: input.reason,
    });

    // Null means the unique constraint caught a duplicate — already escalated to
    // this level, nothing to bump.
    if (escalation) {
      await this.tickets.bumpEscalationLevel(client, input.ticketId, input.level);
    }
    return escalation;
  }
}

function labelFor(rung: EscalationRung): string {
  switch (rung) {
    case 'grievance_officer':
      return 'Grievance Officer';
    case 'dpo':
      return 'Data Protection Officer';
    case 'escalation_contact':
      return 'Escalation contact';
  }
}

function escalationBody(input: {
  referenceCode: string;
  subject: string;
  level: number;
  trigger: EscalationTrigger;
  reason: string;
  slaDueAt: Date | null;
}): string {
  const due = input.slaDueAt ? input.slaDueAt.toISOString() : 'not set';
  const because =
    input.trigger === 'sla_breach'
      ? 'its response deadline has been reached'
      : input.trigger === 'sla_proximity'
        ? 'it is approaching its response deadline'
        : 'a colleague escalated it manually';
  return [
    `Request ${input.referenceCode} has been escalated to you because ${because}.`,
    '',
    `Subject:  ${input.subject}`,
    `Deadline: ${due}`,
    `Level:    ${input.level}`,
    `Reason:   ${input.reason}`,
    '',
    'Open the request in the compliance workspace to respond.',
  ].join('\n');
}
