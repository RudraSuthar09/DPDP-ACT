import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EscalationLadderStep, PolicyDomain } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';

export interface DeadlinePolicyVersionRow {
  id: string;
  policy_domain: PolicyDomain;
  policy_key: string;
  version: number;
  sla_seconds: number;
  ladder: EscalationLadderStep[];
  effective_from: Date;
  note: string | null;
  created_at: Date;
}

/**
 * `deadline_policy_versions` — the ONE table holding versioned statutory and
 * SLA deadlines, for every module that has them.
 *
 * It began life inside the request substrate as `request_sla_policy_versions`
 * (Prompt 30, for DPR). Breach needed the same thing, and the choice was to
 * copy the shape or to admit the mechanism was never request-specific. This
 * file is the second answer: one table, one resolution rule, one place to ask
 * "what deadline was in force". See the Breach migration's header for the full
 * argument against the alternatives.
 *
 * The domain and key are opaque here. This repository does not know that
 * `breach:notify_board` means the Board, or that `dprequest:erasure` means
 * erasure — it looks up a string. That is what lets a fourth module arrive
 * without editing this file.
 */
@Injectable()
export class DeadlinePolicyRepository {
  constructor(private readonly db: TenantDatabaseService) {}

  /**
   * The version IN FORCE right now for a domain + key.
   *
   * `effective_from <= now()` matters: counsel revising a deadline in March for
   * an April rule change must be able to write v2 today without it silently
   * applying to today's incidents. Ordering by effective_from then version means
   * a same-day correction (v3 fixing v2's typo) wins over the row it corrects.
   */
  async findEffective(
    client: PoolClient,
    domain: PolicyDomain,
    policyKey: string,
  ): Promise<DeadlinePolicyVersionRow | null> {
    const { rows } = await client.query<DeadlinePolicyVersionRow>(
      `SELECT id, policy_domain, policy_key, version, sla_seconds, ladder,
              effective_from, note, created_at
         FROM deadline_policy_versions
        WHERE policy_domain = $1 AND policy_key = $2 AND effective_from <= now()
        ORDER BY effective_from DESC, version DESC
        LIMIT 1`,
      [domain, policyKey],
    );
    return rows[0] ?? null;
  }

  listVersions(domain: PolicyDomain): Promise<DeadlinePolicyVersionRow[]> {
    return this.db.withTenant(async (client) => {
      const { rows } = await client.query<DeadlinePolicyVersionRow>(
        `SELECT id, policy_domain, policy_key, version, sla_seconds, ladder,
                effective_from, note, created_at
           FROM deadline_policy_versions
          WHERE policy_domain = $1
          ORDER BY policy_key, version`,
        [domain],
      );
      return rows;
    });
  }

  /**
   * Supersede a keyed policy: INSERT the next version, never UPDATE the current
   * one (the table has UPDATE revoked and a forbid_mutation trigger, so this is
   * not merely a convention this file observes).
   *
   * The version number is computed inside the statement rather than read and
   * incremented, so two concurrent supersessions collide on the UNIQUE
   * constraint instead of both quietly claiming v2.
   */
  async insertVersion(
    client: PoolClient,
    input: {
      domain: PolicyDomain;
      policyKey: string;
      slaSeconds: number;
      ladder: EscalationLadderStep[];
      effectiveFrom: Date;
      note: string | null;
      createdBy: string | null;
    },
  ): Promise<DeadlinePolicyVersionRow> {
    const { rows } = await client.query<DeadlinePolicyVersionRow>(
      `INSERT INTO deadline_policy_versions
         (policy_domain, policy_key, version, sla_seconds, ladder, effective_from, note, created_by)
       SELECT $1, $2, COALESCE(max(version), 0) + 1, $3, $4::jsonb, $5, $6, $7
         FROM deadline_policy_versions
        WHERE policy_domain = $1 AND policy_key = $2
       RETURNING id, policy_domain, policy_key, version, sla_seconds, ladder,
                 effective_from, note, created_at`,
      [
        input.domain,
        input.policyKey,
        input.slaSeconds,
        JSON.stringify(input.ladder),
        input.effectiveFrom.toISOString(),
        input.note,
        input.createdBy,
      ],
    );
    return rows[0]!;
  }
}
