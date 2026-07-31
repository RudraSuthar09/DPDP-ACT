import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SYSTEM_WORKER_BREACH_DEADLINE_ACTOR_LABEL } from '@dpdp/shared';
import { NotificationDispatcher } from '../notify/notification-dispatcher';
import { SystemAuditService } from '../audit/system-audit.service';
import { BreachRepository } from './breach.repository';

/**
 * What "escalate an incident" means, in one place, for both callers: the gate
 * deadline that fired in the WORKER, and (later) a human deciding not to wait.
 *
 * Worker-safe by construction — repositories, the notification dispatcher, and
 * `SystemAuditService` (see below) only, nothing from identity, nothing from
 * the annotate-based audit context. Injecting IdentityService here would
 * boot-crash the worker process the moment it resolved this module's graph,
 * exactly as `RequestEscalationService` documents. Whoever is to be told is
 * therefore resolved by the CALLER (from the deadline row's snapshot, taken
 * when it was scheduled) and handed in as a plain address.
 *
 * =========================================================================
 * ON AUDIT — THE GAP THIS FILE ONCE DOCUMENTED IS NOW CLOSED.
 *
 * An escalation raised through the API is audited by the S5 interceptor like
 * every other HTTP mutation. One raised by a FIRED DEADLINE used to be
 * invisible to the chain, because the worker has no HTTP request for the
 * interceptor to attach to. `RequestEscalationService` named the gap first;
 * this file named it a second time and pointed at the fix rather than take it
 * unasked. Both now call `SystemAuditService` — a second SANCTIONED CALLER of
 * the one sink (not a second writer; see its own header for the full R3
 * argument) — from exactly the same place `request-escalation.service.ts`
 * does: gated on the trigger being one only the worker produces, never
 * `'manual'`, so a future manual "escalate now" for Breach is not double-audited
 * the day it is added.
 * =========================================================================
 */
@Injectable()
export class BreachEscalationService {
  private readonly logger = new Logger(BreachEscalationService.name);

  constructor(
    private readonly repo: BreachRepository,
    private readonly notifier: NotificationDispatcher,
    private readonly systemAudit: SystemAuditService,
  ) {}

  /**
   * Reach a rung: tell whoever holds it, and record that it happened.
   *
   * Runs entirely on the caller's `client`, so in the worker it commits with the
   * deadline's own state transition. There is no path where the incident says it
   * escalated and the trail does not, or the reverse.
   *
   * An unheld rung (nobody designated) is recorded with notified_ok = false
   * rather than skipped. "We had nobody to tell" is a fact a regulator would
   * want to see; a missing row would read as "the deadline never came".
   */
  async escalate(
    client: PoolClient,
    input: {
      tenantId: string;
      incidentId: string;
      referenceCode: string;
      title: string;
      gate: string;
      level: number;
      rung: string;
      trigger: 'sla_proximity' | 'sla_breach' | 'manual';
      notify: { userId: string | null; contact: string | null } | null;
      reason: string;
      dueAt: Date;
    },
  ): Promise<boolean> {
    let notifiedOk: boolean | null = null;

    if (input.notify?.contact) {
      const result = await this.notifier.send({
        tenantId: input.tenantId,
        channel: 'email',
        to: input.notify.contact,
        subject: `[${input.referenceCode}] Breach deadline — ${input.gate.replace(/_/g, ' ')}`,
        body: escalationBody(input),
        kind: 'escalation',
        // Ids only. An incident's details stay in the register, read under RLS
        // with the access recorded — not scattered into inboxes.
        context: {
          incidentId: input.incidentId,
          gate: input.gate,
          level: String(input.level),
        },
      });
      notifiedOk = result.delivered;
      if (!result.delivered) {
        this.logger.warn(
          `Breach escalation ${input.referenceCode} ${input.gate} L${input.level} undeliverable: ${result.error ?? 'unknown'}`,
        );
      }
    } else {
      notifiedOk = false;
      this.logger.warn(
        `Breach escalation ${input.referenceCode} ${input.gate} L${input.level}: no active holder for ` +
          `rung "${input.rung}". Recorded as undeliverable — the tenant has not designated one (FR-IDN-04).`,
      );
    }

    const recorded = await this.repo.recordEscalation(client, {
      incidentId: input.incidentId,
      gate: input.gate,
      level: input.level,
      rung: input.rung,
      trigger: input.trigger,
      notifiedUserId: input.notify?.userId ?? null,
      notifiedContact: input.notify?.contact ?? null,
      notifiedOk,
      reason: input.reason,
    });

    // `recorded` is false when the unique constraint caught a duplicate —
    // already escalated to this level. Nothing new happened, so nothing new
    // gets an audit entry either.
    if (recorded && input.trigger !== 'manual') {
      await this.systemAudit.record(client, input.tenantId, {
        action: 'breach.escalation.fired',
        outcome: 'success',
        correlationId: randomUUID(),
        actorLabel: SYSTEM_WORKER_BREACH_DEADLINE_ACTOR_LABEL,
        targetType: 'breach_incident',
        targetId: input.incidentId,
        reason: input.reason,
        afterState: {
          referenceCode: input.referenceCode,
          gate: input.gate,
          level: input.level,
          rung: input.rung,
          trigger: input.trigger,
          notifiedOk,
        },
      });
    }

    return recorded;
  }
}

function escalationBody(input: {
  referenceCode: string;
  title: string;
  gate: string;
  level: number;
  trigger: string;
  dueAt: Date;
}): string {
  const because =
    input.trigger === 'sla_breach'
      ? 'its deadline has been reached'
      : input.trigger === 'sla_proximity'
        ? 'it is approaching its deadline'
        : 'a colleague escalated it manually';
  return [
    `Breach incident ${input.referenceCode} has been escalated to you because ${because}.`,
    '',
    `Incident: ${input.title}`,
    `Gate:     ${input.gate.replace(/_/g, ' ')}`,
    `Deadline: ${input.dueAt.toISOString()}`,
    `Level:    ${input.level}`,
    '',
    'Open the Breach Register in the compliance workspace to act on it.',
  ].join('\n');
}
