'use client';

import { useCallback, useEffect, useState } from 'react';
import { NOTICE_LANGUAGES, noticeLanguageLabel, type NoticeLanguageCode } from '@dpdp/shared';
import { apiFetch, ApiError } from '../lib/api';
import { NoticeViewer, type NoticeTranslation } from './NoticeViewer';

interface NoticeVersion {
  id: string;
  purposeId: string;
  versionNumber: number;
  createdAt: string;
  translations: NoticeTranslation[];
}

/**
 * Notice management (FR-CON-02) for one consent purpose — real
 * /consent/purposes/:id/notices endpoints (Prompt 18). Every version is
 * immutable once published: "editing" publishes a NEW version with its own
 * translations, and every past version stays exactly as it was (I4). The
 * language tab switcher (one tab per DPDP Eighth Schedule language, plus
 * English) is used both to VIEW a past version's translations and to EDIT a
 * new one before publishing.
 */
export function NoticesPanel({ purposeId, canManage }: { purposeId: string; canManage: boolean }) {
  const [notices, setNotices] = useState<NoticeVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ notices: NoticeVersion[] }>(
        `/consent/purposes/${purposeId}/notices`,
      );
      setNotices(res.notices);
      // A fresh load shows the current (newest) version expanded by default.
      setExpandedId((prev) => prev ?? res.notices[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load notices.');
    } finally {
      setLoading(false);
    }
  }, [purposeId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onPublish(translations: NoticeTranslation[]) {
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<NoticeVersion>(`/consent/purposes/${purposeId}/notices`, {
        method: 'POST',
        body: { translations },
      });
      setAdding(false);
      await load();
      setExpandedId(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not publish this notice.');
    } finally {
      setBusy(false);
    }
  }

  const current = notices[0];

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Notice</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        The exact text shown to a data principal before consent is collected (FR-CON-02), in every
        language you publish it in. Every edit publishes a new version — nothing already published
        is ever rewritten.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && notices.length === 0 && !adding && (
        <p className="muted">No notice published yet.</p>
      )}

      {!loading &&
        notices.map((n) => (
          <div
            key={n.id}
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span className="mono">v{n.versionNumber}</span>
                {current && n.id === current.id && (
                  <span className="badge success" style={{ marginLeft: 8 }}>
                    current
                  </span>
                )}{' '}
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  published {new Date(n.createdAt).toLocaleString()} · {n.translations.length}{' '}
                  language{n.translations.length === 1 ? '' : 's'}
                </span>
              </div>
              <button type="button" onClick={() => setExpandedId(expandedId === n.id ? null : n.id)}>
                {expandedId === n.id ? 'Hide' : 'View'}
              </button>
            </div>
            {expandedId === n.id && (
              <div style={{ marginTop: 10 }}>
                <NoticeViewer translations={n.translations} />
              </div>
            )}
          </div>
        ))}

      {canManage && adding && (
        <NoticeEditor busy={busy} onCancel={() => setAdding(false)} onSubmit={onPublish} />
      )}

      {canManage && !adding && (
        <button type="button" onClick={() => setAdding(true)}>
          + {notices.length === 0 ? 'Publish a notice' : 'Publish a new version'}
        </button>
      )}
    </div>
  );
}

/** Editable language tab switcher for composing a new notice version before publishing. */
function NoticeEditor({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (translations: NoticeTranslation[]) => void;
}) {
  const [languages, setLanguages] = useState<NoticeLanguageCode[]>(['en']);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [active, setActive] = useState<NoticeLanguageCode>('en');

  const available = NOTICE_LANGUAGES.filter((l) => !languages.includes(l.code));
  const canSubmit = languages.some((l) => (bodies[l] ?? '').trim().length > 0);

  function addLanguage(code: NoticeLanguageCode) {
    setLanguages((ls) => [...ls, code]);
    setActive(code);
  }

  function removeLanguage(code: NoticeLanguageCode) {
    setLanguages((ls) => {
      const next = ls.filter((l) => l !== code);
      if (active === code) {
        setActive(next[0] ?? 'en');
      }
      return next;
    });
    setBodies((b) => {
      const next = { ...b };
      delete next[code];
      return next;
    });
  }

  function submit() {
    const translations = languages
      .map((l) => ({ language: l, body: (bodies[l] ?? '').trim() }))
      .filter((t) => t.body.length > 0);
    onSubmit(translations);
  }

  return (
    <div style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div className="tab-strip">
        {languages.map((l) => (
          <button
            key={l}
            type="button"
            className={`tab${l === active ? ' current' : ''}`}
            onClick={() => setActive(l)}
          >
            {noticeLanguageLabel(l)}
            {languages.length > 1 && (
              <span
                className="tab-remove"
                role="button"
                aria-label={`Remove ${noticeLanguageLabel(l)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  removeLanguage(l);
                }}
              >
                ×
              </span>
            )}
          </button>
        ))}
        {available.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const code = e.target.value as NoticeLanguageCode;
              if (code) addLanguage(code);
            }}
            style={{ width: 'auto' }}
          >
            <option value="">+ Add language</option>
            {available.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <textarea
        rows={6}
        style={{
          width: '100%',
          padding: '8px 10px',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--panel)',
          color: 'var(--text)',
          font: 'inherit',
        }}
        value={bodies[active] ?? ''}
        onChange={(e) => setBodies((b) => ({ ...b, [active]: e.target.value }))}
        placeholder={`Notice text in ${noticeLanguageLabel(active)}…`}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" type="button" disabled={busy || !canSubmit} onClick={submit}>
          {busy ? 'Publishing…' : 'Publish notice'}
        </button>
      </div>
    </div>
  );
}
