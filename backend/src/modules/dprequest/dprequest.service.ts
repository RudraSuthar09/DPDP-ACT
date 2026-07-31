import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DPR_RIGHT_TYPES,
  dprPolicyKey,
  type DprDeadlinePolicy,
  type DprRequestDetails,
  type DprRightType,
  type EscalationLadderStep,
  type RequestStatus,
  type RequestTicket,
} from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { ConsentService } from '../consent/consent.service';
import { RequestService } from '../request/request.service';
import { RequestPortalService } from '../request/request-portal.service';
import type { SubmitRequestBody } from '../request/dto';
import { DPRequestDetailsRepository } from './dprequest-details.repository';
import { dprPolicySeeds } from './dprequest-deadlines';

export interface DprListItem extends RequestTicket {
  rightType: DprRightType | null;
  subjectRefResolved: boolean;
}

/**
 * The Data Principal Request Tracker (FR-DPR-01/02/03/06) — the SECOND occupant
 * of the shared request substrate, built the way Grievance was: this module
 * owns what a rights request has that a complaint does not, and calls
 * `RequestService`/`RequestPortalService` for everything else.
 *
 * It holds no repository for `request_tickets` and never will (R2). Public
 * intake, OTP, the identity-verification handoff, lifecycle, correspondence,
 * escalation and the clock itself are all the substrate's, unmodified.
 *
 * What is genuinely DPR's, and nothing else:
 *
 *   * WHICH RIGHT is being exercised (FR-DPR-01) — six types, one column.
 *   * WHICH DEADLINE that right carries (FR-DPR-03) — not stored here at all,
 *     but SELECTED here, by handing the substrate a policy key at intake. The
 *     records are substrate-level and versioned; see `dprequest-deadlines.ts`
 *     for why that is not a distinction without a difference.
 *   * SUBJECT-REFERENCE RESOLUTION (FR-DPR-02, I2) — see `resolveSubjectRef`.
 */
@Injectable()
export class DPRequestService {
  private readonly logger = new Logger(DPRequestService.name);

  constructor(
    private readonly requests: RequestService,
    private readonly portal: RequestPortalService,
    private readonly details: DPRequestDetailsRepository,
    // The Consent module's SERVICE — not its hasher, not its tables. DPR derives
    // subject references through the exact path that wrote every consent event
    // (FR-CON-04) rather than owning a second HMAC. See resolveSubjectRef.
    private readonly consent: ConsentService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  // --- public intake (FR-DPR-01/03) ----------------------------------------

  /**
   * A member of the public exercises a right.
   *
   * Two things happen that a grievance submission does not, and both are here
   * rather than in the substrate:
   *
   *   1. the tenant's deadline records are seeded if missing (a tenant that
   *      registered after the migration ran has none);
   *   2. the ticket is stamped with the policy key for THIS right, so when the
   *      clock starts at contact verification it resolves the erasure record
   *      rather than a generic one.
   *
   * The `dprequest_details` insert joins the SAME transaction the ticket
   * creation runs in — `TenantDatabaseService.withTenant` binds to the one unit
   * of work the audit interceptor opened for this HTTP request. A rights
   * request is never left without a right, and so never without the deadline
   * that follows from it.
   */
  async submit(
    rightType: DprRightType,
    body: SubmitRequestBody,
    provenance: { sourceIp: string | null; userAgent: string | null },
  ) {
    const seeded = await this.requests.ensurePolicyVersions('dprequest', dprPolicySeeds());
    if (seeded > 0) {
      this.logger.log(`Seeded ${seeded} statutory deadline policy record(s) for this tenant.`);
    }

    const result = await this.portal.submit(body, provenance, {
      slaPolicyKey: dprPolicyKey(rightType),
    });
    await this.details.insert(result.ticketId, rightType);

    // Read-then-spread: `annotate` shallow-merges, so overwriting `afterState`
    // wholesale would drop what `portal.submit` already recorded there. Same
    // trap, same fix, as GrievanceService.submit.
    const current = this.audit.current();
    this.audit.annotate({
      afterState: {
        ...(current?.afterState ?? {}),
        rightType,
        slaPolicyKey: dprPolicyKey(rightType),
      },
    });

    return { ...result, rightType };
  }

  // --- staff surface (FR-DPR-06) -------------------------------------------

  async list(filters: {
    status?: RequestStatus;
    rightType?: DprRightType;
    limit: number;
  }): Promise<DprListItem[]> {
    const tickets = await this.requests.list({
      status: filters.status,
      requestType: 'dprequest',
      limit: filters.limit,
    });
    const details = await this.details.findMany(tickets.map((t) => t.id));
    return tickets
      .map((t) => {
        const detail = details.get(t.id);
        return {
          ...t,
          rightType: detail?.right_type ?? null,
          // The queue is told WHETHER a reference was resolved, never what it
          // is. A 64-hex digest in a list view is an identifier staff would
          // start copying around; the boolean is the whole of what a queue
          // needs to show a request is ready to be worked.
          subjectRefResolved: Boolean(detail?.subject_ref),
        };
      })
      .filter((t) => !filters.rightType || t.rightType === filters.rightType);
  }

  async detail(ticketId: string) {
    const detail = await this.requireDpr(ticketId);
    const row = await this.details.find(ticketId);
    const dpr: DprRequestDetails | null = row
      ? {
          rightType: row.right_type,
          subjectRef: row.subject_ref,
          subjectRefResolvedAt: row.subject_ref_resolved_at?.toISOString() ?? null,
          subjectRefMatchCount: row.subject_ref_match_count,
        }
      : null;
    return { ...detail, dpr };
  }

  // --- subject-reference resolution (FR-DPR-02, I2) ------------------------

  /**
   * A verifier supplies the raw customer id; the platform returns the request's
   * pseudonymous reference and what it matched. THE RAW ID IS NEVER STORED.
   *
   * Trace it. The string arrives in `customerId`, goes straight into
   * `ConsentService.deriveSubjectRef` — the same `SubjectRefHasher`, under the
   * same per-tenant secret, that wrote every consent event — and what comes
   * back is a 64-character hex digest. The digest is what is written to
   * `dprequest_details`, what appears in the audit entry, and what is returned.
   * The raw value never reaches a repository (none of them has a parameter that
   * could take it), is never logged, and is unreachable once this returns.
   *
   * WHY REUSE THE CONSENT PATH RATHER THAN HMAC HERE. Not to save six lines. If
   * DPR computed its own HMAC — same algorithm, same secret — the two would
   * agree right up until one of them trims differently, or Stage 2 moves the
   * secrets into KMS and only one caller is updated. A rights request would
   * then resolve to a reference matching nothing in the consent register, and
   * the failure would present as "this person has no consents" rather than as a
   * bug. One derivation in one place, or the pseudonymisation is not a scheme,
   * just two functions that currently agree.
   *
   * The match COUNT comes from the consent register through the same service.
   * It is evidence the resolution found a real subject and says nothing about
   * who they are. Zero is a legitimate answer, recorded rather than thrown: a
   * data principal with no consent history still has §11–§14 rights.
   */
  async resolveSubjectRef(
    ticketId: string,
    input: { customerId: string; reason: string },
  ): Promise<{ ticketId: string; subjectRef: string; matchCount: number }> {
    const ctx = this.tenantContext.getOrThrow();
    const detail = await this.requireDpr(ticketId);
    const existing = await this.details.find(ticketId);
    if (!existing) {
      throw new NotFoundException('Rights request not found.');
    }
    if (existing.subject_ref) {
      throw new BadRequestException(
        'A subject reference has already been resolved for this request. Resolving a second ' +
          'one would silently re-point the request at a different person.',
      );
    }

    // The only two statements the raw id is alive for.
    const subjectRef = await this.consent.deriveSubjectRef(input.customerId);
    const matches = await this.consent.currentStatus(input.customerId);

    await this.details.setSubjectRef(ticketId, {
      subjectRef,
      matchCount: matches.length,
      resolvedBy: ctx.userId,
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticketId,
      reason: input.reason,
      beforeState: { subjectRef: null },
      afterState: {
        // The DIGEST, never the input. This is the line an auditor reads to
        // satisfy themselves that I2 holds on this path.
        subjectRef,
        subjectRefMatchCount: matches.length,
        referenceCode: detail.ticket.referenceCode,
      },
    });

    return { ticketId, subjectRef, matchCount: matches.length };
  }

  // --- deadline policies (FR-DPR-03) ---------------------------------------

  /** What each rights type's clock is currently set to, and which record says
   *  so. This is the screen a DPO shows counsel. */
  async deadlinePolicies(): Promise<DprDeadlinePolicy[]> {
    await this.requests.ensurePolicyVersions('dprequest', dprPolicySeeds());
    const versions = await this.requests.listPolicyVersions('dprequest');
    const now = Date.now();

    return DPR_RIGHT_TYPES.map((rightType) => {
      const policyKey = dprPolicyKey(rightType);
      // The same resolution rule the clock applies, over the rows already
      // fetched: effective now, latest effective_from, then latest version.
      const inForce = versions
        .filter((v) => v.policy_key === policyKey && v.effective_from.getTime() <= now)
        .sort(
          (a, b) =>
            b.effective_from.getTime() - a.effective_from.getTime() || b.version - a.version,
        )[0];

      if (!inForce) {
        // Only reachable if a future-dated v1 is the only record — the honest
        // answer is "no policy is in force", not a number invented here.
        return {
          rightType,
          policyKey,
          version: 0,
          slaSeconds: 0,
          slaDays: 0,
          effectiveFrom: new Date(0).toISOString(),
          note: null,
          isFallback: true,
        };
      }
      return {
        rightType,
        policyKey,
        version: inForce.version,
        slaSeconds: inForce.sla_seconds,
        slaDays: Math.round((inForce.sla_seconds / 86400) * 100) / 100,
        effectiveFrom: inForce.effective_from.toISOString(),
        note: inForce.note,
        isFallback: false,
      };
    });
  }

  /** Supersede one rights type's deadline with its next version. The substrate
   *  does the insert and the audit entry; this only translates a rights type
   *  into the key its records are filed under. */
  async supersedeDeadline(
    rightType: DprRightType,
    input: {
      slaSeconds: number;
      ladder: EscalationLadderStep[];
      effectiveFrom: Date;
      note: string;
    },
  ) {
    const row = await this.requests.supersedePolicy({
      requestType: 'dprequest',
      policyKey: dprPolicyKey(rightType),
      slaSeconds: input.slaSeconds,
      ladder: input.ladder,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
    });
    return {
      rightType,
      policyKey: row.policy_key,
      version: row.version,
      slaSeconds: row.sla_seconds,
      effectiveFrom: row.effective_from.toISOString(),
      note: row.note,
    };
  }

  /** `RequestService.detail()` will happily return a grievance ticket too — it
   *  is generic by design. This is the guard that keeps a grievance id from
   *  being readable through the DPR surface, mirroring Grievance's own. */
  private async requireDpr(ticketId: string): ReturnType<RequestService['detail']> {
    const detail = await this.requests.detail(ticketId);
    if (detail.ticket.requestType !== 'dprequest') {
      throw new NotFoundException('Rights request not found.');
    }
    return detail;
  }
}
