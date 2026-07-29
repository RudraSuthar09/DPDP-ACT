'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

interface SystemListItem {
  id: string;
  status: 'active' | 'tombstoned';
  versionNumber: number;
  name: string;
  systemType: string;
  description: string | null;
  hostingLocation: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const EMPTY_FORM = { name: '', systemType: '', description: '', hostingLocation: '' };

/** Systems/assets register (FR-INV-06) — where data lives. */
export default function SystemsPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [systems, setSystems] = useState<SystemListItem[]>([]);
  const [includeTombstoned, setIncludeTombstoned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

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
        },
      });
      setForm(EMPTY_FORM);
      setAdding(false);
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
      <h1>Systems &amp; assets</h1>
      <p className="muted">
        Where data lives (FR-INV-06). Link a system to a data element from the element&apos;s own page.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={includeTombstoned}
            onChange={(e) => setIncludeTombstoned(e.target.checked)}
          />
          Show tombstoned
        </label>
        {canManage && !adding && (
          <button className="primary" type="button" onClick={() => setAdding(true)}>
            + Add system
          </button>
        )}
      </div>

      {adding && (
        <div className="panel" style={{ maxWidth: 480, marginBottom: 16 }}>
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

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Hosting location</th>
              <th>Version</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {systems.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.systemType}</td>
                <td>{s.hostingLocation || '—'}</td>
                <td className="mono">v{s.versionNumber}</td>
                <td>
                  <span className={`badge ${s.status === 'active' ? 'success' : 'denied'}`}>{s.status}</span>
                </td>
                <td>
                  <Link href={`/inventory/systems/${s.id}`}>View</Link>
                </td>
              </tr>
            ))}
            {systems.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No systems recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
