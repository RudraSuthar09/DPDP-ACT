import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { WorkflowRunner } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import { WORKFLOW_RUNNER } from '../workflow/pg-boss-workflow-runner';
import { EntryPurposesService } from '../inventory/entry-purposes.service';
import { SubjectRefHasher } from './subject-ref';
import { ConsentInventoryLinkRepository } from './consent-inventory-link.repository';
import { RetentionRepository, type RetentionRecordRow, type RetentionRecordView } from './retention.repository';

/** How near retention_end counts as "approaching" on the dashboard. A Stage-1
 *  constant; a versioned policy is overkill until a tenant asks to tune it. */
const APPROACHING_WINDOW_DAYS = 30;

/**
 * Retention tracking (data-lifecycle). Surfaces which pseudonymised subjects hold
 * data approaching or past its retention period; it NEVER deletes the client's
 * data (I1 — the platform doesn't hold it). See the migration header for the
 * three resolved design decisions (start event, computable period, frozen expiry).
 *
 * Lives in the consent module because a retention clock is keyed by subject_ref
 * — the HMAC pseudonym consent owns (I2) — and the consent GRANT is what starts
 * it. Inventory facts (retention months, category) are read through
 * EntryPurposesService / the consent↔inventory link bridge, never inventory
 * tables directly from here (R2).
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly repo: RetentionRepository,
    private readonly links: ConsentInventoryLinkRepository,
    private readonly entryPurposes: EntryPurposesService,
    private readonly subjectRef: SubjectRefHasher,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    @Inject(WORKFLOW_RUNNER) private readonly runner: WorkflowRunner,
  ) {}

  /**
   * Materialise retention clocks for a consent grant. Called from
   * ConsentService.recordConsent AFTER a GRANTED event is written — the single
   * grant chokepoint (R3), so every grant path (staff, SDK, forms) is covered
   * once. Best-effort: a failure here must never fail the consent write, and the
   * dashboard reads retention_end directly, so an un-scheduled deadline still
   * shows up as past when its time comes.
   */
  async onConsentGrant(subjectRef: string, consentPurposeId: string, occurredAt: string): Promise<void> {
    const ctx = this.tenantContext.getOrThrow();
    try {
      const targets = await this.links.linkedRetainableInventoryPurposes(consentPurposeId);
      for (const t of targets) {
        const created = await this.repo.create({
          subjectRef,
          inventoryPurposeId: t.inventoryPurposeId,
          consentPurposeId,
          basis: t.legalBasis,
          source: 'consent_grant',
          startAt: occurredAt,
          retentionMonths: t.retentionMonths,
          createdBy: ctx.userId,
        });
        if (created) await this.scheduleExpiry(created);
      }
    } catch (err) {
      // Never let retention materialisation break recording the consent itself.
      this.logger.warn(`Retention materialisation failed for a grant: ${String(err)}`);
    }
  }

  /**
   * The non-consent path: staff record the COLLECTION DATE for a subject's data
   * under an inventory purpose that has no consent event (legal_obligation /
   * legitimate_use). Same retention_records row, source='manual_collection'.
   */
  async recordCollection(input: {
    customerId: string;
    inventoryPurposeId: string;
    collectionDate: string;
  }): Promise<{ created: boolean; retentionEnd: string | null }> {
    const ctx = this.tenantContext.getOrThrow();
    const purpose = await this.entryPurposes.findOne(input.inventoryPurposeId);
    if (!purpose) throw new NotFoundException('Inventory purpose not found.');
    const current = purpose.versions[0];
    if (!current?.retention_months) {
      throw new BadRequestException(
        'That inventory purpose has no structured retention period (retention_months) set, so a ' +
          'retention clock cannot be computed for it. Set one on the purpose first.',
      );
    }
    const subjectRef = await this.subjectRef.hash(ctx.tenantId, input.customerId);
    const created = await this.repo.create({
      subjectRef,
      inventoryPurposeId: input.inventoryPurposeId,
      consentPurposeId: null,
      basis: current.legal_basis,
      source: 'manual_collection',
      startAt: input.collectionDate,
      retentionMonths: current.retention_months,
      createdBy: ctx.userId,
    });
    if (created) {
      await this.scheduleExpiry(created);
      this.audit.annotate({
        targetType: 'retention_record',
        targetId: created.id,
        reason: `Collection date recorded — retention clock started for a subject under an inventory purpose (${current.legal_basis}).`,
        afterState: { retentionEnd: created.retention_end, source: 'manual_collection' },
      });
    }
    return { created: !!created, retentionEnd: created ? created.retention_end.toISOString() : null };
  }

  async markReviewed(id: string, note: string | null): Promise<RetentionRecordRow> {
    const updated = await this.repo.markReviewed(id, this.tenantContext.getOrThrow().userId, note);
    if (!updated) throw new NotFoundException('Retention record not found or already reviewed.');
    this.audit.annotate({
      targetType: 'retention_record',
      targetId: id,
      reason: note ? `Retention item reviewed: ${note}` : 'Retention item marked reviewed.',
      beforeState: { status: 'active' },
      afterState: { status: 'reviewed' },
    });
    return updated;
  }

  summary() {
    return this.repo.summary(APPROACHING_WINDOW_DAYS);
  }

  async list(filter: 'approaching' | 'past' | 'all') {
    const rows = await this.repo.list(filter, APPROACHING_WINDOW_DAYS);
    return rows.map(toView);
  }

  private async scheduleExpiry(record: RetentionRecordRow): Promise<void> {
    // Deadline substrate (S3), kind 'retention'. On fire the handler flags the
    // record expired — a durable "clock ran out" marker independent of anyone
    // opening the dashboard. runAt is the FROZEN retention_end.
    await this.runner.schedule({
      workflowId: record.id,
      kind: 'retention',
      runAt: record.retention_end.toISOString(),
      payload: { retentionRecordId: record.id },
    });
  }
}

function toView(r: RetentionRecordView) {
  return {
    id: r.id,
    subjectRef: r.subject_ref,
    inventoryPurposeId: r.inventory_purpose_id,
    inventoryPurposeName: r.inventory_purpose_name,
    dataElement: r.entry_category,
    basis: r.basis,
    source: r.source,
    startAt: r.start_at,
    retentionEnd: r.retention_end,
    status: r.status,
    expiredFlaggedAt: r.expired_flagged_at,
    reviewedAt: r.reviewed_at,
  };
}
