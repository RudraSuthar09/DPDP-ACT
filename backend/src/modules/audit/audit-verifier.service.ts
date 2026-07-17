import { Injectable, Logger } from '@nestjs/common';
import type { AuditChainReport, AuditEntry } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

/**
 * Walks a tenant's chain and reports any break (FR-AUD-03).
 *
 * The walk itself is `app.verify_audit_chain()` in SQL, and that is deliberate:
 * it recomputes each hash with `app.audit_entry_hash` — the SAME function the
 * chain trigger used to write it. A verifier with its own reimplementation of
 * the hash would be checking whether two pieces of code agree about JSON
 * formatting, and would go red on a canonicalisation difference while a real
 * tamper slipped through. One definition, two callers.
 *
 * It runs SECURITY INVOKER, so RLS applies: a tenant verifies its own chain and
 * cannot see — or vouch for — anyone else's.
 *
 * What this detects: any modification, removal, or reordering of an entry after
 * the fact. What it cannot detect on its own: an attacker with database owner
 * rights who rewrites an entry AND every entry after it, recomputing the whole
 * chain. That is what the Stage 4 work answers — daily Merkle roots written to
 * S3 Object Lock, which put the head of the chain somewhere the database cannot
 * reach back and edit. The chain makes tampering expensive and loud; the
 * external anchor makes it impossible to do quietly.
 */
@Injectable()
export class AuditVerifierService {
  private readonly logger = new Logger(AuditVerifierService.name);

  constructor(private readonly db: TenantDatabaseService) {}

  async verifyChain(): Promise<AuditChainReport> {
    return this.db.withTenant(async (client) => {
      const [breaks, head] = await Promise.all([
        client.query<{ entry_seq: string; entry_id: string; problem: string }>(
          'SELECT entry_seq, entry_id, problem FROM app.verify_audit_chain()',
        ),
        client.query<{ seq: string; hash: Buffer; count: string }>(
          `SELECT seq, hash, (SELECT count(*)::text FROM audit_log) AS count
             FROM audit_log ORDER BY seq DESC LIMIT 1`,
        ),
      ]);

      const report: AuditChainReport = {
        intact: breaks.rowCount === 0,
        entriesChecked: Number(head.rows[0]?.count ?? 0),
        headHash: head.rows[0]?.hash.toString('hex') ?? null,
        breaks: breaks.rows.map((r) => ({
          seq: Number(r.entry_seq),
          entryId: r.entry_id,
          problem: r.problem,
        })),
      };

      if (!report.intact) {
        // Loud, because there is no benign explanation. Rows in this table cannot
        // be edited through the application at all — reaching them means someone
        // went around it with owner rights.
        this.logger.error(
          `AUDIT CHAIN BROKEN: ${report.breaks.length} problem(s) in ${report.entriesChecked} entries. ` +
            report.breaks.map((b) => `[seq ${b.seq}] ${b.problem}`).join(' | '),
        );
      }

      return report;
    });
  }

  /** The tenant's own log, newest first. RLS scopes it; no tenant filter needed. */
  async list(limit: number, before?: number): Promise<AuditEntry[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<AuditRow>(
        `SELECT id, tenant_id, seq, occurred_at, actor_id, actor_label, action, outcome,
                target_type, target_id, reason, before_state, after_state,
                host(source_ip) AS source_ip, user_agent, correlation_id,
                encode(prev_hash, 'hex') AS prev_hash, encode(hash, 'hex') AS hash
           FROM audit_log
          WHERE ($2::bigint IS NULL OR seq < $2)
          ORDER BY seq DESC
          LIMIT $1`,
        [limit, before ?? null],
      );
      return rows.map(toEntry);
    });
  }
}

interface AuditRow {
  id: string;
  tenant_id: string;
  seq: string;
  occurred_at: Date;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  outcome: AuditEntry['outcome'];
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  source_ip: string | null;
  user_agent: string | null;
  correlation_id: string;
  prev_hash: string;
  hash: string;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    seq: Number(row.seq),
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    action: row.action,
    outcome: row.outcome,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    beforeState: row.before_state,
    afterState: row.after_state,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    correlationId: row.correlation_id,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
