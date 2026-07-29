'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '../../../../../lib/api';

/** Create a consent purpose (FR-CON-01) against the real POST /consent/purposes. */
export default function NewConsentPurposePage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await apiFetch<{ id: string }>('/consent/purposes', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined },
      });
      router.replace(`/consent/purposes/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this purpose.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>New consent purpose</h1>
      <p className="muted">
        e.g. &ldquo;appointment reminders&rdquo;, &ldquo;marketing email&rdquo; — you&apos;ll add the
        notice text next.
      </p>

      <form onSubmit={onSubmit} style={{ maxWidth: 480 }}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />

        <label>Description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />

        {error && <div className="error">{error}</div>}

        <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
          <button type="button" onClick={() => router.push('/consent')}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create purpose'}
          </button>
        </div>
      </form>
    </div>
  );
}
