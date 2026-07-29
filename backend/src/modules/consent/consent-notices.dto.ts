import { BadRequestException } from '@nestjs/common';
import { isNoticeLanguageCode } from '@dpdp/shared';
import type { NoticeTranslationInput } from './consent-notices.repository';

/** Request parsing for /consent/purposes/:purposeId/notices. Same
 *  hand-written, total style as the rest of this module's DTOs. */

const MAX_NOTICE_BODY_LENGTH = 20_000;

export function parseCreateNotice(body: unknown): NoticeTranslationInput[] {
  const obj = asObject(body);
  const translations = obj.translations;
  if (!Array.isArray(translations) || translations.length === 0) {
    throw new BadRequestException('translations must be a non-empty array.');
  }

  const seen = new Set<string>();
  const result: NoticeTranslationInput[] = [];
  for (const entry of translations) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BadRequestException('Each entry in translations must be a JSON object.');
    }
    const record = entry as Record<string, unknown>;

    const language = record.language;
    if (!isNoticeLanguageCode(language)) {
      throw new BadRequestException(
        'Each translation.language must be one of the DPDP Eighth Schedule language codes (or "en").',
      );
    }
    if (seen.has(language)) {
      throw new BadRequestException(`translations contains language "${language}" more than once.`);
    }
    seen.add(language);

    const bodyText = record.body;
    if (typeof bodyText !== 'string' || bodyText.trim().length === 0) {
      throw new BadRequestException(`translations[].body is required for language "${language}".`);
    }
    const trimmed = bodyText.trim();
    if (trimmed.length > MAX_NOTICE_BODY_LENGTH) {
      throw new BadRequestException(
        `translations[].body must be at most ${MAX_NOTICE_BODY_LENGTH} characters.`,
      );
    }

    result.push({ language, body: trimmed });
  }

  return result;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}
