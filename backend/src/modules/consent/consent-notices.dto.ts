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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Matches a subject timeline's realistic upper bound (a handful of purposes x
 *  a handful of revisions each) with headroom, without letting the query
 *  string become an unbounded list. */
const MAX_NOTICE_IDS = 200;

/** `?ids=a,b,c` for the batched notices lookup — GET, so the ids travel in the
 *  query string, same as any other read-only list filter. */
export function parseNoticeIdsQuery(ids: string | undefined): string[] {
  const raw = (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (raw.length === 0) {
    throw new BadRequestException('ids must be a non-empty comma-separated list of UUIDs.');
  }
  if (raw.length > MAX_NOTICE_IDS) {
    throw new BadRequestException(`ids must contain at most ${MAX_NOTICE_IDS} values.`);
  }
  for (const id of raw) {
    if (!UUID_PATTERN.test(id)) {
      throw new BadRequestException(`"${id}" is not a UUID.`);
    }
  }
  return raw.map((id) => id.toLowerCase());
}
