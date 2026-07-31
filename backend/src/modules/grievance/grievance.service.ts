import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CLOSED_REQUEST_STATUSES,
  type GrievanceCategory,
  type RequestStatus,
  type RequestTicket,
} from '@dpdp/shared';
import { AuditContextService } from '../audit/audit-context.service';
import { IdentityService } from '../identity/identity.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { RequestService } from '../request/request.service';
import { RequestPortalService } from '../request/request-portal.service';
import type { SubmitRequestBody } from '../request/dto';
import { GrievanceCategoryRepository } from './grievance-category.repository';
import { computeMilestones, deriveIdentityVerification } from './grievance-milestones';
import { renderGrievanceResolutionPdf } from './grievance-resolution-pdf';

export interface GrievanceListItem extends RequestTicket {
  category: GrievanceCategory | null;
}

/**
 * Grievance Register (FR-GRV-02/06) — the ONLY module that knows a complaint
 * has a category. Everything about the ticket itself — lifecycle, OTP,
 * correspondence, SLA, escalation — is `RequestService`/`RequestPortalService`,
 * called here and never reimplemented (R2: this module holds no repository
 * for `request_tickets` and never will).
 */
@Injectable()
export class GrievanceService {
  constructor(
    private readonly requests: RequestService,
    private readonly portal: RequestPortalService,
    private readonly categories: GrievanceCategoryRepository,
    private readonly identity: IdentityService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  // --- public intake (FR-GRV-01/02/03) --------------------------------------

  /**
   * The category write joins the SAME database transaction as the ticket
   * creation `this.portal.submit()` performs — both go through
   * `TenantDatabaseService.withTenant`, which binds to the one unit of work
   * the audit interceptor opened for this HTTP request (see
   * `database/unit-of-work.ts`). If the category insert fails, the whole
   * request rolls back, ticket included — a grievance is never left silently
   * uncategorised because of a database hiccup.
   */
  async submit(
    category: GrievanceCategory,
    body: SubmitRequestBody,
    provenance: { sourceIp: string | null; userAgent: string | null },
  ) {
    const result = await this.portal.submit(body, provenance);
    await this.categories.upsert(result.ticketId, category, null);

    // `annotate` shallow-merges the top-level AuditAnnotation, so overwriting
    // `afterState` wholesale would silently drop what `portal.submit` already
    // recorded there. Read-then-spread keeps both.
    const current = this.audit.current();
    this.audit.annotate({ afterState: { ...(current?.afterState ?? {}), category } });

    return { ...result, category };
  }

  // --- staff surface -----------------------------------------------------

  async list(filters: { status?: RequestStatus; limit: number }): Promise<GrievanceListItem[]> {
    const tickets = await this.requests.list({ ...filters, requestType: 'grievance' });
    const categories = await this.categories.findMany(tickets.map((t) => t.id));
    return tickets.map((t) => ({ ...t, category: categories.get(t.id) ?? null }));
  }

  async detail(ticketId: string) {
    const detail = await this.requireGrievance(ticketId);
    const category = await this.categories.find(ticketId);
    return { ...detail, category };
  }

  /** Recategorise (staff correcting or filling in a triage tag). Category is
   *  a mutable classification, not part of the append-only trail — see the
   *  migration's comment on `grievance_details`. */
  async setCategory(
    ticketId: string,
    category: GrievanceCategory,
  ): Promise<{ ticketId: string; category: GrievanceCategory }> {
    await this.requireGrievance(ticketId);
    const ctx = this.tenantContext.getOrThrow();
    const before = await this.categories.find(ticketId);
    await this.categories.upsert(ticketId, category, ctx.userId);

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticketId,
      reason: `Grievance recategorised to ${category}`,
      beforeState: { category: before },
      afterState: { category },
    });

    return { ticketId, category };
  }

  /** FR-GRV-06. Only meaningful once there is something to prove — a ticket
   *  still open has no "closed within the required time" to certify. */
  async exportResolution(ticketId: string): Promise<{ buffer: Buffer; filename: string }> {
    const [detail, category, user] = await Promise.all([
      this.requireGrievance(ticketId),
      this.categories.find(ticketId),
      this.identity.currentUser(),
    ]);
    if (!CLOSED_REQUEST_STATUSES.includes(detail.ticket.status)) {
      throw new BadRequestException(
        'A resolution export is only available once this complaint has been resolved or closed.',
      );
    }

    const milestones = computeMilestones(detail);
    const identityVerification = deriveIdentityVerification(detail);
    const generatedAt = new Date();
    const buffer = await renderGrievanceResolutionPdf({
      organisationName: user.organisationName,
      generatedAt,
      detail,
      category,
      milestones,
      identityVerification,
    });

    this.audit.annotate({
      targetType: 'request_ticket',
      targetId: ticketId,
      reason: `Resolution export generated for ${detail.ticket.referenceCode}`,
      afterState: {
        referenceCode: detail.ticket.referenceCode,
        status: detail.ticket.status,
        withinSla: milestones.withinSla,
      },
    });

    const datePart = generatedAt.toISOString().slice(0, 10);
    return { buffer, filename: `Grievance-Resolution-${detail.ticket.referenceCode}-${datePart}.pdf` };
  }

  /** `RequestService.detail()` will happily return a dprequest ticket too —
   *  it is generic by design. This is the one guard that keeps a dprequest id
   *  from being readable through the Grievance surface. */
  private async requireGrievance(ticketId: string): ReturnType<RequestService['detail']> {
    const detail = await this.requests.detail(ticketId);
    if (detail.ticket.requestType !== 'grievance') {
      throw new NotFoundException('Grievance not found.');
    }
    return detail;
  }
}
