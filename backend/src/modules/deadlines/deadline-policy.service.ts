import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EscalationLadderStep, PolicyDomain } from '@dpdp/shared';
import { TenantDatabaseService } from '../../database/database.service';
import { AuditContextService } from '../audit/audit-context.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import {
  DeadlinePolicyRepository,
  type DeadlinePolicyVersionRow,
} from './deadline-policy.repository';

/** A resolved policy plus the version of the record it came from — null when it
 *  came from a source that predates versioning, or from a code default. */
export interface ResolvedPolicy {
  slaSeconds: number;
  ladder: EscalationLadderStep[];
  version: number | null;
}

export interface PolicySeed {
  policyKey: string;
  slaSeconds: number;
  ladder: EscalationLadderStep[];
  note: string;
}

/**
 * "Deadlines are data, not code" (FR-BRC-02), as a service every module shares.
 *
 * Grievance, DPRequest and Breach all resolve their deadlines through this one
 * object. That is the point: a compliance platform with two ways to answer
 * "how long did they have?" has no answer at all.
 *
 * The domain and key are opaque strings. This service will happily resolve
 * `breach:notify_board` without knowing what a Board is, which is exactly why
 * adding a module means adding rows, not editing this file.
 */
@Injectable()
export class DeadlinePolicyService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly repo: DeadlinePolicyRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  /**
   * The policy in force, tried exact key first, then the domain's base key.
   *
   * The base-key fallback ('') is how a tenant sets one rule for a whole domain
   * without enumerating its subtypes. A caller that wants a hard failure
   * instead of a fallback should check `version === null`.
   */
  async resolve(
    client: PoolClient,
    domain: PolicyDomain,
    policyKey: string,
    fallback: { slaSeconds: number; ladder: EscalationLadderStep[] },
  ): Promise<ResolvedPolicy> {
    if (policyKey !== '') {
      const keyed = await this.repo.findEffective(client, domain, policyKey);
      if (keyed) {
        return { slaSeconds: keyed.sla_seconds, ladder: keyed.ladder, version: keyed.version };
      }
    }
    const base = await this.repo.findEffective(client, domain, '');
    if (base) {
      return { slaSeconds: base.sla_seconds, ladder: base.ladder, version: base.version };
    }
    // No record. The caller's fallback is used and the version is NULL — a
    // deadline with no citation, which is exactly what the register exists to
    // make visible rather than to hide behind a plausible number.
    return { ...fallback, version: null };
  }

  listVersions(domain: PolicyDomain): Promise<DeadlinePolicyVersionRow[]> {
    return this.repo.listVersions(domain);
  }

  effective(domain: PolicyDomain, policyKey: string, fallback: { slaSeconds: number; ladder: EscalationLadderStep[] }): Promise<ResolvedPolicy> {
    return this.db.withTenant((client) => this.resolve(client, domain, policyKey, fallback));
  }

  /**
   * Supersede a keyed policy with its next version.
   *
   * This does NOT move any open record's deadline. Every incident and ticket
   * snapshotted the version it was judged under, and re-judging a March
   * incident against April's rule would destroy the only thing that citation is
   * for (I4).
   */
  async supersede(input: {
    domain: PolicyDomain;
    policyKey: string;
    slaSeconds: number;
    ladder: EscalationLadderStep[];
    effectiveFrom: Date;
    note: string | null;
  }): Promise<DeadlinePolicyVersionRow> {
    const ctx = this.tenantContext.getOrThrow();
    return this.db.withTenant(async (client) => {
      const before = await this.repo.findEffective(client, input.domain, input.policyKey);
      const inserted = await this.repo.insertVersion(client, { ...input, createdBy: ctx.userId });
      this.audit.annotate({
        targetType: 'deadline_policy_version',
        targetId: `${input.domain}/${input.policyKey || '(base)'}`,
        reason: input.note ?? 'Deadline policy superseded',
        beforeState: before
          ? { version: before.version, slaSeconds: before.sla_seconds }
          : { source: 'no prior version' },
        afterState: {
          version: inserted.version,
          slaSeconds: inserted.sla_seconds,
          effectiveFrom: inserted.effective_from.toISOString(),
        },
      });
      return inserted;
    });
  }

  /**
   * Ensure a set of keys has a v1, adding nothing where one already exists.
   *
   * Migrations seed v1 for every tenant that existed when they ran; a migration
   * cannot reach into the future, so a tenant registered tomorrow would fall
   * through to a code fallback — a deadline with no record behind it, the exact
   * failure this table exists to prevent. This closes that gap on the intake
   * path. One indexed SELECT per key when there is nothing to do.
   */
  async ensureSeeded(domain: PolicyDomain, seeds: PolicySeed[]): Promise<number> {
    return this.db.withTenant(async (client) => {
      let created = 0;
      for (const seed of seeds) {
        if (await this.repo.findEffective(client, domain, seed.policyKey)) {
          continue;
        }
        await this.repo.insertVersion(client, {
          domain,
          policyKey: seed.policyKey,
          slaSeconds: seed.slaSeconds,
          ladder: seed.ladder,
          effectiveFrom: new Date(),
          note: seed.note,
          // No acting user: the platform seeding a default is not a person
          // setting a policy, and attributing it to whoever happened to open the
          // first incident would be a lie in the record.
          createdBy: null,
        });
        created += 1;
      }
      return created;
    });
  }
}
