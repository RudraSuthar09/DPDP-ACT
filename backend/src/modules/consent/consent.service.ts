import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConsentEventEnvelope,
  ConsentEvidenceHashOrigin,
  ConsentReceipt,
  ConsentSource,
  ConsentStatus,
  EventSink,
} from '@dpdp/shared';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { TenantDatabaseService } from '../../database/database.service';
import { AuditContextService } from '../audit/audit-context.service';
import {
  ConsentRepository,
  type ConsentEventRow,
  type ConsentPurposeFields,
  type ConsentPurposeListRow,
  type ConsentPurposeRow,
  type ConsentPurposeVersionRow,
} from './consent.repository';
import { EVENT_SINK } from './postgres-event-sink';
import { SubjectRefHasher } from './subject-ref';
import type { RecordConsentBody, SubjectHistoryQuery } from './dto';
import { WebhookDeliveryService } from '../notify/webhook-delivery.service';

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
    private readonly webhooks: WebhookDeliveryService,
  ) {}

  // --- purposes (FR-CON-01) --------------------------------------------------

  async createPurpose(
    fields: ConsentPurposeFields,
  ): Promise<{ purpose: ConsentPurposeRow; version: ConsentPurposeVersionRow }> {
    const ctx = this.tenantContext.getOrThrow();
    const { purpose, version } = await this.repo.createPurpose(fields, ctx.userId);

    this.audit.annotate({
      targetType: 'consent_purpose',
      targetId: purpose.id,
      reason: `Consent purpose "${fields.name}" defined`,
      afterState: versionState(version),
    });

    return { purpose, version };
  }

  listPurposes(includeTombstoned: boolean): Promise<ConsentPurposeListRow[]> {
    return this.repo.listPurposes(includeTombstoned);
  }

  async findPurposeDetail(
    purposeId: string,
  ): Promise<{ purpose: ConsentPurposeRow; versions: ConsentPurposeVersionRow[] }> {
    const found = await this.repo.findPurposeDetail(purposeId);
    if (!found) {
      throw new NotFoundException('Consent purpose not found.');
    }
    return found;
  }

  /** Edit. Creates a new version — nothing is ever overwritten (I4). */
  async updatePurpose(
    purposeId: string,
    fields: ConsentPurposeFields,
  ): Promise<ConsentPurposeVersionRow> {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.updatePurpose(purposeId, fields, ctx.userId);
    if (!result) {
      throw new NotFoundException('Consent purpose not found, or it has been tombstoned.');
    }

    this.audit.annotate({
      targetType: 'consent_purpose',
      targetId: purposeId,
      reason: `Consent purpose "${fields.name}" edited (version ${result.next.version_number})`,
      beforeState: versionState(result.previous),
      afterState: versionState(result.next),
    });

    return result.next;
  }

  /** Soft-delete. Never a hard delete — dpdp_app holds no DELETE grant (I4). */
  async tombstonePurpose(purposeId: string, reason: string | null): Promise<ConsentPurposeRow> {
    const ctx = this.tenantContext.getOrThrow();
    const purpose = await this.repo.tombstonePurpose(purposeId, reason, ctx.userId);
    if (!purpose) {
      throw new NotFoundException('Consent purpose not found, or it is already tombstoned.');
    }

    this.audit.annotate({
      targetType: 'consent_purpose',
      targetId: purposeId,
      reason: reason ?? 'Consent purpose removed',
      afterState: { status: 'tombstoned' },
    });

    return purpose;
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
    // or put in the audit entry (I2). The secret is this tenant's own, cached
    // in process, so this is not a per-request round trip.
    const subjectRef = await this.subjectRef.hash(ctx.tenantId, body.customerId);

    const { receipt, purposeName } = await this.writeEvent(subjectRef, {
      purposeId: body.purposeId,
      status: body.status,
      noticeVersionId: body.noticeVersionId,
      occurredAt: body.occurredAt,
      source: body.source,
      evidenceHash: body.evidenceHash,
      idempotencyKey: body.idempotencyKey,
    });

    return { receipt, subjectRef, purposeName };
  }

  /**
   * One-click withdrawal (FR-CON-06): a tenant operator withdraws consent FOR
   * a subject/purpose, given only the already-pseudonymised subject reference
   * (never a raw customer id — the caller derives one first, same as the
   * Prompt 21 timeline UI). It goes through the exact same `writeEvent` path
   * as the general ingest endpoint — never an ad-hoc write, never an UPDATE to
   * the GRANTED event it revokes (R3/I4): the withdrawal is a brand new row.
   *
   * The notice version carried on the new event is the one from the subject's
   * MOST RECENT prior event for this purpose — nothing new was disclosed to
   * revoke consent, so there is no new notice to reference, only the one they
   * were already shown.
   */
  async withdrawForSubject(
    subjectRef: string,
    purposeId: string,
    reason: string | null,
  ): Promise<{ receipt: ConsentReceipt; purposeName: string; wasAlreadyWithdrawn: boolean }> {
    const [prior] = await this.repo.history(subjectRef, purposeId, 1);
    if (!prior) {
      throw new NotFoundException(
        'No consent event exists for this subject and purpose — there is nothing to withdraw.',
      );
    }
    if (!prior.notice_version_id) {
      throw new BadRequestException(
        'The most recent event for this subject/purpose predates versioned notices and has no ' +
          'notice_version_id to carry forward. Use the general consent ingest endpoint with an ' +
          'explicit notice version instead.',
      );
    }

    const { receipt, purposeName } = await this.writeEvent(subjectRef, {
      purposeId,
      status: 'WITHDRAWN',
      noticeVersionId: prior.notice_version_id,
      occurredAt: new Date().toISOString(),
      source: 'internal',
      operatorReason: reason,
    });

    return { receipt, purposeName, wasAlreadyWithdrawn: prior.status === 'WITHDRAWN' };
  }

  /**
   * THE shared write path both `recordConsent` and `withdrawForSubject` fall
   * through to (Seam S2, R3) — one validation, one envelope construction, one
   * `sink.append`, one audit annotation, one webhook schedule. A caller
   * arriving with a customer id or with a subject reference it already had
   * both end up here identically; the only difference is who derived the
   * subjectRef and where the notice version came from.
   */
  private async writeEvent(
    subjectRef: string,
    input: {
      purposeId: string;
      status: ConsentStatus;
      noticeVersionId: string;
      occurredAt: string;
      source: ConsentSource;
      evidenceHash?: string;
      idempotencyKey?: string;
      /** A human-supplied reason folded into the audit entry, e.g. why an
       *  operator withdrew this on the subject's behalf. */
      operatorReason?: string | null;
    },
  ): Promise<{ receipt: ConsentReceipt; purposeName: string }> {
    const ctx = this.tenantContext.getOrThrow();

    // One query, not three: does the purpose exist in THIS tenant, is it still
    // active, and is the notice version a notice OF that purpose. All three are
    // re-checked inside app.consent_append (that is where the guarantee lives);
    // this exists so the caller gets a 404/400 naming the problem instead of a
    // raw constraint violation.
    const targets = await this.db.withTenant((client) =>
      this.repo.ingestTargets(client, input.purposeId, input.noticeVersionId),
    );
    if (!targets) {
      throw new NotFoundException('Consent purpose not found.');
    }
    if (targets.purposeStatus !== 'active') {
      throw new BadRequestException(
        'That consent purpose has been tombstoned — no new consent can be recorded against it.',
      );
    }
    if (!targets.noticeBelongsToPurpose) {
      throw new BadRequestException(
        'noticeVersionId is not a notice version of that purpose. Consent must reference the ' +
          'exact notice the data principal was shown for the purpose being consented to (FR-CON-02).',
      );
    }

    const idempotencyKey =
      input.idempotencyKey ??
      digest([subjectRef, input.purposeId, input.status, input.occurredAt, input.noticeVersionId]);

    // A client-supplied hash is the CLIENT's seal over evidence they hold (the
    // rendered notice, the form state). Absent one, we derive our own canonical
    // digest of exactly what was recorded (FR-CON-08). Which of the two it is
    // gets stored alongside it — an evidence field whose meaning you have to
    // guess is not evidence. Neither is the S5 chain hash; this is a per-event
    // seal a proof-of-consent certificate can be checked against.
    //
    // One-click withdrawal never supplies one (it is the platform's own
    // action, not a claim about evidence the client holds) — so it is always
    // 'platform' for that path, exactly as FR-CON-06 requires.
    const evidenceHash =
      input.evidenceHash ??
      digest([
        subjectRef,
        input.purposeId,
        input.status,
        input.noticeVersionId,
        input.occurredAt,
        input.source,
      ]);
    const evidenceHashOrigin: ConsentEvidenceHashOrigin = input.evidenceHash ? 'client' : 'platform';

    const envelope: ConsentEventEnvelope = {
      tenantId: ctx.tenantId, // informational; the sink/DB is authoritative on tenant
      subjectRef,
      purposeId: input.purposeId,
      status: input.status,
      noticeVersionId: input.noticeVersionId,
      occurredAt: input.occurredAt,
      recordedAt: new Date().toISOString(), // placeholder; DB stamps the real one
      source: input.source,
      evidenceHash,
      evidenceHashOrigin,
      idempotencyKey,
    };

    const receipt = await this.sink.append(envelope);

    const defaultReason = `Consent ${input.status} for purpose ${targets.purposeName}`;

    // The subject_ref is safe to record — it is already pseudonymised. The raw
    // customer id is not present anywhere in this annotation (I1/I2).
    this.audit.annotate({
      action: input.status === 'WITHDRAWN' ? 'consent.event.withdrawn' : 'consent.event.recorded',
      targetType: 'consent_subject',
      targetId: subjectRef,
      reason: input.operatorReason ? `${defaultReason} — ${input.operatorReason}` : defaultReason,
      afterState: {
        purposeId: input.purposeId,
        status: input.status,
        noticeVersionId: input.noticeVersionId,
        source: input.source,
        evidenceHashOrigin,
        deduplicated: receipt.deduplicated,
      },
    });

    // FR-CON-07: schedule a signed webhook for every consent change, grant or
    // withdrawal, through this one path — never a special case bolted onto
    // just one of the two callers above.
    await this.webhooks.notifyConsentChange(ctx.tenantId, {
      eventId: receipt.eventId,
      subjectRef,
      purposeId: input.purposeId,
      purposeName: targets.purposeName,
      status: input.status,
      noticeVersionId: input.noticeVersionId,
      occurredAt: input.occurredAt,
      recordedAt: receipt.recordedAt,
      source: input.source,
      evidenceHash,
      evidenceHashOrigin,
    });

    return { receipt, purposeName: targets.purposeName };
  }

  // --- reads (FR-CON-05 / FR-CON-08) ----------------------------------------

  /** Derive the stored reference for a customer id, so a caller can query by it
   *  without ever putting the raw id in a URL. One-way: this cannot be reversed. */
  deriveSubjectRef(customerId: string): Promise<string> {
    const ctx = this.tenantContext.getOrThrow();
    return this.subjectRef.hash(ctx.tenantId, customerId);
  }

  async history(customerId: string, purposeId: string | null, limit: number): Promise<ConsentEventRow[]> {
    const ctx = this.tenantContext.getOrThrow();
    return this.repo.history(await this.subjectRef.hash(ctx.tenantId, customerId), purposeId, limit);
  }

  async currentStatus(customerId: string): Promise<ConsentEventRow[]> {
    const ctx = this.tenantContext.getOrThrow();
    return this.repo.currentStatus(await this.subjectRef.hash(ctx.tenantId, customerId));
  }

  /**
   * The bitemporal answer for one already-pseudonymised subject (FR-CON-05):
   * every event up to `asOf`/`knownAs`, plus the status derived from them per
   * purpose. This is what Prompt 21's timeline UI consumes.
   *
   * Takes the HMAC'd ref, not a customer id — the caller derives it first (see
   * deriveSubjectRef), so the raw customer id never travels in a URL where it
   * would land in access logs and undo the point of pseudonymising it.
   */
  async subjectHistory(
    subjectRef: string,
    query: SubjectHistoryQuery,
    limit: number,
  ): Promise<{ events: ConsentEventRow[]; statusAsOf: ConsentEventRow[] }> {
    const [events, statusAsOf] = await Promise.all([
      this.repo.history(subjectRef, null, limit, query.asOf, query.knownAs),
      this.repo.statusAsOf(subjectRef, query.asOf, query.knownAs),
    ]);
    return { events, statusAsOf };
  }

  /** The "active consents" counter for the compliance dashboard (FR-DSH-01). */
  countActiveConsents(): Promise<number> {
    return this.repo.countActiveConsents();
  }
}

/** SHA-256 over a canonical `|`-joined field list. Order is fixed by the caller. */
function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function versionState(v: ConsentPurposeVersionRow) {
  return {
    versionNumber: v.version_number,
    name: v.purpose_name,
    description: v.description,
  };
}
