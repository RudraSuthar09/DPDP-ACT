import { Injectable } from '@nestjs/common';
import { AuditContextService } from '../audit/audit-context.service';
import { IdentityService } from '../identity/identity.service';
import { TenantDatabaseService } from '../../database/database.service';
import { renderDprRegisterPdf } from './dpr-register-pdf';

export interface DprRegisterEntry {
  referenceCode: string;
  rightType: string | null;
  status: string;
  createdAt: string;
  slaDueAt: string | null;
  closedAt: string | null;
  slaPolicyKey: string;
  slaPolicyVersion: number | null;
  /** Null while open — see the comment on the query. */
  closedOnTime: boolean | null;
  overdue: boolean;
}

export interface DprRegisterStats {
  total: number;
  closed: number;
  closedOnTime: number;
  open: number;
  overdue: number;
}

/**
 * FR-DPR-06 — the rights-request register and its on-time-closure evidence.
 *
 * The register is a projection over `request_tickets` + `dprequest_details`,
 * computed on read like everything else in this feature. There is no
 * `compliance_rate` column being maintained somewhere: a stored rate is a rate
 * that can drift from the rows it claims to summarise, and this one exists
 * specifically to be shown to a regulator.
 *
 * ON-TIME IS DECIDED IN SQL, AGAINST THE TICKET'S OWN SNAPSHOT. `closed_at <=
 * sla_due_at`, where `sla_due_at` was written when that ticket's clock started
 * from the policy version in force at the time (FR-DPR-03). It is never
 * recomputed from today's policy — a tenant who shortens their erasure deadline
 * this month must not retrospectively turn last month's compliant closures into
 * breaches, and one who lengthens it must not launder them clean.
 */
@Injectable()
export class DprRegisterService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly identity: IdentityService,
    private readonly audit: AuditContextService,
  ) {}

  async list(): Promise<{ entries: DprRegisterEntry[]; stats: DprRegisterStats }> {
    const rows = await this.db.withTenant(async (client) => {
      const { rows } = await client.query<{
        reference_code: string;
        right_type: string | null;
        status: string;
        created_at: Date;
        sla_due_at: Date | null;
        closed_at: Date | null;
        sla_policy_key: string;
        sla_policy_version: number | null;
      }>(
        `SELECT t.reference_code, d.right_type, t.status, t.created_at,
                t.sla_due_at, t.closed_at, t.sla_policy_key, t.sla_policy_version
           FROM request_tickets t
           LEFT JOIN dprequest_details d ON d.ticket_id = t.id
          WHERE t.request_type = 'dprequest'
          ORDER BY t.created_at DESC`,
      );
      return rows;
    });

    const now = Date.now();
    const entries: DprRegisterEntry[] = rows.map((r) => {
      const closedOnTime =
        r.closed_at && r.sla_due_at ? r.closed_at.getTime() <= r.sla_due_at.getTime() : null;
      return {
        referenceCode: r.reference_code,
        rightType: r.right_type,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        slaDueAt: r.sla_due_at?.toISOString() ?? null,
        closedAt: r.closed_at?.toISOString() ?? null,
        slaPolicyKey: r.sla_policy_key || '(base)',
        slaPolicyVersion: r.sla_policy_version,
        closedOnTime,
        // "Overdue" is only meaningful for something still running. A request
        // closed late is 'Late', not 'overdue' — conflating the two would
        // double-count it in the stats below.
        overdue: !r.closed_at && r.sla_due_at !== null && r.sla_due_at.getTime() < now,
      };
    });

    const closed = entries.filter((e) => e.closedOnTime !== null);
    const stats: DprRegisterStats = {
      total: entries.length,
      closed: closed.length,
      closedOnTime: closed.filter((e) => e.closedOnTime).length,
      open: entries.length - closed.length,
      overdue: entries.filter((e) => e.overdue).length,
    };
    return { entries, stats };
  }

  async export(): Promise<{ buffer: Buffer; filename: string }> {
    const [{ entries, stats }, user] = await Promise.all([this.list(), this.identity.currentUser()]);
    const generatedAt = new Date();
    const buffer = await renderDprRegisterPdf({
      organisationName: user.organisationName,
      generatedAt,
      entries,
      stats,
    });

    this.audit.annotate({
      targetType: 'dpr_register_export',
      targetId: null,
      reason: `Rights-request register exported — ${stats.total} request(s)`,
      afterState: {
        total: stats.total,
        closed: stats.closed,
        closedOnTime: stats.closedOnTime,
        overdue: stats.overdue,
      },
    });

    const datePart = generatedAt.toISOString().slice(0, 10);
    return { buffer, filename: `DPR-Register-${datePart}.pdf` };
  }
}
