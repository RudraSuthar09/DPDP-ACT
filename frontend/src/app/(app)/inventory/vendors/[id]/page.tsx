'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { useToast } from '../../../../../components/Toast';

interface VersionEntry {
  versionNumber: number;
  name: string;
  description: string | null;
  contactEmail: string | null;
  dpaReference: string | null;
  country: string | null;
  createdAt: string;
}
interface LinkedEntry {
  linkId: string;
  entryId: string;
  category: string;
}
interface VendorDetail {
  id: string;
  status: 'active' | 'tombstoned';
  tombstoneReason: string | null;
  tombstonedAt: string | null;
  versions: VersionEntry[];
  linkedEntries: LinkedEntry[];
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/** One vendor: its current version, full version history, and linked data elements. */
export default function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [vendor, setVendor] = useState<VendorDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', contactEmail: '', dpaReference: '', country: '' });
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<VendorDetail>(`/inventory/vendors/${id}`);
      setVendor(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this vendor.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function startEdit() {
    if (!vendor) return;
    const current = vendor.versions[0];
    setForm({
      name: current.name,
      description: current.description ?? '',
      contactEmail: current.contactEmail ?? '',
      dpaReference: current.dpaReference ?? '',
      country: current.country ?? '',
    });
    setEditing(true);
  }

  async function onSaveEdit() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/vendors/${id}`, {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          contactEmail: form.contactEmail.trim() || undefined,
          dpaReference: form.dpaReference.trim() || undefined,
          country: form.country.trim() || undefined,
        },
      });
      setEditing(false);
      showToast('Vendor saved as a new version.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this vendor.');
    } finally {
      setBusy(false);
    }
  }

  async function onTombstone() {
    const reason = window.prompt('Why are you removing this vendor? (required, kept as evidence)');
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to remove a vendor.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/vendors/${id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      showToast('Vendor removed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this vendor.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error && !vendor) return <div className="error">{error}</div>;
  if (!vendor) return null;

  const current = vendor.versions[0];
  const canSave = form.name.trim().length > 0;

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); router.push('/inventory/vendors'); }}>
          ← Back to Vendors &amp; processors
        </a>
      </p>
      <h1>{current.name}</h1>
      <span className={`badge ${vendor.status === 'active' ? 'success' : 'denied'}`}>{vendor.status}</span>

      {vendor.status === 'tombstoned' && (
        <div className="notice" style={{ marginTop: 12 }}>
          Tombstoned{vendor.tombstonedAt ? ` on ${new Date(vendor.tombstonedAt).toLocaleString()}` : ''}
          {vendor.tombstoneReason ? ` — ${vendor.tombstoneReason}` : ''}. Never deleted, no longer editable.
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Current version (v{current.versionNumber})</h2>
        {!editing ? (
          <>
            <Field label="Description" value={current.description || '—'} />
            <Field label="Contact email" value={current.contactEmail || '—'} />
            <Field label="DPA reference" value={current.dpaReference || '—'} />
            <Field label="Country" value={current.country || '—'} />
          </>
        ) : (
          <>
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <label>Description</label>
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <label>Contact email</label>
            <input
              value={form.contactEmail}
              onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
            />
            <label>DPA reference</label>
            <input
              value={form.dpaReference}
              onChange={(e) => setForm((f) => ({ ...f, dpaReference: e.target.value }))}
            />
            <label>Country</label>
            <input value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" type="button" disabled={busy || !canSave} onClick={() => void onSaveEdit()}>
                {busy ? 'Saving…' : 'Save (new version)'}
              </button>
            </div>
          </>
        )}
      </div>

      {canManage && vendor.status === 'active' && !editing && (
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
        {vendor.linkedEntries.length === 0 && <p className="muted">No data elements linked yet.</p>}
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {vendor.linkedEntries.map((e) => (
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
              <th>Country</th>
              <th>DPA reference</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {vendor.versions.map((v) => (
              <tr key={v.versionNumber}>
                <td className="mono">
                  v{v.versionNumber}
                  {v.versionNumber === current.versionNumber ? ' (current)' : ''}
                </td>
                <td>{v.name}</td>
                <td>{v.country || '—'}</td>
                <td>{v.dpaReference || '—'}</td>
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
