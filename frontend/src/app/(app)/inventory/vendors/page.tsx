'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

interface VendorListItem {
  id: string;
  status: 'active' | 'tombstoned';
  versionNumber: number;
  name: string;
  description: string | null;
  contactEmail: string | null;
  dpaReference: string | null;
  country: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const EMPTY_FORM = { name: '', description: '', contactEmail: '', dpaReference: '', country: '' };

/** Third-party processor / vendor register (FR-INV-07) — who else receives this data. */
export default function VendorsPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [vendors, setVendors] = useState<VendorListItem[]>([]);
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
      const res = await apiFetch<{ vendors: VendorListItem[] }>(`/inventory/vendors${query}`);
      setVendors(res.vendors);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the vendor register.');
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
      await apiFetch('/inventory/vendors', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          contactEmail: form.contactEmail.trim() || undefined,
          dpaReference: form.dpaReference.trim() || undefined,
          country: form.country.trim() || undefined,
        },
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this vendor.');
    } finally {
      setBusy(false);
    }
  }

  const canAdd = form.name.trim().length > 0;

  return (
    <div>
      <h1>Vendors &amp; processors</h1>
      <p className="muted">
        Third-party processors who receive data (FR-INV-07). Link a vendor to a data element from the
        element&apos;s own page.
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
            + Add vendor
          </button>
        )}
      </div>

      {adding && (
        <div className="panel" style={{ maxWidth: 480, marginBottom: 16 }}>
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
          <label>Description (optional)</label>
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
          <label>Contact email (optional)</label>
          <input
            value={form.contactEmail}
            onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))}
          />
          <label>DPA reference (optional)</label>
          <input
            value={form.dpaReference}
            onChange={(e) => setForm((f) => ({ ...f, dpaReference: e.target.value }))}
            placeholder="Data Processing Agreement reference"
          />
          <label>Country (optional)</label>
          <input value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button type="button" disabled={busy} onClick={() => { setAdding(false); setForm(EMPTY_FORM); }}>
              Cancel
            </button>
            <button className="primary" type="button" disabled={busy || !canAdd} onClick={() => void onAdd()}>
              {busy ? 'Saving…' : 'Add vendor'}
            </button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Country</th>
              <th>DPA reference</th>
              <th>Version</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr key={v.id}>
                <td>{v.name}</td>
                <td>{v.country || '—'}</td>
                <td>{v.dpaReference || '—'}</td>
                <td className="mono">v{v.versionNumber}</td>
                <td>
                  <span className={`badge ${v.status === 'active' ? 'success' : 'denied'}`}>{v.status}</span>
                </td>
                <td>
                  <Link href={`/inventory/vendors/${v.id}`}>View</Link>
                </td>
              </tr>
            ))}
            {vendors.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No vendors recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
