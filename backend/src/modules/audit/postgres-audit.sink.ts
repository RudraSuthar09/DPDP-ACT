import { Injectable } from '@nestjs/common';
import type { AuditReceipt, AuditSink, AuditWrite } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';

export const AUDIT_SINK = Symbol('AUDIT_SINK');

/**
 * S5, Stage 1 implementation: append to the hash-chained Postgres table.
 * Later this fans out to Kafka -> ClickHouse + daily Merkle roots in S3 Object
 * Lock, and nothing above this file changes.
 *
 * This is the ONLY code in the system that appends an audit entry, and it is the
 * only place `app.audit_append` is named. Three things keep it that way, none of
 * which is a convention:
 *
 *   1. AuditModule does not export AUDIT_SINK, so no other module can inject it.
 *      A service that tries fails at boot with an unresolved dependency.
 *   2. `dpdp_app` has SELECT on audit_log and nothing else. A service that writes
 *      raw SQL instead gets `permission denied` — there is no INSERT to grant it.
 *   3. audit-write-path.spec.ts fails the build if any file outside this
 *      directory so much as mentions audit_log or audit_append.
 *
 * Note what is NOT sent to the database: tenant, timestamp, sequence, and the
 * hashes. `app.audit_append` takes no tenant (it reads app.current_tenant(), so
 * this sink cannot write into another tenant's chain even if asked to), the
 * database sets the time, and a trigger computes the chain. This file could not
 * forge history if it wanted to.
 */
@Injectable()
export class PostgresAuditSink implements AuditSink {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async record(entry: AuditWrite): Promise<AuditReceipt> {
    // Normally the tenant is the authenticated one. For registration there is no
    // JWT yet, so it is the tenant the handler just minted and bound to this
    // request's transaction — which is exactly the tenant the entry belongs to.
    const tenantId = this.tenantContext.get()?.tenantId ?? this.db.unitOfWorkTenantId();
    if (!tenantId) {
      throw new Error(
        'Refusing to record an audit entry with no tenant in scope (Seam S1/S5). ' +
          'Every entry belongs to exactly one tenant chain.',
      );
    }

    // withTenantId JOINS the request's open transaction, so this INSERT and the
    // business change it describes commit as one atomic fact (invariant I4).
    return this.db.withTenantId(tenantId, async (client) => {
      const { rows } = await client.query<{
        entry_id: string;
        entry_seq: string;
        entry_occurred_at: Date;
        entry_hash: Buffer;
      }>(
        `SELECT entry_id, entry_seq, entry_occurred_at, entry_hash
           FROM app.audit_append($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          entry.action,
          entry.outcome,
          entry.correlationId,
          entry.actorId ?? null,
          entry.actorLabel ?? null,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.reason ?? null,
          entry.beforeState ? JSON.stringify(entry.beforeState) : null,
          entry.afterState ? JSON.stringify(entry.afterState) : null,
          entry.sourceIp ?? null,
          entry.userAgent ?? null,
        ],
      );

      const row = rows[0]!;
      return {
        id: row.entry_id,
        seq: Number(row.entry_seq),
        occurredAt: row.entry_occurred_at.toISOString(),
        hash: row.entry_hash.toString('hex'),
      };
    });
  }
}
