'use client';

import { useState } from 'react';
import { formPortalFetch, FormPortalApiError } from '../../../lib/form-portal-api';

interface PublicFormRow {
  consentPurposeId: string;
  label: string;
  noticeText: string;
}

/**
 * The interactive half of the hosted consent form. No login, no prior page
 * context — this IS the first place the subject's identity appears, so it
 * collects name + email/phone as its first field (either email or phone is
 * required) before the purpose checkboxes, feeding straight into
 * ConsentFormsService.submitLink() on submit.
 */
export function FormIntake({ slug, rows }: { slug: string; rows: PublicFormRow[] }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const canSubmit = name.trim().length > 0 && (email.trim().length > 0 || phone.trim().length > 0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() && !phone.trim()) {
      setError('Enter an email or a phone number so we can confirm this is you.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await formPortalFetch(`/forms/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        body: {
          name: name.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          answers: rows.map((r) => ({ consentPurposeId: r.consentPurposeId, granted: !!granted[r.consentPurposeId] })),
        },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof FormPortalApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div>
        <h2>Thank you</h2>
        <p className="muted">Your choices have been recorded.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

      <label htmlFor="intake-name">Name</label>
      <input id="intake-name" value={name} onChange={(e) => setName(e.target.value)} required />

      <label htmlFor="intake-email">Email</label>
      <input id="intake-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

      <label htmlFor="intake-phone">Phone</label>
      <input id="intake-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <p className="muted" style={{ fontSize: '0.8rem' }}>Enter at least one of email or phone.</p>

      <h3>Your choices</h3>
      {rows.map((r) => (
        <label key={r.consentPurposeId} style={{ display: 'block', margin: '0.75em 0' }}>
          <input
            type="checkbox"
            style={{ width: 'auto', marginRight: 8 }}
            checked={!!granted[r.consentPurposeId]}
            onChange={(e) => setGranted((prev) => ({ ...prev, [r.consentPurposeId]: e.target.checked }))}
          />
          <strong>{r.label}</strong>
          {r.noticeText && <span className="muted"> — {r.noticeText}</span>}
        </label>
      ))}

      <button className="primary" type="submit" disabled={busy || !canSubmit} style={{ marginTop: 16 }}>
        {busy ? 'Saving…' : 'Save my choices'}
      </button>
    </form>
  );
}
