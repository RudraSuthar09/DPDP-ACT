import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  EscalationLadderStep,
  EscalationRung,
  EscalationTrigger,
  RequestType,
} from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * SLA policy, the ticket's scheduled ladder, and the escalation trail.
 *
 * Note what is NOT in this file: any statement naming the S3 deadline register.
 * `request_sla_timers` records what the ticket ASKED FOR and what each deadline
 * MEANS; when the deadline fires is the WorkflowRunner's business, reached only
 * through the runner interface. The two stores meet exactly once, on
 * `workflow_id`, and nowhere else.
 */

export interface SlaPolicyRow {
  request_type: RequestType;
  sla_seconds: number;
  ladder: EscalationLadderStep[];
  updated_at: Date;
}

export interface SlaTimerRow {
  id: string;
  ticket_id: string;
  level: number;
  rung: EscalationRung;
  trigger_reason: Exclude<EscalationTrigger, 'manual'>;
  workflow_id: string;
  due_at: Date;
  notify_user_id: string | null;
  notify_contact: string | null;
  status: 'scheduled' | 'fired' | 'cancelled';
  fired_at: Date | null;
}

export interface EscalationRow {
  level: number;
  rung: EscalationRung;
  trigger_reason: EscalationTrigger;
  notified_user_id: string | null;
  notified_contact: string | null;
  notified_ok: boolean | null;
  reason: string | null;
  occurred_at: Date;
}

@Injectable()
export class RequestSlaRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- policy ---------------------------------------------------------------

  async findPolicy(client: PoolClient, requestType: RequestType): Promise<SlaPolicyRow | null> {
    const { rows } = await client.query<SlaPolicyRow>(
      `SELECT request_type, sla_seconds, ladder, updated_at
         FROM request_sla_policies WHERE request_type = $1`,
      [requestType],
    );
    return rows[0] ?? null;
  }

  listPolicies(): Promise<SlaPolicyRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<SlaPolicyRow>(
        `SELECT request_type, sla_seconds, ladder, updated_at
           FROM request_sla_policies ORDER BY request_type`,
      );
      return rows;
    });
  }

  async upsertPolicy(
    client: PoolClient,
    input: {
      requestType: RequestType;
      slaSeconds: number;
      ladder: EscalationLadderStep[];
      updatedBy: string;
    },
  ): Promise<SlaPolicyRow> {
    const { rows } = await client.query<SlaPolicyRow>(
      `INSERT INTO request_sla_policies (request_type, sla_seconds, ladder, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (tenant_id, request_type) DO UPDATE
         SET sla_seconds = EXCLUDED.sla_seconds,
             ladder = EXCLUDED.ladder,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()
       RETURNING request_type, sla_seconds, ladder, updated_at`,
      [input.requestType, input.slaSeconds, JSON.stringify(input.ladder), input.updatedBy],
    );
    return rows[0]!;
  }

  // --- the ticket's scheduled ladder ---------------------------------------

  async insertTimer(
    client: PoolClient,
    input: {
      ticketId: string;
      level: number;
      rung: EscalationRung;
      trigger: Exclude<EscalationTrigger, 'manual'>;
      workflowId: string;
      dueAt: Date;
      notifyUserId: string | null;
      notifyContact: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO request_sla_timers
         (ticket_id, level, rung, trigger_reason, workflow_id, due_at, notify_user_id, notify_contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, ticket_id, level) DO UPDATE
         SET rung = EXCLUDED.rung,
             trigger_reason = EXCLUDED.trigger_reason,
             workflow_id = EXCLUDED.workflow_id,
             due_at = EXCLUDED.due_at,
             notify_user_id = EXCLUDED.notify_user_id,
             notify_contact = EXCLUDED.notify_contact,
             status = 'scheduled',
             fired_at = NULL`,
      [
        input.ticketId,
        input.level,
        input.rung,
        input.trigger,
        input.workflowId,
        input.dueAt.toISOString(),
        input.notifyUserId,
        input.notifyContact,
      ],
    );
  }

  /** The worker's entry point: given the id a deadline fired for, what did the
   *  ticket mean by it? */
  async findTimerByWorkflowId(client: PoolClient, workflowId: string): Promise<SlaTimerRow | null> {
    const { rows } = await client.query<SlaTimerRow>(
      `SELECT id, ticket_id, level, rung, trigger_reason, workflow_id, due_at,
              notify_user_id, notify_contact, status, fired_at
         FROM request_sla_timers WHERE workflow_id = $1`,
      [workflowId],
    );
    return rows[0] ?? null;
  }

  async listTimers(client: PoolClient, ticketId: string): Promise<SlaTimerRow[]> {
    const { rows } = await client.query<SlaTimerRow>(
      `SELECT id, ticket_id, level, rung, trigger_reason, workflow_id, due_at,
              notify_user_id, notify_contact, status, fired_at
         FROM request_sla_timers WHERE ticket_id = $1 ORDER BY level`,
      [ticketId],
    );
    return rows;
  }

  /**
   * Claim a timer. Returns true ONLY if it actually moved a `scheduled` row, so
   * a cancelled, superseded, or already-fired timer is a no-op — deliberately
   * the same exactly-once trick the S3 deadline register uses one layer down,
   * and the reason a deadline seen by both pg-boss and the reconciliation ticker
   * escalates once rather than twice.
   */
  async markTimerFired(client: PoolClient, timerId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE request_sla_timers SET status = 'fired', fired_at = now()
        WHERE id = $1 AND status = 'scheduled'`,
      [timerId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Called when a ticket closes early. Marks the domain rows cancelled; pulling
   *  the actual deadlines is the caller's job, through the runner. */
  async cancelTimers(client: PoolClient, ticketId: string): Promise<string[]> {
    const { rows } = await client.query<{ workflow_id: string }>(
      `UPDATE request_sla_timers SET status = 'cancelled'
        WHERE ticket_id = $1 AND status = 'scheduled'
        RETURNING workflow_id`,
      [ticketId],
    );
    return rows.map((r) => r.workflow_id);
  }

  // --- the escalation trail -------------------------------------------------

  /**
   * Record that a rung was reached.
   *
   * ON CONFLICT DO NOTHING against the UNIQUE (tenant, ticket, level): escalation
   * is idempotent at the database, so a deadline delivered twice (pg-boss and the
   * reconciliation ticker can both see the same job) escalates once. Returns null
   * when it was already recorded, which is how the caller knows not to send a
   * second alert.
   */
  async recordEscalation(
    client: PoolClient,
    input: {
      ticketId: string;
      level: number;
      rung: EscalationRung;
      trigger: EscalationTrigger;
      notifiedUserId: string | null;
      notifiedContact: string | null;
      notifiedOk: boolean | null;
      reason: string;
    },
  ): Promise<EscalationRow | null> {
    const { rows } = await client.query<EscalationRow>(
      `INSERT INTO request_escalations
         (ticket_id, level, rung, trigger_reason, notified_user_id, notified_contact,
          notified_ok, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, ticket_id, level) DO NOTHING
       RETURNING level, rung, trigger_reason, notified_user_id, notified_contact,
                 notified_ok, reason, occurred_at`,
      [
        input.ticketId,
        input.level,
        input.rung,
        input.trigger,
        input.notifiedUserId,
        input.notifiedContact,
        input.notifiedOk,
        input.reason,
      ],
    );
    return rows[0] ?? null;
  }

  async listEscalations(client: PoolClient, ticketId: string): Promise<EscalationRow[]> {
    const { rows } = await client.query<EscalationRow>(
      `SELECT level, rung, trigger_reason, notified_user_id, notified_contact,
              notified_ok, reason, occurred_at
         FROM request_escalations WHERE ticket_id = $1 ORDER BY level`,
      [ticketId],
    );
    return rows;
  }

  /** The highest level already escalated — what a manual escalation climbs from. */
  async currentEscalationLevel(client: PoolClient, ticketId: string): Promise<number> {
    const { rows } = await client.query<{ level: number | null }>(
      `SELECT max(level) AS level FROM request_escalations WHERE ticket_id = $1`,
      [ticketId],
    );
    return rows[0]?.level ?? 0;
  }
}
