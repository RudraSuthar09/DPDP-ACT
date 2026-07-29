'use client';

import { useState } from 'react';
import { noticeLanguageLabel, type NoticeLanguageCode } from '@dpdp/shared';

export interface NoticeTranslation {
  language: NoticeLanguageCode;
  body: string;
}

/**
 * Read-only language tab switcher over one already-published notice version's
 * translations (FR-CON-02) — the exact text a data principal was shown, in
 * whichever language they were shown it.
 *
 * Extracted from NoticesPanel so the subject consent timeline can render the
 * same thing: an event's `noticeVersionId` is only evidence if you can read
 * the notice behind it, and it has to read identically in both places.
 */
export function NoticeViewer({ translations }: { translations: NoticeTranslation[] }) {
  const [active, setActive] = useState<NoticeLanguageCode>(translations[0]?.language ?? 'en');
  const current = translations.find((t) => t.language === active) ?? translations[0];

  if (!current) {
    return <p className="muted">No translations recorded for this version.</p>;
  }

  return (
    <div>
      <div className="tab-strip">
        {translations.map((t) => (
          <button
            key={t.language}
            type="button"
            className={`tab${t.language === current.language ? ' current' : ''}`}
            onClick={() => setActive(t.language)}
          >
            {noticeLanguageLabel(t.language)}
          </button>
        ))}
      </div>
      <div className="notice-body">{current.body}</div>
    </div>
  );
}
