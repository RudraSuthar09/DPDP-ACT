/**
 * Notice languages (FR-CON-02): DPDP Act Section 3's notice requirement —
 * "English or any language specified in the Eighth Schedule" to the
 * Constitution — plus English itself. One list, shared by the backend's DTO
 * validation and the frontend's language-tab UI so neither can drift from
 * the other. Codes are ISO 639-1 where one exists; for the three languages
 * without a widely-used two-letter code (Bodo, Dogri, Santali) an ISO 639-2/3
 * code is used instead. Mirrored by the CHECK on consent_notice_translations.
 */
export const NOTICE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'as', label: 'Assamese' },
  { code: 'bn', label: 'Bengali' },
  { code: 'brx', label: 'Bodo' },
  { code: 'doi', label: 'Dogri' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'hi', label: 'Hindi' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ks', label: 'Kashmiri' },
  { code: 'kok', label: 'Konkani' },
  { code: 'mai', label: 'Maithili' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mni', label: 'Manipuri (Meitei)' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ne', label: 'Nepali' },
  { code: 'or', label: 'Odia' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'sat', label: 'Santali' },
  { code: 'sd', label: 'Sindhi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'ur', label: 'Urdu' },
] as const;

export type NoticeLanguageCode = (typeof NOTICE_LANGUAGES)[number]['code'];

export const NOTICE_LANGUAGE_CODES = NOTICE_LANGUAGES.map((l) => l.code) as NoticeLanguageCode[];

export function isNoticeLanguageCode(value: unknown): value is NoticeLanguageCode {
  return typeof value === 'string' && (NOTICE_LANGUAGE_CODES as string[]).includes(value);
}

export function noticeLanguageLabel(code: NoticeLanguageCode): string {
  return NOTICE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
