import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  SYSTEM_WORKER_ESCALATION_ACTOR_LABEL,
  type EscalationRung,
  type EscalationTrigger,
} from '@dpdp/shared';
import { NotificationDispatcher } from '../notify/notification-dispatcher';
import { SystemAuditService } from '../audit/system-audit.service';
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
 * interceptor like every other HTTP mutation — `RequestService.escalateNow`
 * already annotates it and the route carries `@Audited(...)`, so nothing new
 * is needed for that path. One raised by a FIRED DEADLINE used to be invisible
 * to the chain: the worker has no HTTP request, so the interceptor never runs.
 * That gap is now closed by `SystemAuditService` (see its header for the full
 * argument for why it is a second sanctioned CALLER of the one sink, not a
 * second writer) — injected here specifically because this service, not the
 * handler that calls it, is the one place both the worker path and the manual
 * path already converge, so the trigger-based gate below is written once.
 */
@Injectable()
export class RequestEscalationService {
  private readonly logger = new Logger(RequestEscalationService.name);

  constructor(
    private readonly tickets: RequestTicketsRepository,
    private readonly sla: RequestSlaRepository,
    private readonly notifier: NotificationDispatcher,
    private readonly systemAudit: SystemAuditService,
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
   *
   * `tenantId` is required from every caller, but the S5 write below fires ONLY
   * when `trigger !== 'manual'` — i.e. only for the worker's own two triggers.
   * A manual escalation (`RequestService.escalateNow`) already lands in the
   * chain through the ordinary HTTP path; writing here too would double it.
   */
  async escalate(
    client: PoolClient,
    input: {
      tenantId: string;
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
        tenantId: input.tenantId,
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

      // The worker-only half of this call: a manual escalation is already
      // audited by the interceptor on its own HTTP route, so this fires
      // exclusively for the two triggers only a fired deadline produces.
      if (input.trigger !== 'manual') {
        await this.systemAudit.record(client, input.tenantId, {
          action: 'request.escalation.fired',
          outcome: 'success',
          correlationId: randomUUID(),
          actorLabel: SYSTEM_WORKER_ESCALATION_ACTOR_LABEL,
          targetType: 'request_ticket',
          targetId: input.ticketId,
          reason: input.reason,
          afterState: {
            referenceCode: input.referenceCode,
            level: input.level,
            rung: input.rung,
            trigger: input.trigger,
            notifiedOk,
          },
        });
      }
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
