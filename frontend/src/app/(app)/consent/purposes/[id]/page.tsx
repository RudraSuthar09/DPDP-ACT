'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { NoticesPanel } from '../../../../../components/NoticesPanel';
import { useToast } from '../../../../../components/Toast';

interface VersionEntry {
  versionNumber: number;
  name: string;
  description: string | null;
  createdAt: string;
}
interface PurposeDetail {
  id: string;
  status: 'active' | 'tombstoned';
  tombstoneReason: string | null;
  tombstonedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versions: VersionEntry[];
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * One consent purpose: its current version, full version history (edits
 * never overwrite — FR-CON-01), and its Notice (FR-CON-02). A tombstoned
 * purpose is shown (never hidden) but read-only, matching the backend's
 * rejection of edits on it — same pattern as the Data Inventory entry page.
 */
export default function ConsentPurposeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [purpose, setPurpose] = useState<PurposeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPurpose(await apiFetch<PurposeDetail>(`/consent/purposes/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this consent purpose.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit() {
    if (!purpose) return;
    const current = purpose.versions[0];
    setEditName(current.name);
    setEditDescription(current.description ?? '');
    setEditing(true);
  }

  async function onSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/consent/purposes/${id}`, {
        method: 'PATCH',
        body: { name: editName.trim(), description: editDescription.trim() || undefined },
      });
      setEditing(false);
      showToast('Purpose saved as a new version.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this purpose.');
    } finally {
      setBusy(false);
    }
  }

  async function onTombstone() {
    const reason = window.prompt(
      'Why are you removing this consent purpose? (required, kept as evidence)',
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to remove a purpose.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/consent/purposes/${id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      showToast('Purpose removed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this purpose.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error && !purpose) return <div className="error">{error}</div>;
  if (!purpose) return null;

  const current = purpose.versions[0];
  const canEdit = canManage && purpose.status === 'active';

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            router.push('/consent');
          }}
        >
          ← Back to Consent Register
        </a>
      </p>
      <h1>{current.name}</h1>
      <span className={`badge ${purpose.status === 'active' ? 'success' : 'denied'}`}>
        {purpose.status}
      </span>

      {purpose.status === 'tombstoned' && (
        <div className="notice" style={{ marginTop: 12 }}>
          Tombstoned
          {purpose.tombstonedAt ? ` on ${new Date(purpose.tombstonedAt).toLocaleString()}` : ''}
          {purpose.tombstoneReason ? ` — ${purpose.tombstoneReason}` : ''}. Never deleted, no longer
          editable.
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Current version (v{current.versionNumber})</h2>

        {!editing ? (
          <>
            <Field label="Name" value={current.name} />
            <Field label="Description" value={current.description || '—'} />
            {canEdit && (
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button className="primary" type="button" disabled={busy} onClick={startEdit}>
                  Edit (creates a new version)
                </button>
                <button type="button" disabled={busy} onClick={() => void onTombstone()}>
                  Remove (tombstone)
                </button>
              </div>
            )}
          </>
        ) : (
          <form onSubmit={onSaveEdit} style={{ maxWidth: 480 }}>
            <label>Name</label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} required autoFocus />
            <label>Description (optional)</label>
            <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" type="submit" disabled={busy || !editName.trim()}>
                {busy ? 'Saving…' : 'Save (new version)'}
              </button>
            </div>
          </form>
        )}
      </div>

      <NoticesPanel purposeId={purpose.id} canManage={canEdit} />

      <h2 style={{ marginTop: 28 }}>Version history</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Every edit creates a new version. Nothing is ever overwritten.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Name</th>
              <th>Description</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {purpose.versions.map((v) => (
              <tr key={v.versionNumber}>
                <td className="mono">
                  v{v.versionNumber}
                  {v.versionNumber === current.versionNumber ? ' (current)' : ''}
                </td>
                <td>{v.name}</td>
                <td>{v.description || '—'}</td>
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
