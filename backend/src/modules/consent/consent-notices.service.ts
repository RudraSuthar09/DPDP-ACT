import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService } from '../../tenancy/tenant-context.service';
import { AuditContextService } from '../audit/audit-context.service';
import {
  ConsentNoticesRepository,
  type NoticeTranslationInput,
  type NoticeVersionWithTranslations,
} from './consent-notices.repository';

/**
 * Notice management (FR-CON-02): versioned, multilingual notice text per
 * consent purpose. "Editing" a notice is publishing a new version — there is
 * no update method here, mirroring RegisterService/ConsentService's own
 * append-only purposes.
 */
@Injectable()
export class ConsentNoticesService {
  constructor(
    private readonly repo: ConsentNoticesRepository,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditContextService,
  ) {}

  async create(
    purposeId: string,
    translations: NoticeTranslationInput[],
  ): Promise<NoticeVersionWithTranslations> {
    const ctx = this.tenantContext.getOrThrow();
    const result = await this.repo.create(purposeId, translations, ctx.userId);
    if (!result) {
      throw new NotFoundException('Consent purpose not found, or it has been tombstoned.');
    }

    const languages = translations.map((t) => t.language).join(', ');
    this.audit.annotate({
      // v1 is the notice's first publication; v2+ is a revision — same
      // dynamic-action-name pattern ConsentService already uses for
      // GRANTED vs WITHDRAWN, so the log reads true either way.
      action: result.version.version_number === 1 ? 'consent.notice.created' : 'consent.notice.updated',
      targetType: 'consent_notice_version',
      targetId: result.version.id,
      reason: `Notice v${result.version.version_number} published for a consent purpose (${languages})`,
      afterState: {
        purposeId,
        versionNumber: result.version.version_number,
        languages: translations.map((t) => t.language),
      },
    });

    return result;
  }

  listForPurpose(purposeId: string): Promise<NoticeVersionWithTranslations[]> {
    return this.repo.listForPurpose(purposeId);
  }

  async findOne(noticeVersionId: string): Promise<NoticeVersionWithTranslations> {
    const found = await this.repo.findOne(noticeVersionId);
    if (!found) {
      throw new NotFoundException('Notice version not found.');
    }
    return found;
  }

  /** Batched `findOne`, for a caller resolving many distinct notice versions
   *  at once (the subject timeline) instead of one request per id. */
  findMany(noticeVersionIds: string[]): Promise<NoticeVersionWithTranslations[]> {
    const unique = Array.from(new Set(noticeVersionIds));
    return this.repo.findMany(unique);
  }
}
