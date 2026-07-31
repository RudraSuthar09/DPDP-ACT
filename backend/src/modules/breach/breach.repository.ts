import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { BreachGate, BreachSeverity } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

export interface IncidentRow {
  id: string;
  reference_code: string;
  title: string;
  what_happened: string;
  discovered_at: Date;
  occurred_at: Date | null;
  systems_affected: string[];
  estimated_affected_count: number | null;
  severity: BreachSeverity;
  current_gate: BreachGate;
  status: 'open' | 'closed';
  closed_at: Date | null;
  closure_note: string | null;
  created_at: Date;
}

export interface GateEventRow {
  gate: BreachGate;
  notes: string;
  completed_by: string | null;
  completed_at: Date;
}

export interface DeadlineRow {
  id: string;
  gate: BreachGate;
  policy_key: string;
  policy_version: number | null;
  due_at: Date;
  level: number;
  rung: string;
  trigger_reason: 'sla_proximity' | 'sla_breach';
  workflow_id: string;
  notify_user_id: string | null;
  notify_contact: string | null;
  status: 'scheduled' | 'fired' | 'cancelled';
}

export interface EvidenceRow {
  id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  description: string | null;
  uploaded_at: Date;
}

export interface BreachEscalationRow {
  gate: string;
  level: number;
  rung: string;
  trigger_reason: string;
  notified_contact: string | null;
  notified_ok: boolean | null;
  reason: string;
  occurred_at: Date;
}

const INCIDENT_COLUMNS = `
  id, reference_code, title, what_happened, discovered_at, occurred_at,
  systems_affected, estimated_affected_count, severity, current_gate, status,
  closed_at, closure_note, created_at
`;

/**
 * Every statement that touches the Breach Register's own tables.
 *
 * Methods take an explicit `client` wherever the caller needs several writes in
 * one transaction — which for a gate transition is always: the gate event, the
 * incident's projected `current_gate`, and (at closure) the cancellation of the
 * remaining deadlines have to land together or the workflow is describable in
 * two contradictory ways at once.
 *
 * Note what is NOT here: any statement naming the S3 deadline register or the
 * shared deadline-policy register. Deadlines are scheduled through the runner
 * interface and policies are read through DeadlinePolicyService (R2/R3); this
 * file owns `breach_*` and nothing else. `breach_deadlines` records what a
 * deadline MEANS to the incident; the two stores meet only on `workflow_id`.
 */
@Injectable()
export class BreachRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  // --- incidents -----------------------------------------------------------

  async insert(
    client: PoolClient,
    input: {
      referenceCode: string;
      title: string;
      whatHappened: string;
      discoveredAt: Date;
      occurredAt: Date | null;
      systemsAffected: string[];
      estimatedAffectedCount: number | null;
      severity: BreachSeverity;
      openedBy: string | null;
    },
  ): Promise<IncidentRow> {
    const { rows } = await client.query<IncidentRow>(
      `INSERT INTO breach_incidents
         (reference_code, title, what_happened, discovered_at, occurred_at,
          systems_affected, estimated_affected_count, severity, opened_by)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9)
       RETURNING ${INCIDENT_COLUMNS}`,
      [
        input.referenceCode,
        input.title,
        input.whatHappened,
        input.discoveredAt.toISOString(),
        input.occurredAt?.toISOString() ?? null,
        input.systemsAffected,
        input.estimatedAffectedCount,
        input.severity,
        input.openedBy,
      ],
    );
    return rows[0]!;
  }

  async findById(client: PoolClient, id: string): Promise<IncidentRow | null> {
    const { rows } = await client.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM breach_incidents WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  list(filters: { status?: 'open' | 'closed'; limit: number }): Promise<IncidentRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS} FROM breach_incidents
          WHERE ($1::text IS NULL OR status = $1)
          ORDER BY discovered_at DESC
          LIMIT $2`,
        [filters.status ?? null, filters.limit],
      );
      return rows;
    });
  }

  /** The incident's `current_gate` is a PROJECTION of the gate-event trail, not
   *  an independent fact — it is only ever moved forward by `recordGate` in the
   *  same transaction that appends the event. */
  async advanceGate(client: PoolClient, id: string, gate: BreachGate): Promise<void> {
    await client.query(
      `UPDATE breach_incidents SET current_gate = $2, updated_at = now() WHERE id = $1`,
      [id, gate],
    );
  }

  async close(
    client: PoolClient,
    id: string,
    input: { signedOffBy: string; note: string },
  ): Promise<IncidentRow | null> {
    const { rows } = await client.query<IncidentRow>(
      `UPDATE breach_incidents
          SET status = 'closed', closed_at = now(),
              closure_signed_off_by = $2, closure_note = $3, updated_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING ${INCIDENT_COLUMNS}`,
      [id, input.signedOffBy, input.note],
    );
    return rows[0] ?? null;
  }

  // --- data categories (references into the Data Inventory) ----------------

  async linkCategories(client: PoolClient, incidentId: string, entryIds: string[]): Promise<void> {
    if (entryIds.length === 0) {
      return;
    }
    await client.query(
      `INSERT INTO breach_incident_categories (incident_id, entry_id)
       SELECT $1, unnest($2::uuid[])
       ON CONFLICT DO NOTHING`,
      [incidentId, entryIds],
    );
  }

  /** The entry ids only. The category NAMES, purposes and legal bases are read
   *  through InventoryModule's service, never joined to here (R2) — that is what
   *  keeps an incident inheriting the register's current truth instead of a
   *  copy taken at intake. */
  async listCategoryEntryIds(client: PoolClient, incidentId: string): Promise<string[]> {
    const { rows } = await client.query<{ entry_id: string }>(
      `SELECT entry_id FROM breach_incident_categories WHERE incident_id = $1`,
      [incidentId],
    );
    return rows.map((r) => r.entry_id);
  }

  // --- gates ---------------------------------------------------------------

  /** Append-only: the UNIQUE (tenant, incident, gate) makes a second attempt a
   *  conflict rather than an overwrite. Returns null when the gate was already
   *  passed, which the caller turns into a 409 rather than a silent no-op. */
  async recordGate(
    client: PoolClient,
    input: { incidentId: string; gate: BreachGate; notes: string; completedBy: string },
  ): Promise<GateEventRow | null> {
    const { rows } = await client.query<GateEventRow>(
      `INSERT INTO breach_gate_events (incident_id, gate, notes, completed_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, incident_id, gate) DO NOTHING
       RETURNING gate, notes, completed_by, completed_at`,
      [input.incidentId, input.gate, input.notes, input.completedBy],
    );
    return rows[0] ?? null;
  }

  async listGateEvents(client: PoolClient, incidentId: string): Promise<GateEventRow[]> {
    const { rows } = await client.query<GateEventRow>(
      `SELECT gate, notes, completed_by, completed_at
         FROM breach_gate_events WHERE incident_id = $1 ORDER BY completed_at`,
      [incidentId],
    );
    return rows;
  }

  // --- deadlines and escalations ------------------------------------------

  async insertDeadline(
    client: PoolClient,
    input: {
      incidentId: string;
      gate: BreachGate;
      policyKey: string;
      policyVersion: number | null;
      dueAt: Date;
      level: number;
      rung: string;
      trigger: 'sla_proximity' | 'sla_breach';
      workflowId: string;
      notifyUserId: string | null;
      notifyContact: string | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO breach_deadlines
         (incident_id, gate, policy_key, policy_version, due_at, level, rung,
          trigger_reason, workflow_id, notify_user_id, notify_contact)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, incident_id, gate, level) DO NOTHING`,
      [
        input.incidentId,
        input.gate,
        input.policyKey,
        input.policyVersion,
        input.dueAt.toISOString(),
        input.level,
        input.rung,
        input.trigger,
        input.workflowId,
        input.notifyUserId,
        input.notifyContact,
      ],
    );
  }

  async listDeadlines(client: PoolClient, incidentId: string): Promise<DeadlineRow[]> {
    const { rows } = await client.query<DeadlineRow>(
      `SELECT id, gate, policy_key, policy_version, due_at, level, rung,
              trigger_reason, workflow_id, notify_user_id, notify_contact, status
         FROM breach_deadlines WHERE incident_id = $1 ORDER BY due_at, level`,
      [incidentId],
    );
    return rows;
  }

  /** The worker's entry point: what did the incident mean by this deadline? */
  async findDeadlineByWorkflowId(client: PoolClient, workflowId: string): Promise<
    (DeadlineRow & { incident_id: string; reference_code: string; title: string }) | null
  > {
    const { rows } = await client.query<
      DeadlineRow & { incident_id: string; reference_code: string; title: string }
    >(
      `SELECT d.id, d.gate, d.policy_key, d.policy_version, d.due_at, d.level, d.rung,
              d.trigger_reason, d.workflow_id, d.notify_user_id, d.notify_contact, d.status,
              d.incident_id, i.reference_code, i.title
         FROM breach_deadlines d
         JOIN breach_incidents i ON i.id = d.incident_id
        WHERE d.workflow_id = $1`,
      [workflowId],
    );
    return rows[0] ?? null;
  }

  /** Claim a deadline. True only if it actually moved a `scheduled` row — the
   *  same exactly-once trick request_sla_timers uses, and the reason a deadline
   *  seen by both pg-boss and the reconciliation ticker escalates once. */
  async markDeadlineFired(client: PoolClient, deadlineId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE breach_deadlines SET status = 'fired', fired_at = now()
        WHERE id = $1 AND status = 'scheduled'`,
      [deadlineId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Cancel every still-scheduled deadline for a gate (it was passed) or for a
   *  whole incident (it closed). Returns the workflow ids so the caller can pull
   *  them from the runner. */
  async cancelDeadlines(
    client: PoolClient,
    incidentId: string,
    gate?: BreachGate,
  ): Promise<string[]> {
    const { rows } = await client.query<{ workflow_id: string }>(
      `UPDATE breach_deadlines SET status = 'cancelled'
        WHERE incident_id = $1 AND status = 'scheduled'
          AND ($2::text IS NULL OR gate = $2)
        RETURNING workflow_id`,
      [incidentId, gate ?? null],
    );
    return rows.map((r) => r.workflow_id);
  }

  async recordEscalation(
    client: PoolClient,
    input: {
      incidentId: string;
      gate: string;
      level: number;
      rung: string;
      trigger: string;
      notifiedUserId: string | null;
      notifiedContact: string | null;
      notifiedOk: boolean | null;
      reason: string;
    },
  ): Promise<boolean> {
    const { rows } = await client.query(
      `INSERT INTO breach_escalations
         (incident_id, gate, level, rung, trigger_reason, notified_user_id,
          notified_contact, notified_ok, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, incident_id, gate, level) DO NOTHING
       RETURNING id`,
      [
        input.incidentId,
        input.gate,
        input.level,
        input.rung,
        input.trigger,
        input.notifiedUserId,
        input.notifiedContact,
        input.notifiedOk,
        input.reason,
      ],
    );
    return rows.length > 0;
  }

  async listEscalations(client: PoolClient, incidentId: string): Promise<BreachEscalationRow[]> {
    const { rows } = await client.query<BreachEscalationRow>(
      `SELECT gate, level, rung, trigger_reason, notified_contact, notified_ok,
              reason, occurred_at
         FROM breach_escalations WHERE incident_id = $1 ORDER BY occurred_at`,
      [incidentId],
    );
    return rows;
  }

  // --- evidence ------------------------------------------------------------

  async insertEvidence(
    client: PoolClient,
    input: {
      incidentId: string;
      fileName: string;
      contentType: string | null;
      sizeBytes: number;
      sha256: string;
      description: string | null;
      uploadedBy: string;
    },
  ): Promise<EvidenceRow> {
    const { rows } = await client.query<EvidenceRow>(
      `INSERT INTO breach_evidence
         (incident_id, file_name, content_type, size_bytes, sha256, description, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, file_name, content_type, size_bytes, sha256, description, uploaded_at`,
      [
        input.incidentId,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.sha256,
        input.description,
        input.uploadedBy,
      ],
    );
    return rows[0]!;
  }

  async listEvidence(client: PoolClient, incidentId: string): Promise<EvidenceRow[]> {
    const { rows } = await client.query<EvidenceRow>(
      `SELECT id, file_name, content_type, size_bytes, sha256, description, uploaded_at
         FROM breach_evidence WHERE incident_id = $1 ORDER BY uploaded_at`,
      [incidentId],
    );
    return rows;
  }
}
