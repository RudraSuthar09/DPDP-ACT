import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConsentEventEnvelope, ConsentReceipt, EventSink } from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { TenantDatabaseService } from '../../database/database.service';
import { AuditContextService } from '../audit/audit-context.service';
import { ConsentRepository, type ConsentEventRow, type ConsentPurposeRow } from './consent.repository';
import { EVENT_SINK } from './postgres-event-sink';
import { SubjectRefHasher } from './subject-ref';
import type { RecordConsentBody } from './dto';

/**
 * Consent Register operations (FR-CON-01..08).
 *
 * The one rule this service exists to keep: a consent event is written ONLY
 * through the EventSink (S2, R3). It never issues an INSERT. What it does is the
 * work the sink cannot: pseudonymise the subject (I2), pin the notice version,
 * derive an idempotency key, and hand a well-formed envelope to the seam.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly db: TenantDatabaseService,
    private readonly repo: ConsentRepository,
    private readonly subjectRef: SubjectRefHasher,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
    @Inject(EVENT_SINK) private readonly sink: EventSink,
  ) {}

  // --- purposes -------------------------------------------------------------

  async createPurpose(name: string): Promise<ConsentPurposeRow> {
    const purpose = await this.repo.createPurpose(name);
    this.audit.annotate({
      targetType: 'consent_purpose',
      targetId: purpose.id,
      reason: 'Consent purpose defined',
      afterState: { name: purpose.name },
    });
    return purpose;
  }

  listPurposes(): Promise<ConsentPurposeRow[]> {
    return this.repo.listPurposes();
  }

  // --- events (the seam) ----------------------------------------------------

  /**
   * Record a consent event (FR-CON-03/04/05). A withdrawal is just this with
   * status='WITHDRAWN' — a NEW event, never an update, so FR-CON-06 ("as easy to
   * withdraw as to grant") is the same code path, not a special case.
   */
  async recordConsent(
    body: RecordConsentBody,
  ): Promise<{ receipt: ConsentReceipt; subjectRef: string; purposeName: string }> {
    const ctx = this.tenantContext.getOrThrow();

    // Pseudonymise BEFORE anything else touches the customer id, and let the
    // customer id go out of scope immediately after — it is never stored, logged,
    // or put in the audit entry (I2).
    const subjectRef = this.subjectRef.hash(ctx.tenantId, body.customerId);

    // Confirm the purpose exists in THIS tenant before we write an event that
    // references it (the FK would catch it too, but a 404 reads better than 23503).
    const purpose = await this.db.withTenant((client) => this.repo.findPurpose(client, body.purposeId));
    if (!purpose) {
      throw new NotFoundException('Consent purpose not found.');
    }

    const idempotencyKey =
      body.idempotencyKey ??
      digest([subjectRef, body.purposeId, body.status, body.occurredAt, body.noticeVersionId]);

    // A tamper-evident digest of exactly what was recorded (FR-CON-08). It is NOT
    // the chain hash of S5 — it is a per-event seal that a proof-of-consent
    // certificate can be checked against.
    const evidenceHash = digest([
      subjectRef,
      body.purposeId,
      body.status,
      body.noticeVersionId,
      body.occurredAt,
      body.source,
    ]);

    const envelope: ConsentEventEnvelope = {
      tenantId: ctx.tenantId, // informational; the sink/DB is authoritative on tenant
      subjectRef,
      purposeId: body.purposeId,
      status: body.status,
      noticeVersionId: body.noticeVersionId,
      occurredAt: body.occurredAt,
      recordedAt: new Date().toISOString(), // placeholder; DB stamps the real one
      source: body.source,
      evidenceHash,
      idempotencyKey,
    };

    const receipt = await this.sink.append(envelope);

    // The subject_ref is safe to record — it is already pseudonymised. The raw
    // customer id is not present anywhere in this annotation (I1/I2).
    this.audit.annotate({
      action: body.status === 'WITHDRAWN' ? 'consent.event.withdrawn' : 'consent.event.recorded',
      targetType: 'consent_subject',
      targetId: subjectRef,
      reason: `Consent ${body.status} for purpose ${purpose.name}`,
      afterState: {
        purposeId: body.purposeId,
        status: body.status,
        noticeVersionId: body.noticeVersionId,
        source: body.source,
        deduplicated: receipt.deduplicated,
      },
    });

    return { receipt, subjectRef, purposeName: purpose.name };
  }

  // --- reads (FR-CON-08) ----------------------------------------------------

  history(customerId: string, purposeId: string | null, limit: number): Promise<ConsentEventRow[]> {
    const ctx = this.tenantContext.getOrThrow();
    return this.repo.history(this.subjectRef.hash(ctx.tenantId, customerId), purposeId, limit);
  }

  currentStatus(customerId: string): Promise<ConsentEventRow[]> {
    const ctx = this.tenantContext.getOrThrow();
    return this.repo.currentStatus(this.subjectRef.hash(ctx.tenantId, customerId));
  }
}

/** SHA-256 over a canonical `|`-joined field list. Order is fixed by the caller. */
function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
