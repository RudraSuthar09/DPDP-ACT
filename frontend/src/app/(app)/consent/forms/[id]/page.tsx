'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';

interface Row {
  id: string;
  label: string;
  noticeText: string;
  active: boolean;
  inventoryEntryId: string | null;
  inventoryEntryCategory: string | null;
}
interface FormDetail {
  id: string;
  name: string;
  description: string | null;
  slug: string | null;
  isActive: boolean;
  rows: Row[];
}
interface InventoryOption {
  id: string;
  category: string;
  status: string;
}
interface Submission {
  id: string;
  channel: 'widget' | 'link';
  submittedAt: string;
  answers: Array<{ consentPurposeId: string; purposeName: string | null; granted: boolean }>;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const INVENTORY_NEW = '__new__';

export default function ConsentFormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [form, setForm] = useState<FormDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryOption[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Add-row form state
  const [label, setLabel] = useState('');
  const [noticeText, setNoticeText] = useState('');
  const [inventoryChoice, setInventoryChoice] = useState('');
  const [newElementCategory, setNewElementCategory] = useState('');
  const [newElementStorage, setNewElementStorage] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [formRes, invRes, subsRes] = await Promise.all([
        apiFetch<FormDetail>(`/consent/forms/${id}`),
        apiFetch<{ elements: InventoryOption[] }>('/inventory/register'),
        apiFetch<{ submissions: Submission[] }>(`/consent/forms/${id}/submissions`),
      ]);
      setForm(formRes);
      setInventory(invRes.elements.filter((e) => e.status === 'active'));
      setSubmissions(subsRes.submissions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this form.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRename() {
    if (!form) return;
    const name = window.prompt('Rename this form', form.name);
    if (name === null || name.trim().length < 2) return;
    await mutate(() => apiFetch(`/consent/forms/${id}`, { method: 'PUT', body: { name: name.trim(), description: form.description } }));
  }

  async function onToggleForm() {
    if (!form) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/active`, { method: 'PATCH', body: { isActive: !form.isActive } }));
  }

  async function onAddRow() {
    if (!label.trim() || !noticeText.trim()) {
      setError('A row needs a label and a notice sentence.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let inventoryEntryId: string | null = null;
      if (inventoryChoice === INVENTORY_NEW) {
        if (!newElementCategory.trim() || !newElementStorage.trim()) {
          setError('A new Data Inventory element needs a category and a storage location.');
          setBusy(false);
          return;
        }
        // Inline "+ Add new" element — through the real inventory register API.
        const created = await apiFetch<{ id: string }>('/inventory/register', {
          method: 'POST',
          body: { category: newElementCategory.trim(), storageLocation: newElementStorage.trim() },
        });
        inventoryEntryId = created.id;
      } else if (inventoryChoice) {
        inventoryEntryId = inventoryChoice;
      }
      await apiFetch(`/consent/forms/${id}/rows`, {
        method: 'POST',
        body: { label: label.trim(), noticeText: noticeText.trim(), inventoryEntryId },
      });
      setLabel('');
      setNoticeText('');
      setInventoryChoice('');
      setNewElementCategory('');
      setNewElementStorage('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the row.');
    } finally {
      setBusy(false);
    }
  }

  async function onToggleRow(row: Row) {
    await mutate(() => apiFetch(`/consent/forms/${id}/rows/${row.id}/active`, { method: 'PATCH', body: { active: !row.active } }));
  }

  async function onRemoveRow(row: Row) {
    if (!window.confirm(`Remove the "${row.label}" row from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/rows/${row.id}`, { method: 'DELETE' }));
  }

  async function mutate(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!form) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;

  const hostedLink =
    form.slug && typeof window !== 'undefined' ? `${window.location.origin}/forms/${form.slug}` : null;
  const shareText = encodeURIComponent('Please review and complete this consent form: ');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{form.name}</h1>
        <span className={`badge ${form.isActive ? 'success' : 'neutral'}`}>{form.isActive ? 'Live' : 'Off'}</span>
        {canManage && (
          <>
            <button type="button" disabled={busy} onClick={() => void onRename()}>Rename</button>
            <button type="button" className={form.isActive ? '' : 'primary'} disabled={busy} onClick={() => void onToggleForm()}>
              {form.isActive ? 'Turn off' : 'Turn on'}
            </button>
          </>
        )}
      </div>
      <p className="muted">
        Each row below becomes a real, versioned consent purpose and notice behind the scenes — you
        never leave this screen. Toggle rows on/off; only active rows on a live form are shown to the
        public.
      </p>

      {error && <div className="error">{error}</div>}

      {/* --- the flat list of consent rows --- */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Consent rows</h2>
        {form.rows.length === 0 && <p className="muted">No rows yet — add your first below.</p>}
        {form.rows.map((row) => (
          <div key={row.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{row.label}</strong>
                {!row.active && <span className="badge neutral">inactive</span>}
                {row.inventoryEntryCategory && (
                  <span className="badge info">→ {row.inventoryEntryCategory}</span>
                )}
              </div>
              <div className="muted" style={{ fontSize: '0.85rem', marginTop: 2 }}>{row.noticeText}</div>
            </div>
            {canManage && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" disabled={busy} onClick={() => void onToggleRow(row)}>
                  {row.active ? 'Deactivate' : 'Activate'}
                </button>
                <button type="button" disabled={busy} onClick={() => void onRemoveRow(row)}>Remove</button>
              </div>
            )}
          </div>
        ))}

        {canManage && (
          <div style={{ marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Add a consent row</h3>
            <label htmlFor="row-label">Question / label</label>
            <input id="row-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Aadhaar Card" disabled={busy} />
            <label htmlFor="row-notice">Notice sentence (what you tell the person)</label>
            <textarea id="row-notice" rows={2} value={noticeText} onChange={(e) => setNoticeText(e.target.value)} placeholder="e.g. We collect your Aadhaar to verify your identity for KYC." disabled={busy} />
            <label htmlFor="row-inv">Link to a Data Inventory element (optional)</label>
            <select id="row-inv" value={inventoryChoice} onChange={(e) => setInventoryChoice(e.target.value)} disabled={busy}>
              <option value="">Not linked</option>
              {inventory.map((e) => (
                <option key={e.id} value={e.id}>{e.category}</option>
              ))}
              <option value={INVENTORY_NEW}>+ Add new element…</option>
            </select>
            {inventoryChoice === INVENTORY_NEW && (
              <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
                <label htmlFor="new-el-cat" style={{ marginTop: 0 }}>New element category</label>
                <input id="new-el-cat" value={newElementCategory} onChange={(e) => setNewElementCategory(e.target.value)} placeholder="e.g. Aadhaar Card" disabled={busy} />
                <label htmlFor="new-el-store">Storage location</label>
                <input id="new-el-store" value={newElementStorage} onChange={(e) => setNewElementStorage(e.target.value)} placeholder="e.g. Firm's document server" disabled={busy} />
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <button className="primary" type="button" disabled={busy || !label.trim() || !noticeText.trim()} onClick={() => void onAddRow()}>
                {busy ? 'Adding…' : 'Add row'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* --- per-form hosted share link --- */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Share this specific form</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          A direct link to just this form, for sending one consent ask to one person. Your website
          embed is separate and covers all live forms at once — see the <a href="/consent/integration">Integration</a> tab.
        </p>
        {!form.isActive && <div className="notice">This form is currently off — the link will not work until you turn it on.</div>}
        {hostedLink && (
          <>
            <div className="mono panel" style={{ wordBreak: 'break-all', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{hostedLink}</span>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(hostedLink); setCopied(true); }}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <a className="badge success" href={`https://wa.me/?text=${shareText}${encodeURIComponent(hostedLink)}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
              <a className="badge neutral" href={`mailto:?subject=${encodeURIComponent(form.name)}&body=${shareText}${encodeURIComponent(hostedLink)}`}>Share by email</a>
              <a className="badge neutral" href={`sms:?body=${shareText}${encodeURIComponent(hostedLink)}`}>Share by SMS</a>
            </div>
          </>
        )}
      </div>

      {/* --- submissions --- */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Submissions</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Submitted</th>
                <th>Answers</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => (
                <tr key={s.id}>
                  <td>{s.channel === 'widget' ? 'Website embed' : 'Shared link'}</td>
                  <td className="muted">{new Date(s.submittedAt).toLocaleString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {s.answers.map((a) => (
                        <span key={a.consentPurposeId} className={`badge ${a.granted ? 'success' : 'denied'}`}>
                          {a.purposeName ?? a.consentPurposeId}: {a.granted ? 'granted' : 'declined'}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted" style={{ textAlign: 'center', padding: 24 }}>No submissions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
