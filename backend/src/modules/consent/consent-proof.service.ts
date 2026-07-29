import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { AuditContextService } from '../audit/audit-context.service';
import { ConsentRepository } from './consent.repository';
import { ConsentNoticesService } from './consent-notices.service';
import { renderProofOfConsentPdf } from './proof-of-consent-pdf';
import type { SubjectHistoryQuery } from './dto';

export interface ProofOfConsentResult {
  buffer: Buffer;
  filename: string;
}

/**
 * FR-CON-08 — the proof-of-consent certificate. Reuses, rather than
 * reimplements, everything it needs: `ConsentRepository.history` (the exact
 * bitemporal read Prompt 21's timeline runs), `ConsentNoticesService.findOne`
 * (Prompt 19's real notice text), and `renderProofOfConsentPdf` (Prompt 16's
 * branded PDF pipeline). This service's own job is just the assembly.
 */
@Injectable()
export class ConsentProofService {
  constructor(
    private readonly repo: ConsentRepository,
    private readonly notices: ConsentNoticesService,
    private readonly identity: IdentityService,
    private readonly audit: AuditContextService,
  ) {}

  async generate(
    subjectRef: string,
    purposeId: string,
    query: SubjectHistoryQuery,
  ): Promise<ProofOfConsentResult> {
    // The same bitemporal read subjectHistory uses, narrowed to one purpose —
    // "the event true as of asOf, using only what was known by knownAs".
    const [event] = await this.repo.history(subjectRef, purposeId, 1, query.asOf, query.knownAs);
    if (!event) {
      throw new NotFoundException(
        'No consent event exists for this subject and purpose at the given point in both clocks.',
      );
    }
    if (!event.notice_version_id) {
      throw new BadRequestException(
        'This event predates versioned notices (FR-CON-02) and has no notice_version_id to resolve — ' +
          'a proof-of-consent certificate cannot show text that was never recorded as a real notice ' +
          'version. Its legacyNoticeVersionRef is available via the general history endpoint instead.',
      );
    }

    const [notice, user] = await Promise.all([
      this.notices.findOne(event.notice_version_id),
      this.identity.currentUser(),
    ]);

    const generatedAt = new Date();
    const buffer = await renderProofOfConsentPdf({
      organisationName: user.organisationName,
      generatedAt,
      subjectRef,
      purposeName: event.purpose_name ?? '(purpose name unavailable)',
      event,
      asOf: query.asOf,
      knownAs: query.knownAs,
      noticeTranslations: notice.translations,
      noticeVersionNumber: notice.version.version_number,
    });

    this.audit.annotate({
      targetType: 'consent_subject',
      targetId: subjectRef,
      reason: `Proof-of-consent certificate generated for purpose ${event.purpose_name ?? purposeId}`,
      afterState: {
        purposeId,
        asOf: query.asOf,
        knownAs: query.knownAs,
        eventId: event.id,
        status: event.status,
      },
    });

    const datePart = generatedAt.toISOString().slice(0, 10);
    return {
      buffer,
      filename: `ProofOfConsent-${subjectRef.slice(0, 12)}-${datePart}.pdf`,
    };
  }
}
