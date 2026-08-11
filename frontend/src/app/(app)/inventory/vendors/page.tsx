'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { useToast } from '../../../../components/Toast';
import { PageHeader } from '../../../../components/PageHeader';

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
  const router = useRouter();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [vendors, setVendors] = useState<VendorListItem[]>([]);
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
      showToast('Vendor added.');
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
      <PageHeader
        title="Vendors & processors"
        subtitle="Third-party processors who receive data. Link a vendor to a data element from the element's own page."
        actions={
          canManage && !adding ? (
            <button className="primary" type="button" onClick={() => setAdding(true)}>
              + Add vendor
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

      <div className="entry-grid">
        {vendors.map((v) => (
          <div key={v.id} className="entry-card">
            <div className="entry-card-title">{v.name}</div>
            <div className="entry-card-meta">
              <div className="entry-card-field">
                <div className="field-label">Country</div>
                <div className="field-value">{v.country || '—'}</div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">DPA reference</div>
                <div className="field-value">{v.dpaReference || '—'}</div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Status</div>
                <div className={`field-value ${v.status === 'active' ? 'status-active' : 'status-muted'}`}>
                  {v.status === 'active' ? 'Active' : 'Tombstoned'}
                </div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Version</div>
                <div className="field-value mono">v{v.versionNumber}</div>
              </div>
            </div>
            <div className="entry-card-footer">
              <button type="button" onClick={() => router.push(`/inventory/vendors/${v.id}`)}>
                View details
              </button>
            </div>
          </div>
        ))}
        {vendors.length === 0 && !loading && (
          <p className="muted" style={{ textAlign: 'center', padding: 24, gridColumn: '1 / -1' }}>
            No vendors recorded yet.
          </p>
        )}
      </div>
    </div>
  );
}
