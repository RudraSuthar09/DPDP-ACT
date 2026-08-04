'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../lib/api';

interface LinkedSystem {
  linkId: string;
  id: string;
  name: string;
  systemType: string;
  description: string | null;
  hostingLocation: string | null;
  accessControlNote: string | null;
}
interface SystemOption {
  id: string;
  name: string;
  systemType: string;
}

/**
 * Systems this data element lives on (FR-INV-06), linked from the entry
 * detail page. The systems register itself is managed at /inventory/systems
 * — this panel only picks from it and links/unlinks.
 */
export function LinkedSystemsPanel({ entryId, canManage }: { entryId: string; canManage: boolean }) {
  const [linked, setLinked] = useState<LinkedSystem[]>([]);
  const [options, setOptions] = useState<SystemOption[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [linkedRes, allRes] = await Promise.all([
        apiFetch<{ systems: LinkedSystem[] }>(`/inventory/register/${entryId}/systems`),
        apiFetch<{ systems: SystemOption[] }>('/inventory/systems'),
      ]);
      setLinked(linkedRes.systems);
      setOptions(allRes.systems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load systems.');
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkedIds = new Set(linked.map((l) => l.id));
  const available = options.filter((o) => !linkedIds.has(o.id));

  async function onLink() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/${entryId}/systems`, {
        method: 'POST',
        body: { systemId: selected },
      });
      setSelected('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link this system.');
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(linkId: string, name: string) {
    if (!window.confirm(`Unlink "${name}" from this data element?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/systems/links/${linkId}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not unlink this system.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Systems (where this data lives)</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        FR-INV-06. Manage the systems register itself at{' '}
        <Link href="/inventory/systems">Systems &amp; assets</Link>.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && linked.length === 0 && <p className="muted">No systems linked yet.</p>}
      {!loading &&
        linked.map((s) => (
          <div
            key={s.linkId}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0' }}
          >
            <div>
              <strong>{s.name}</strong> <span className="muted">({s.systemType})</span>
              {s.hostingLocation && <span className="muted"> — {s.hostingLocation}</span>}
              {s.accessControlNote && (
                <div className="muted" style={{ fontSize: '0.8rem', marginTop: 2 }}>
                  Access control: {s.accessControlNote}
                </div>
              )}
            </div>
            {canManage && (
              <button disabled={busy} onClick={() => void onUnlink(s.linkId, s.name)}>
                Unlink
              </button>
            )}
          </div>
        ))}

      {canManage && !loading && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ flex: 1 }}>
            <option value="">
              {available.length === 0 ? 'No more systems to link' : 'Select a system to link…'}
            </option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.systemType})
              </option>
            ))}
          </select>
          <button disabled={busy || !selected} onClick={() => void onLink()}>
            Link
          </button>
        </div>
      )}
    </div>
  );
}
