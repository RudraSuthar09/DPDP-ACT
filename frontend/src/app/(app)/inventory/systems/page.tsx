'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useToast } from '../../../../components/Toast';
import { PageHeader } from '../../../../components/PageHeader';

interface SystemListItem {
  id: string;
  status: 'active' | 'tombstoned';
  versionNumber: number;
  name: string;
  systemType: string;
  description: string | null;
  hostingLocation: string | null;
  accessControlNote: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const EMPTY_FORM = {
  name: '',
  systemType: '',
  description: '',
  hostingLocation: '',
  accessControlNote: '',
};

/** Systems/assets register (FR-INV-06) — where data lives. */
export default function SystemsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [systems, setSystems] = useState<SystemListItem[]>([]);
  const [includeTombstoned, setIncludeTombstoned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = includeTombstoned ? '?includeTombstoned=true' : '';
      const res = await apiFetch<{ systems: SystemListItem[] }>(`/inventory/systems${query}`);
      setSystems(res.systems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the systems register.');
    } finally {
      setLoading(false);
    }
  }, [includeTombstoned]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAdd() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/inventory/systems', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          systemType: form.systemType.trim(),
          description: form.description.trim() || undefined,
          hostingLocation: form.hostingLocation.trim() || undefined,
          accessControlNote: form.accessControlNote.trim() || undefined,
        },
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      showToast('System added.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this system.');
    } finally {
      setBusy(false);
    }
  }

  const canAdd = form.name.trim().length > 0 && form.systemType.trim().length > 0;

  return (
    <div>
      <PageHeader
        title="Systems & assets"
        subtitle="Where data lives. Link a system to a data element from the element's own page."
        actions={
          canManage && !adding ? (
            <button className="primary" type="button" onClick={() => setAdding(true)}>
              + Add system
            </button>
          ) : undefined
        }
      />

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={includeTombstoned}
            onChange={(e) => setIncludeTombstoned(e.target.checked)}
          />
          Show tombstoned
        </label>
      </div>

      {adding && (
        <div className="panel reveal" style={{ maxWidth: 480, marginBottom: 16 }}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          <label>Type</label>
          <input
            value={form.systemType}
            onChange={(e) => setForm((f) => ({ ...f, systemType: e.target.value }))}
            placeholder="e.g. database, SaaS, file store"
          />
          <label>Description (optional)</label>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <label>Hosting location (optional)</label>
          <input
            value={form.hostingLocation}
            onChange={(e) => setForm((f) => ({ ...f, hostingLocation: e.target.value }))}
            placeholder="e.g. AWS ap-south-1"
          />
          <label>Access control policy (optional)</label>
          <textarea
            rows={3}
            value={form.accessControlNote}
            onChange={(e) => setForm((f) => ({ ...f, accessControlNote: e.target.value }))}
            placeholder="Who may access data on this system, and under what policy — e.g. &quot;restricted to staff directly involved in the assignment, need-to-know basis; access logged&quot;"
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={() => { setAdding(false); setForm(EMPTY_FORM); }}>
              Cancel
            </button>
            <button className="primary" type="button" disabled={busy || !canAdd} onClick={() => void onAdd()}>
              {busy ? 'Saving…' : 'Add system'}
            </button>
          </div>
        </div>
      )}

      <div className="entry-grid" data-tour="systems-register">
        {systems.map((s) => (
          <div key={s.id} className="entry-card">
            <div className="entry-card-title">{s.name}</div>
            <div className="entry-card-meta">
              <div className="entry-card-field">
                <div className="field-label">Type</div>
                <div className="field-value">{s.systemType}</div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Hosting location</div>
                <div className="field-value">{s.hostingLocation || '—'}</div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Status</div>
                <div className={`field-value ${s.status === 'active' ? 'status-active' : 'status-muted'}`}>
                  {s.status === 'active' ? 'Active' : 'Tombstoned'}
                </div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Version</div>
                <div className="field-value mono">v{s.versionNumber}</div>
              </div>
            </div>
            <div className="entry-card-footer">
              <button type="button" onClick={() => router.push(`/inventory/systems/${s.id}`)}>
                View details
              </button>
            </div>
          </div>
        ))}
        {systems.length === 0 && !loading && (
          <p className="muted" style={{ textAlign: 'center', padding: 24, gridColumn: '1 / -1' }}>
            No systems recorded yet.
          </p>
        )}
      </div>
    </div>
  );
}
