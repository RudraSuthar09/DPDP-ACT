'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../lib/api';
import { useToast } from './Toast';

interface LinkedVendor {
  linkId: string;
  id: string;
  name: string;
  description: string | null;
  country: string | null;
  transferNotes: string | null;
}
interface VendorOption {
  id: string;
  name: string;
  country: string | null;
}

/**
 * Vendors/third-party processors this data element is shared with
 * (FR-INV-07/10 — the "recipient" in elements -> purposes -> recipients),
 * linked from the entry detail page. The vendor register itself is managed
 * at /inventory/vendors.
 */
export function LinkedVendorsPanel({ entryId, canManage }: { entryId: string; canManage: boolean }) {
  const [linked, setLinked] = useState<LinkedVendor[]>([]);
  const [options, setOptions] = useState<VendorOption[]>([]);
  const [selected, setSelected] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  // Inline "+ Add new vendor" — creates through the SAME POST /inventory/vendors
  // the dedicated Vendors register page uses (no new backend), then links the
  // new vendor to this entry.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCountry, setNewCountry] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [linkedRes, allRes] = await Promise.all([
        apiFetch<{ vendors: LinkedVendor[] }>(`/inventory/register/${entryId}/vendors`),
        apiFetch<{ vendors: VendorOption[] }>('/inventory/vendors'),
      ]);
      setLinked(linkedRes.vendors);
      setOptions(allRes.vendors);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load vendors.');
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
      await apiFetch(`/inventory/register/${entryId}/vendors`, {
        method: 'POST',
        body: { vendorId: selected, ...(notes.trim() ? { transferNotes: notes.trim() } : {}) },
      });
      setSelected('');
      setNotes('');
      showToast('Vendor linked.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not link this vendor.');
    } finally {
      setBusy(false);
    }
  }

  async function onUnlink(linkId: string, name: string) {
    if (!window.confirm(`Unlink "${name}" from this data element?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/vendors/links/${linkId}`, { method: 'DELETE' });
      showToast('Vendor unlinked.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not unlink this vendor.');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateAndLink() {
    if (!newName.trim()) {
      setError('A new vendor needs a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 1. Create it in the real Vendors register (same endpoint as /inventory/vendors).
      const created = await apiFetch<{ id: string }>('/inventory/vendors', {
        method: 'POST',
        body: { name: newName.trim(), ...(newCountry.trim() ? { country: newCountry.trim() } : {}) },
      });
      // 2. Link the brand-new vendor to this entry (carrying any transfer notes typed above).
      await apiFetch(`/inventory/register/${entryId}/vendors`, {
        method: 'POST',
        body: { vendorId: created.id, ...(notes.trim() ? { transferNotes: notes.trim() } : {}) },
      });
      setNewName('');
      setNewCountry('');
      setNotes('');
      setAdding(false);
      showToast('Vendor created and linked.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create and link this vendor.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>Vendors (who else receives this data)</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        Manage the vendor register itself at{' '}
        <Link href="/inventory/vendors">Vendors &amp; processors</Link>.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && linked.length === 0 && <p className="muted">No vendors linked yet.</p>}
      {!loading &&
        linked.map((v) => (
          <div
            key={v.linkId}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', padding: '6px 0' }}
          >
            <div>
              <strong>{v.name}</strong> {v.country && <span className="muted">({v.country})</span>}
              {v.transferNotes && <div className="muted" style={{ fontSize: '0.85rem' }}>{v.transferNotes}</div>}
            </div>
            {canManage && (
              <button disabled={busy} onClick={() => void onUnlink(v.linkId, v.name)}>
                Unlink
              </button>
            )}
          </div>
        ))}

      {canManage && !loading && !adding && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ flex: 1 }}>
              <option value="">
                {available.length === 0 ? 'No existing vendors to link' : 'Select a vendor to link…'}
              </option>
              {available.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.country ? ` (${o.country})` : ''}
                </option>
              ))}
            </select>
          </div>
          <input
            style={{ marginTop: 8 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Transfer notes (optional) — e.g. SCC executed, purpose of the transfer"
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="primary" disabled={busy || !selected} onClick={() => void onLink()}>
              Link
            </button>
            <button disabled={busy} onClick={() => { setAdding(true); setSelected(''); setError(null); }}>
              + Add new vendor
            </button>
          </div>
        </div>
      )}

      {canManage && !loading && adding && (
        <div className="reveal" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label htmlFor="new-vendor-name" style={{ marginTop: 0 }}>New vendor name</label>
          <input
            id="new-vendor-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Income Tax Portal"
            disabled={busy}
          />
          <label htmlFor="new-vendor-country">Country (optional)</label>
          <input
            id="new-vendor-country"
            value={newCountry}
            onChange={(e) => setNewCountry(e.target.value)}
            placeholder="e.g. India"
            disabled={busy}
          />
          <input
            style={{ marginTop: 8 }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Transfer notes (optional) — e.g. SCC executed, purpose of the transfer"
            disabled={busy}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="primary" disabled={busy || !newName.trim()} onClick={() => void onCreateAndLink()}>
              {busy ? 'Adding…' : 'Create & link'}
            </button>
            <button disabled={busy} onClick={() => { setAdding(false); setNewName(''); setNewCountry(''); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
