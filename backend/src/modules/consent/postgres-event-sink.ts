import { Injectable } from '@nestjs/common';
import type { ConsentEventEnvelope, ConsentReceipt, EventSink } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

export const EVENT_SINK = Symbol('EVENT_SINK');

/**
 * S2, Stage 1 implementation: append a consent event to the hash-partitioned,
 * append-only Postgres table via `app.consent_append`. Later this publishes to
 * Kafka and consumers fan out to Postgres + ClickHouse — and nothing above this
 * file changes, because everything above it depends on the EventSink interface,
 * not on this class.
 *
 * This is the ONLY code in the system that appends a consent event, and the only
 * place `app.consent_append` is named. The same three barriers that protect the
 * audit log protect this (R3):
 *
 *   1. ConsentModule does not export EVENT_SINK, so no other module can inject it.
 *   2. dpdp_app has SELECT on consent_events and no INSERT — a service that writes
 *      raw SQL gets `permission denied`. The only write path is the SECURITY
 *      DEFINER function this file calls.
 *   3. event-sink-write-path.spec.ts fails the build if any file outside this
 *      directory names consent_events or consent_append.
 *
 * Note what is NOT sent: tenant_id and recorded_at. `app.consent_append` reads
 * the tenant from app.current_tenant() (so this sink cannot write into another
 * tenant's stream) and stamps recorded_at itself — the transaction-time clock is
 * the database's to set, not the caller's.
 */
@Injectable()
export class PostgresEventSink implements EventSink {
  constructor(private readonly db: TenantDatabaseService) {}

  async append(event: ConsentEventEnvelope): Promise<ConsentReceipt> {
    // withTenant JOINS the request's open unit of work when there is one, so the
    // event and the audit entry describing it commit together (I4).
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<{
        event_id: string;
        event_recorded_at: Date;
        deduplicated: boolean;
      }>(
        `SELECT event_id, event_recorded_at, deduplicated
           FROM app.consent_append($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.subjectRef,
          event.purposeId,
          event.status,
          event.noticeVersionId,
          event.occurredAt,
          event.source,
          event.evidenceHash,
          event.idempotencyKey,
        ],
      );

      const row = rows[0]!;
      return {
        eventId: row.event_id,
        recordedAt: row.event_recorded_at.toISOString(),
        deduplicated: row.deduplicated,
      };
    });
  }
}
