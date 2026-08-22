'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CONSENT_FORM_FIELD_TYPES, type ConsentFormCustomerField, type ConsentFormFieldType, type StorageMapping } from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { useToast } from '../../../../../components/Toast';
import {
  connectAdditionalStorageForEntity,
  getAdditionalStorageMapping,
  getCentralStorageStatus,
  removeAdditionalStorageMapping,
  type CentralStorageState,
} from '../../../../../lib/central-storage';

interface Row {
  id: string;
  label: string;
  noticeText: string;
  active: boolean;
  inventoryEntryId: string | null;
  inventoryEntryCategory: string | null;
  consentPurposeId: string;
  noticeVersionId: string;
}
interface FormDetail {
  id: string;
  name: string;
  description: string | null;
  noticeText: string | null;
  slug: string | null;
  isActive: boolean;
  retentionMonths: number | null;
  rows: Row[];
  customerFields: ConsentFormCustomerField[];
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

/** Quick-fill presets: convenience only. Choosing one pre-fills the label
 *  and field type — it never selects or implies a storage location. The
 *  label and type both remain freely editable afterward, and "Custom
 *  field…" leaves the label blank for free typing. */
const FIELD_LABEL_PRESETS: Array<{ label: string; fieldType: ConsentFormFieldType }> = [
  { label: 'Name', fieldType: 'text' },
  { label: 'Mobile Number', fieldType: 'text' },
  { label: 'Email', fieldType: 'text' },
  { label: 'Aadhaar Number', fieldType: 'text' },
  { label: 'PAN Number', fieldType: 'text' },
  { label: 'Address', fieldType: 'text' },
  { label: 'Date of Birth', fieldType: 'text' },
  { label: 'Identity Document', fieldType: 'pdf' },
  { label: 'Address Proof', fieldType: 'pdf' },
  { label: 'Financial Statement', fieldType: 'excel' },
];

export default function ConsentFormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [form, setForm] = useState<FormDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryOption[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  // --- Notice / Terms ---------------------------------------------------------
  const [formNoticeText, setFormNoticeText] = useState('');

  // --- Retention ---------------------------------------------------------------
  const [retentionMonthsInput, setRetentionMonthsInput] = useState('');

  // --- Central DPDP Storage status (read-only display) --------------------------
  const [centralStorage, setCentralStorage] = useState<CentralStorageState>({
    status: 'checking',
    root: null,
    handle: null,
    displayName: null,
  });

  // --- Form Fields: a simple, Google-Forms-like list + per-field Additional
  //     Storage (moduleKey 'consent_form_field', entityId = the field's own id) ---
  const [cfLabel, setCfLabel] = useState('');
  const [cfType, setCfType] = useState<ConsentFormFieldType>('text');
  const [cfRequired, setCfRequired] = useState(false);
  const [cfIsIdentifier, setCfIsIdentifier] = useState(false);
  const [fieldStorage, setFieldStorage] = useState<Record<string, StorageMapping | null>>({});
  const [fieldStorageLoaded, setFieldStorageLoaded] = useState(false);
  const [fieldStorageBusy, setFieldStorageBusy] = useState<Record<string, boolean>>({});
  const [fieldStorageError, setFieldStorageError] = useState<string | null>(null);

  // Add-consent-item form state
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
      setFormNoticeText(formRes.noticeText ?? '');
      setRetentionMonthsInput(formRes.retentionMonths != null ? String(formRes.retentionMonths) : '');
      setInventory(invRes.elements.filter((e) => e.status === 'active'));
      setSubmissions(subsRes.submissions);
      getCentralStorageStatus().then(setCentralStorage).catch(() => undefined);

      setFieldStorageLoaded(false);
      Promise.all(
        formRes.customerFields.map((f) =>
          getAdditionalStorageMapping('consent_form_field', f.id).then((m) => [f.id, m] as const),
        ),
      )
        .then((entries) => {
          setFieldStorage(Object.fromEntries(entries));
          setFieldStorageLoaded(true);
        })
        .catch(() => setFieldStorageLoaded(true));
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
    await mutate(
      () =>
        apiFetch(`/consent/forms/${id}`, {
          method: 'PUT',
          body: { name: name.trim(), description: form.description, noticeText: form.noticeText, retentionMonths: form.retentionMonths },
        }),
      'Form renamed.',
    );
  }

  async function onSaveNotice() {
    if (!form) return;
    await mutate(
      () =>
        apiFetch(`/consent/forms/${id}`, {
          method: 'PUT',
          body: { name: form.name, description: form.description, noticeText: formNoticeText.trim() || null, retentionMonths: form.retentionMonths },
        }),
      'Notice saved.',
    );
  }

  async function onSaveRetention() {
    if (!form) return;
    const trimmed = retentionMonthsInput.trim();
    const retentionMonths = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isInteger(retentionMonths) || (retentionMonths as number) <= 0)) {
      setError('Retention period must be a positive whole number of months, or left blank.');
      return;
    }
    await mutate(
      () =>
        apiFetch(`/consent/forms/${id}`, {
          method: 'PUT',
          body: { name: form.name, description: form.description, noticeText: form.noticeText, retentionMonths },
        }),
      'Retention period saved.',
    );
  }

  async function onToggleForm() {
    if (!form) return;
    const turningOn = !form.isActive;
    await mutate(
      () => apiFetch(`/consent/forms/${id}/active`, { method: 'PATCH', body: { isActive: turningOn } }),
      turningOn ? 'Form turned on.' : 'Form turned off.',
    );
  }

  async function onAddRow() {
    if (!label.trim() || !noticeText.trim()) {
      setError('A consent item needs a label and a notice sentence.');
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
      showToast('Consent item added.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the consent item.');
    } finally {
      setBusy(false);
    }
  }

  async function onToggleRow(row: Row) {
    const activating = !row.active;
    await mutate(
      () => apiFetch(`/consent/forms/${id}/rows/${row.id}/active`, { method: 'PATCH', body: { active: activating } }),
      activating ? 'Consent item activated.' : 'Consent item deactivated.',
    );
  }

  async function onRemoveRow(row: Row) {
    if (!window.confirm(`Remove the "${row.label}" consent item from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/rows/${row.id}`, { method: 'DELETE' }), 'Consent item removed.');
  }

  async function mutate(fn: () => Promise<unknown>, successMessage?: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (successMessage) showToast(successMessage);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  // --- Form Fields --------------------------------------------------------------

  function onPickPreset(presetLabel: string) {
    const preset = FIELD_LABEL_PRESETS.find((p) => p.label === presetLabel);
    if (!preset) return; // "Custom field…" — leave label as-is for free typing.
    setCfLabel(preset.label);
    setCfType(preset.fieldType);
  }

  async function onAddCustomerField() {
    if (!cfLabel.trim()) {
      setError('A field needs a label.');
      return;
    }
    await mutate(
      () =>
        apiFetch(`/consent/forms/${id}/customer-fields`, {
          method: 'POST',
          body: { label: cfLabel.trim(), fieldType: cfType, required: cfRequired, isIdentifier: cfIsIdentifier },
        }),
      'Field added.',
    );
    setCfLabel('');
    setCfType('text');
    setCfRequired(false);
    setCfIsIdentifier(false);
  }

  async function onRemoveCustomerField(field: ConsentFormCustomerField) {
    if (!window.confirm(`Remove the "${field.label}" field from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/customer-fields/${field.id}`, { method: 'DELETE' }), 'Field removed.');
  }

  async function onConnectFieldStorage(field: ConsentFormCustomerField) {
    setFieldStorageBusy((prev) => ({ ...prev, [field.id]: true }));
    setFieldStorageError(null);
    try {
      const { folder } = await connectAdditionalStorageForEntity('consent_form_field', field.id, field.label);
      const mapping = await getAdditionalStorageMapping('consent_form_field', field.id);
      setFieldStorage((prev) => ({ ...prev, [field.id]: mapping }));
      showToast(`Additional storage connected for "${field.label}": ${folder.name}`);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setFieldStorageError(err instanceof Error ? err.message : 'Could not connect additional storage.');
      }
    } finally {
      setFieldStorageBusy((prev) => ({ ...prev, [field.id]: false }));
    }
  }

  async function onRemoveFieldStorage(field: ConsentFormCustomerField) {
    const mapping = fieldStorage[field.id];
    if (!mapping) return;
    setFieldStorageBusy((prev) => ({ ...prev, [field.id]: true }));
    setFieldStorageError(null);
    try {
      await removeAdditionalStorageMapping(mapping);
      setFieldStorage((prev) => ({ ...prev, [field.id]: null }));
      showToast(`Additional storage removed for "${field.label}".`);
    } catch (err) {
      setFieldStorageError(err instanceof ApiError ? err.message : 'Could not remove the additional storage mapping.');
    } finally {
      setFieldStorageBusy((prev) => ({ ...prev, [field.id]: false }));
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
        Build your consent form in one place: a Notice, the fields you want to collect, and the consent
        items your customer agrees to. Toggle the form on to make it live on your website embed and its
        hosted link.
      </p>

      {error && <div className="error">{error}</div>}

      {/* ================= 1. NOTICE / TERMS ================= */}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Notice / Terms</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Shown once, at the top of your form. This is your own content — write it however you want; DPDP
          never generates or edits it for you.
        </p>
        <label htmlFor="form-notice">Notice / Terms &amp; Conditions text (optional)</label>
        <textarea
          id="form-notice"
          rows={5}
          value={formNoticeText}
          onChange={(e) => setFormNoticeText(e.target.value)}
          placeholder="e.g. By submitting this form, I agree to the collection and processing of my personal data for the purposes described below."
          disabled={busy || !canManage}
        />
        {canManage && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => void onSaveNotice()} disabled={busy || formNoticeText === (form.noticeText ?? '')}>
              Save notice
            </button>
          </div>
        )}
      </div>

      {/* ================= 2. FORM FIELDS ================= */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Form Fields</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Create the information you want to collect from the customer. Every field&apos;s value is always
          stored in <strong>Central DPDP Storage</strong>; you can optionally connect an additional local
          folder for any one field — one field&apos;s choice never becomes another&apos;s.
        </p>
        {fieldStorageError && <div className="error">{fieldStorageError}</div>}

        {form.customerFields.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {form.customerFields.map((f) => {
              const mapping = fieldStorage[f.id];
              const isBusy = !!fieldStorageBusy[f.id];
              return (
                <div key={f.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <strong>{f.label}</strong>
                        <span className="badge neutral">{f.fieldType}</span>
                        {f.required && <span className="badge warning">required</span>}
                        {f.isIdentifier && <span className="badge info">Customer Identifier</span>}
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="badge success">✓ Central DPDP Storage</span>
                        {!fieldStorageLoaded ? (
                          <span className="muted" style={{ fontSize: '0.8rem' }}>Loading storage…</span>
                        ) : mapping ? (
                          <span className="badge success">Additional storage connected</span>
                        ) : (
                          <span className="badge neutral">No additional storage</span>
                        )}
                        {canManage && fieldStorageLoaded && (
                          <>
                            <button type="button" disabled={isBusy} onClick={() => void onConnectFieldStorage(f)} style={{ fontSize: '0.78rem' }}>
                              {isBusy ? 'Working…' : mapping ? 'Change Folder' : 'Browse Folder'}
                            </button>
                            {mapping && (
                              <button type="button" disabled={isBusy} onClick={() => void onRemoveFieldStorage(f)} style={{ fontSize: '0.78rem' }}>
                                Remove
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {canManage && (
                      <button type="button" disabled={busy} onClick={() => void onRemoveCustomerField(f)}>Remove field</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {form.customerFields.length === 0 && <p className="muted">No fields yet — add your first below.</p>}

        {canManage && (
          <div style={{ marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>+ Add Field</h3>

            <label htmlFor="cf-preset">Quick add (optional)</label>
            <select id="cf-preset" onChange={(e) => onPickPreset(e.target.value)} disabled={busy} defaultValue="">
              <option value="">Custom field…</option>
              {FIELD_LABEL_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>

            <label htmlFor="cf-label">Field Name</label>
            <input id="cf-label" value={cfLabel} onChange={(e) => setCfLabel(e.target.value)} placeholder="e.g. Aadhaar Number" disabled={busy} />

            <label htmlFor="cf-type">Field Type</label>
            <select id="cf-type" value={cfType} onChange={(e) => setCfType(e.target.value as ConsentFormFieldType)} disabled={busy}>
              {CONSENT_FORM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t === 'text' ? 'Text' : t === 'pdf' ? 'PDF' : 'Excel'}</option>
              ))}
            </select>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={cfRequired} onChange={(e) => setCfRequired(e.target.checked)} disabled={busy} />
              Required
            </label>

            {(() => {
              const existingIdentifier = form.customerFields.find((f) => f.isIdentifier);
              return (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, opacity: existingIdentifier ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={cfIsIdentifier}
                    onChange={(e) => setCfIsIdentifier(e.target.checked)}
                    disabled={busy || !!existingIdentifier}
                  />
                  Use as Customer Identifier
                  {existingIdentifier && (
                    <span className="muted" style={{ fontSize: '0.78rem' }}>
                      (&quot;{existingIdentifier.label}&quot; already is — remove it there first to change)
                    </span>
                  )}
                </label>
              );
            })()}
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 0 }}>
              Whatever the customer types/uploads here identifies them to DPDP — reused to recognise a
              repeat submission and to name their Central DPDP Storage folder. At most one field per form;
              none configured means every submission is treated as a new, unrelated customer.
            </p>

            <div style={{ marginTop: 12 }}>
              <button className="primary" type="button" disabled={busy || !cfLabel.trim()} onClick={() => void onAddCustomerField()}>
                {busy ? 'Adding…' : 'Add Field'}
              </button>
            </div>
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
              After adding, configure this field&apos;s optional Additional Storage folder in its row above —
              a field needs to exist before a folder can be linked to it.
            </p>
          </div>
        )}
      </div>

      {/* ================= 3. RETENTION ================= */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Retention</h2>
        <p>
          <span className="badge success">✓ Central DPDP Storage</span>{' '}
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {centralStorage.status === 'connected'
              ? 'Always stored centrally.'
              : 'Always stored centrally — connect a folder on the Storage page to enable local writes on this device.'}
          </span>
        </p>
        <label htmlFor="retention-months">Retention Period (months, optional)</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id="retention-months"
            type="number"
            min={1}
            style={{ maxWidth: 120 }}
            value={retentionMonthsInput}
            onChange={(e) => setRetentionMonthsInput(e.target.value)}
            disabled={busy || !canManage}
          />
          {canManage && (
            <button
              type="button"
              disabled={busy || retentionMonthsInput === (form.retentionMonths != null ? String(form.retentionMonths) : '')}
              onClick={() => void onSaveRetention()}
            >
              Save
            </button>
          )}
        </div>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
          How long this template&apos;s consent data should be retained. Configuration only — DPDP holds no
          file to delete; this is recorded centrally for future retention/expiry review.
        </p>
      </div>

      {/* ================= 4. CONSENT ================= */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Consent</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Each item below becomes a real, versioned consent purpose and notice behind the scenes — you
          never leave this screen. Toggle items on/off; only active items on a live form are shown to the
          public.
        </p>
        {form.rows.length === 0 && <p className="muted">No consent items yet — add your first below.</p>}
        {form.rows.map((row) => (
          <div key={row.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>☐ {row.label}</strong>
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
            <h3 style={{ marginTop: 0 }}>+ Add Consent</h3>
            <label htmlFor="row-label">Consent statement</label>
            <input id="row-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. I consent to Aadhaar verification." disabled={busy} />
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
              <div className="reveal" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
                <label htmlFor="new-el-cat" style={{ marginTop: 0 }}>New element category</label>
                <input id="new-el-cat" value={newElementCategory} onChange={(e) => setNewElementCategory(e.target.value)} placeholder="e.g. Aadhaar Card" disabled={busy} />
                <label htmlFor="new-el-store">Storage location</label>
                <input id="new-el-store" value={newElementStorage} onChange={(e) => setNewElementStorage(e.target.value)} placeholder="e.g. Firm's document server" disabled={busy} />
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <button className="primary" type="button" disabled={busy || !label.trim() || !noticeText.trim()} onClick={() => void onAddRow()}>
                {busy ? 'Adding…' : 'Add consent item'}
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
