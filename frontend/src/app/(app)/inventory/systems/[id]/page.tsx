'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';

interface VersionEntry {
  versionNumber: number;
  name: string;
  systemType: string;
  description: string | null;
  hostingLocation: string | null;
  accessControlNote: string | null;
  createdAt: string;
}
interface LinkedEntry {
  linkId: string;
  entryId: string;
  category: string;
}
interface SystemDetail {
  id: string;
  status: 'active' | 'tombstoned';
  tombstoneReason: string | null;
  tombstonedAt: string | null;
  versions: VersionEntry[];
  linkedEntries: LinkedEntry[];
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/** One system: its current version, full version history, and linked data elements. */
export default function SystemDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [system, setSystem] = useState<SystemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: '',
    systemType: '',
    description: '',
    hostingLocation: '',
    accessControlNote: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<SystemDetail>(`/inventory/systems/${id}`);
      setSystem(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this system.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit() {
    if (!system) return;
    const current = system.versions[0];
    setForm({
      name: current.name,
      systemType: current.systemType,
      description: current.description ?? '',
      hostingLocation: current.hostingLocation ?? '',
      accessControlNote: current.accessControlNote ?? '',
    });
    setEditing(true);
  }

  async function onSaveEdit() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/systems/${id}`, {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          systemType: form.systemType.trim(),
          description: form.description.trim() || undefined,
          hostingLocation: form.hostingLocation.trim() || undefined,
          accessControlNote: form.accessControlNote.trim() || undefined,
        },
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this system.');
    } finally {
      setBusy(false);
    }
  }

  async function onTombstone() {
    const reason = window.prompt('Why are you removing this system? (required, kept as evidence)');
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to remove a system.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/systems/${id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this system.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error && !system) return <div className="error">{error}</div>;
  if (!system) return null;

  const current = system.versions[0];
  const canAdd = form.name.trim().length > 0 && form.systemType.trim().length > 0;

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); router.push('/inventory/systems'); }}>
          ← Back to Systems &amp; assets
        </a>
      </p>
      <h1>{current.name}</h1>
      <span className={`badge ${system.status === 'active' ? 'success' : 'denied'}`}>{system.status}</span>

      {system.status === 'tombstoned' && (
        <div className="notice" style={{ marginTop: 12 }}>
          Tombstoned{system.tombstonedAt ? ` on ${new Date(system.tombstonedAt).toLocaleString()}` : ''}
          {system.tombstoneReason ? ` — ${system.tombstoneReason}` : ''}. Never deleted, no longer editable.
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Current version (v{current.versionNumber})</h2>
        {!editing ? (
          <>
            <Field label="Type" value={current.systemType} />
            <Field label="Description" value={current.description || '—'} />
            <Field label="Hosting location" value={current.hostingLocation || '—'} />
            <Field label="Access control policy" value={current.accessControlNote || '—'} />
          </>
        ) : (
          <>
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <label>Type</label>
            <input
              value={form.systemType}
              onChange={(e) => setForm((f) => ({ ...f, systemType: e.target.value }))}
            />
            <label>Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <label>Hosting location</label>
            <input
              value={form.hostingLocation}
              onChange={(e) => setForm((f) => ({ ...f, hostingLocation: e.target.value }))}
            />
            <label>Access control policy</label>
            <textarea
              rows={3}
              value={form.accessControlNote}
              onChange={(e) => setForm((f) => ({ ...f, accessControlNote: e.target.value }))}
              placeholder="Who may access data on this system, and under what policy."
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" type="button" disabled={busy || !canAdd} onClick={() => void onSaveEdit()}>
                {busy ? 'Saving…' : 'Save (new version)'}
              </button>
            </div>
          </>
        )}
      </div>

      {canManage && system.status === 'active' && !editing && (
        <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
          <button className="primary" disabled={busy} onClick={startEdit}>
            Edit (creates a new version)
          </button>
          <button disabled={busy} onClick={() => void onTombstone()}>
            Remove (tombstone)
          </button>
        </div>
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Linked data elements</h2>
        {system.linkedEntries.length === 0 && <p className="muted">No data elements linked yet.</p>}
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {system.linkedEntries.map((e) => (
            <li key={e.linkId}>
              <Link href={`/inventory/${e.entryId}`}>{e.category}</Link>
            </li>
          ))}
        </ul>
      </div>

      <h2 style={{ marginTop: 28 }}>Version history</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Name</th>
              <th>Type</th>
              <th>Hosting location</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {system.versions.map((v) => (
              <tr key={v.versionNumber}>
                <td className="mono">
                  v{v.versionNumber}
                  {v.versionNumber === current.versionNumber ? ' (current)' : ''}
                </td>
                <td>{v.name}</td>
                <td>{v.systemType}</td>
                <td>{v.hostingLocation || '—'}</td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: '0.8rem' }}>
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}
