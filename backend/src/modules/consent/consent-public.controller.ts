import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../tenancy/tenant.guard';
import { AllowPublicKey } from '../identity/rbac/roles.decorator';
import { Audited } from '../audit/audited.decorator';
import { AuditContextService } from '../audit/audit-context.service';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import type { RequestWithConsentApiKey } from '../../tenancy/public-api-key.middleware';
import { ConsentService } from './consent.service';
import { SubjectRefHasher } from './subject-ref';
import { parsePublicWithdrawInput, parseRecordConsent } from './dto';

/**
 * FR-CON-09: the two routes the Consent SDK actually calls, reachable by a
 * public API key (PublicApiKeyMiddleware) instead of a staff JWT. Both are
 * thin wrappers — they parse, force `source`, hash, and hand off to the exact
 * same ConsentService methods the staff-facing ConsentController uses. There
 * is no second write path into consent_events here (R3): everything still
 * goes through recordConsent/withdrawForSubject -> writeEvent -> the sink.
 *
 * Lives inside ConsentModule's own directory (not a separate module) so it
 * gets ConsentService/SubjectRefHasher via ordinary same-module DI, and stays
 * inside the directory event-sink-write-path.spec.ts permits.
 */
@Controller('consent/public')
@UseGuards(TenantGuard)
export class ConsentPublicController {
  constructor(
    private readonly consent: ConsentService,
    private readonly subjectRef: SubjectRefHasher,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  @Post('events')
  // See roles.decorator.ts: AllowPublicKey, not AllowReadOnly — this route
  // genuinely writes to consent_events. It only needs an escape from the
  // read-only floor because API-key requests carry a synthetic role: 'viewer'
  // (PublicApiKeyMiddleware) with no real RBAC role to report.
  @AllowPublicKey()
  @Audited('consent.event.recorded')
  @HttpCode(HttpStatus.CREATED)
  async record(@Body() body: unknown, @Req() req: RequestWithConsentApiKey) {
    this.labelActor(req);
    const parsed = parseRecordConsent(body);
    // Never client-controlled: provenance must say this really came through
    // the key-authenticated public route, not whatever the caller claims (I4).
    parsed.source = 'web_sdk';
    const { receipt, subjectRef, purposeName } = await this.consent.recordConsent(parsed);
    return {
      eventId: receipt.eventId,
      subjectRef,
      purposeName,
      recordedAt: receipt.recordedAt,
      deduplicated: receipt.deduplicated,
    };
  }

  @Post('withdraw')
  @AllowPublicKey()
  @Audited('consent.event.withdrawn')
  @HttpCode(HttpStatus.CREATED)
  async withdraw(@Body() body: unknown, @Req() req: RequestWithConsentApiKey) {
    this.labelActor(req);
    const { customerId, purposeId, reason } = parsePublicWithdrawInput(body);
    const ctx = this.tenantContext.getOrThrow();
    const ref = await this.subjectRef.hash(ctx.tenantId, customerId);
    const { receipt, purposeName, wasAlreadyWithdrawn } = await this.consent.withdrawForSubject(
      ref,
      purposeId,
      reason,
    );
    return {
      eventId: receipt.eventId,
      subjectRef: ref,
      purposeId,
      purposeName,
      recordedAt: receipt.recordedAt,
      deduplicated: receipt.deduplicated,
      wasAlreadyWithdrawn,
    };
  }

  /** Audit rows for these routes get actor_id = the key's creator (forced by
   *  the audit table's FK to users — see public-api-key.middleware.ts). This label
   *  is what actually distinguishes "the SDK wrote this" from "the creator
   *  clicked a button themselves" when reading the log. */
  private labelActor(req: RequestWithConsentApiKey): void {
    if (req.consentApiKeyId) {
      this.audit.annotate({ actorLabel: `consent_sdk:${req.consentApiKeyId}` });
    }
  }
}
