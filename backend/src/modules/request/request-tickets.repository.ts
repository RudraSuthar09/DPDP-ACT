import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ContactChannel,
  CorrespondenceDirection,
  RequestActorType,
  RequestStatus,
  RequestType,
} from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Every SQL statement that touches the request ticket and its two append-only
 * trails, in one file.
 *
 * Ordinary tenant tables, so these are ordinary parameterised statements under
 * RLS — not SECURITY DEFINER gates like the audit/consent/workflow seams. The
 * append-only guarantee on the trails is enforced by the DATABASE (a trigger
 * that fires for the owner too, plus a revoked UPDATE grant), not by this file
 * choosing not to write an UPDATE — see the migration.
 *
 * Methods take an explicit `client` wherever the caller needs several writes to
 * land in one transaction, which for this substrate is almost everywhere: a
 * status change and its trail entry that could commit separately would be a
 * lifecycle you cannot trust.
 */

export interface TicketRow {
  id: string;
  tenant_id: string;
  request_type: RequestType;
  reference_code: string;
  status: RequestStatus;
  subject: string;
  contact_channel: ContactChannel;
  contact_value: string;
  contact_verified_at: Date | null;
  escalation_level: number;
  assigned_to: string | null;
  sla_seconds: number | null;
  sla_started_at: Date | null;
  sla_due_at: Date | null;
  /** Which KEYED deadline policy this ticket resolves against. '' is the base
   *  policy for its request type — what every grievance uses, and what every
   *  ticket written before the versioned-policy migration has. A specialising
   *  module sets it at intake (DPRequest: `dprequest:<rightType>`); the
   *  substrate never interprets what is in it. */
  sla_policy_key: string;
  /** The version of that policy in force when the clock started. Null means the
   *  clock resolved against the pre-versioning `request_sla_policies` row or the
   *  platform default. */
  sla_policy_version: number | null;
  resolution: string | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

export interface CorrespondenceRow {
  id: string;
  direction: CorrespondenceDirection;
  author_type: RequestActorType;
  author_user_id: string | null;
  author_label: string | null;
  body: string;
  created_at: Date;
}

export interface StatusEventRow {
  from_status: RequestStatus | null;
  to_status: RequestStatus;
  actor_type: RequestActorType;
  actor_user_id: string | null;
  reason: string;
  occurred_at: Date;
}

const TICKET_COLUMNS = `
  id, tenant_id, request_type, reference_code, status, subject,
  contact_channel, contact_value, contact_verified_at, escalation_level,
  assigned_to, sla_seconds, sla_started_at, sla_due_at,
  sla_policy_key, sla_policy_version, resolution,
  created_at, updated_at, closed_at
`;

@Injectable()
export class RequestTicketsRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  async insert(
    client: PoolClient,
    input: {
      requestType: RequestType;
      referenceCode: string;
      subject: string;
      contactChannel: ContactChannel;
      contactValue: string;
      sourceIp: string | null;
      userAgent: string | null;
      /** Optional, and defaulted to '' rather than required: a specialising
       *  module that needs a finer-grained deadline than "all grievances" says
       *  so here. Omitting it is the pre-existing behaviour, unchanged. */
      slaPolicyKey?: string;
    },
  ): Promise<TicketRow> {
    const { rows } = await client.query<TicketRow>(
      `INSERT INTO request_tickets
         (request_type, reference_code, subject, contact_channel, contact_value,
          submitted_ip, submitted_user_agent, sla_policy_key)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8)
       RETURNING ${TICKET_COLUMNS}`,
      [
        input.requestType,
        input.referenceCode,
        input.subject,
        input.contactChannel,
        input.contactValue,
        input.sourceIp,
        input.userAgent,
        input.slaPolicyKey ?? '',
      ],
    );
    return rows[0]!;
  }

  async findById(client: PoolClient, ticketId: string): Promise<TicketRow | null> {
    const { rows } = await client.query<TicketRow>(
      `SELECT ${TICKET_COLUMNS} FROM request_tickets WHERE id = $1`,
      [ticketId],
    );
    return rows[0] ?? null;
  }

  /** For the staff queue. `status`/`requestType` are optional filters; RLS is
   *  what scopes it to the tenant, never a WHERE clause this file remembers. */
  list(filters: { status?: RequestStatus; requestType?: RequestType; limit: number }): Promise<TicketRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<TicketRow>(
        `SELECT ${TICKET_COLUMNS} FROM request_tickets
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::text IS NULL OR request_type = $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [filters.status ?? null, filters.requestType ?? null, filters.limit],
      );
      return rows;
    });
  }

  /**
   * Move a ticket to a new status, recording the transition in the append-only
   * lifecycle trail in the same statement pair.
   *
   * The UPDATE is guarded on the status the caller believed it was in
   * (`expectedFrom`), so two concurrent transitions cannot both succeed and
   * leave a trail that claims the ticket was in two places at once. A null
   * return means someone else moved it first; the caller decides whether that is
   * a conflict or a no-op.
   */
  async transition(
    client: PoolClient,
    input: {
      ticketId: string;
      expectedFrom: RequestStatus[];
      to: RequestStatus;
      actorType: RequestActorType;
      actorUserId: string | null;
      reason: string;
      assignedTo?: string | null;
      resolution?: string | null;
      contactVerified?: boolean;
    },
  ): Promise<TicketRow | null> {
    const { rows } = await client.query<TicketRow>(
      `UPDATE request_tickets
          SET status = $2,
              updated_at = now(),
              assigned_to = COALESCE($4, assigned_to),
              resolution = COALESCE($5, resolution),
              contact_verified_at = CASE WHEN $6 THEN COALESCE(contact_verified_at, now())
                                         ELSE contact_verified_at END,
              closed_at = CASE WHEN $2 IN ('resolved', 'closed') THEN COALESCE(closed_at, now())
                               ELSE closed_at END
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING ${TICKET_COLUMNS}`,
      [
        input.ticketId,
        input.to,
        input.expectedFrom,
        input.assignedTo ?? null,
        input.resolution ?? null,
        input.contactVerified ?? false,
      ],
    );
    const ticket = rows[0];
    if (!ticket) {
      return null;
    }

    await client.query(
      `INSERT INTO request_status_events
         (ticket_id, from_status, to_status, actor_type, actor_user_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.ticketId,
        // The status it came FROM: whichever of the expected set it actually
        // matched. With a single expected value this is exact; with several the
        // trail records the set it was permitted to move from, which is the
        // honest thing to say when the UPDATE is what resolved the ambiguity.
        input.expectedFrom.length === 1 ? input.expectedFrom[0] : input.expectedFrom.join('|'),
        input.to,
        input.actorType,
        input.actorUserId,
        input.reason,
      ],
    );
    return ticket;
  }

  /** Record the SLA snapshot when the clock starts. Separate from `transition`
   *  because the clock and the lifecycle are independent facts. */
  async setSla(
    client: PoolClient,
    ticketId: string,
    sla: { seconds: number; startedAt: Date; dueAt: Date; policyVersion: number | null },
  ): Promise<void> {
    await client.query(
      `UPDATE request_tickets
          SET sla_seconds = $2, sla_started_at = $3, sla_due_at = $4,
              sla_policy_version = $5, updated_at = now()
        WHERE id = $1`,
      [
        ticketId,
        sla.seconds,
        sla.startedAt.toISOString(),
        sla.dueAt.toISOString(),
        // The CITATION alongside the number. A ticket that says "30 days"
        // without saying which record said so cannot be defended later.
        sla.policyVersion,
      ],
    );
  }

  /** Bump the escalation level. Called only from the fired-deadline path, inside
   *  the worker's transaction. */
  async bumpEscalationLevel(client: PoolClient, ticketId: string, level: number): Promise<void> {
    await client.query(
      `UPDATE request_tickets
          SET escalation_level = GREATEST(escalation_level, $2), updated_at = now()
        WHERE id = $1`,
      [ticketId, level],
    );
  }

  // --- the append-only trails ----------------------------------------------

  async appendCorrespondence(
    client: PoolClient,
    input: {
      ticketId: string;
      direction: CorrespondenceDirection;
      authorType: RequestActorType;
      authorUserId: string | null;
      authorLabel: string | null;
      body: string;
    },
  ): Promise<CorrespondenceRow> {
    const { rows } = await client.query<CorrespondenceRow>(
      `INSERT INTO request_correspondence
         (ticket_id, direction, author_type, author_user_id, author_label, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, direction, author_type, author_user_id, author_label, body, created_at`,
      [
        input.ticketId,
        input.direction,
        input.authorType,
        input.authorUserId,
        input.authorLabel,
        input.body,
      ],
    );
    return rows[0]!;
  }

  async listCorrespondence(client: PoolClient, ticketId: string): Promise<CorrespondenceRow[]> {
    const { rows } = await client.query<CorrespondenceRow>(
      `SELECT id, direction, author_type, author_user_id, author_label, body, created_at
         FROM request_correspondence WHERE ticket_id = $1 ORDER BY created_at`,
      [ticketId],
    );
    return rows;
  }

  async listStatusEvents(client: PoolClient, ticketId: string): Promise<StatusEventRow[]> {
    const { rows } = await client.query<StatusEventRow>(
      `SELECT from_status, to_status, actor_type, actor_user_id, reason, occurred_at
         FROM request_status_events WHERE ticket_id = $1 ORDER BY occurred_at`,
      [ticketId],
    );
    return rows;
  }

  /**
   * How many tickets this contact channel has filed with this tenant recently —
   * the DURABLE half of abuse protection, and the half that survives a process
   * restart. The in-memory limiter stops a burst; this stops a patient
   * adversary, and it is the one an auditor can actually see the effect of.
   */
  async countRecentByContact(
    client: PoolClient,
    contactValue: string,
    windowSeconds: number,
  ): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_tickets
        WHERE contact_value = $1 AND created_at > now() - make_interval(secs => $2)`,
      [contactValue, windowSeconds],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
