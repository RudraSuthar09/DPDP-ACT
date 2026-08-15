'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  GATEWAY_AUTH_HEADER,
  CONSENT_FIELD_DESTINATIONS,
  type ConsentFieldDestination,
  type ConsentFormCustomerField,
  type DataSource,
  type FieldDescriptor,
  type ResourceHandle,
} from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { useToast } from '../../../../../components/Toast';
import { suggestColumnMatch } from '../../../../../lib/field-suggest';

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
  sourceId: string | null;
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
const DESTINATION_LABEL: Record<ConsentFieldDestination, string> = {
  consent_record: 'Consent Record',
  customer_field: 'Existing/new customer-data field',
  both: 'Consent Record + a customer-data field',
};
const FIELD_TYPES = ['text', 'document_upload', 'checkbox', 'date', 'number'] as const;
const NEW_COLUMN_TYPES = ['text', 'integer', 'boolean', 'timestamp', 'date'] as const;

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
  const { showToast } = useToast();

  // --- Phase 3G-1: customer-data source + field mapping state ---------------
  const [sources, setSources] = useState<DataSource[]>([]);
  const [sourceDetail, setSourceDetail] = useState<DataSource | null>(null);
  const [agentUrl, setAgentUrl] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [resources, setResources] = useState<ResourceHandle[]>([]);
  const [recordsHandle, setRecordsHandle] = useState('');
  const [fields, setFields] = useState<FieldDescriptor[]>([]);
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [gatewayBusy, setGatewayBusy] = useState(false);
  const [identitySelection, setIdentitySelection] = useState('');

  // Add-customer-field form state
  const [cfLabel, setCfLabel] = useState('');
  const [cfType, setCfType] = useState<(typeof FIELD_TYPES)[number]>('text');
  const [cfRequired, setCfRequired] = useState(false);
  const [cfDestination, setCfDestination] = useState<ConsentFieldDestination>('consent_record');
  const [cfMappedColumn, setCfMappedColumn] = useState('');
  const [cfCreatingNew, setCfCreatingNew] = useState(false);
  const [cfNewColumnName, setCfNewColumnName] = useState('');
  const [cfNewColumnType, setCfNewColumnType] = useState<(typeof NEW_COLUMN_TYPES)[number]>('text');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [formRes, invRes, subsRes, sourcesRes] = await Promise.all([
        apiFetch<FormDetail>(`/consent/forms/${id}`),
        apiFetch<{ elements: InventoryOption[] }>('/inventory/register'),
        apiFetch<{ submissions: Submission[] }>(`/consent/forms/${id}/submissions`),
        apiFetch<{ sources: DataSource[] }>('/data-sources'),
      ]);
      setForm(formRes);
      setInventory(invRes.elements.filter((e) => e.status === 'active'));
      setSubmissions(subsRes.submissions);
      // Only Gateway-connected sources are usable for field discovery/mapping —
      // metadata_only sources cannot be read from, so they are not offered here.
      setSources(sourcesRes.sources.filter((s) => s.dataAccessMode === 'gateway_connected'));
      if (formRes.sourceId) {
        apiFetch<DataSource>(`/data-sources/${formRes.sourceId}`)
          .then((s) => {
            setSourceDetail(s);
            setIdentitySelection(s.identityColumn ?? '');
          })
          .catch(() => undefined);
      } else {
        setSourceDetail(null);
      }
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
      () => apiFetch(`/consent/forms/${id}`, { method: 'PUT', body: { name: name.trim(), description: form.description } }),
      'Form renamed.',
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
      showToast('Row added.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the row.');
    } finally {
      setBusy(false);
    }
  }

  async function onToggleRow(row: Row) {
    const activating = !row.active;
    await mutate(
      () => apiFetch(`/consent/forms/${id}/rows/${row.id}/active`, { method: 'PATCH', body: { active: activating } }),
      activating ? 'Row activated.' : 'Row deactivated.',
    );
  }

  async function onRemoveRow(row: Row) {
    if (!window.confirm(`Remove the "${row.label}" row from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/rows/${row.id}`, { method: 'DELETE' }), 'Row removed.');
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

  // --- Phase 3G-1: customer-data source + field mapping ----------------------
  //
  // A form is associated with a data source only when explicitly chosen here.
  // Field discovery/mapping talks to the GATEWAY directly (never through our
  // backend) — the flow mirrors the Gateway browser page: enter the Gateway
  // address + session token obtained from pairing, then discover/read structure
  // only. No customer VALUE is ever fetched or shown on this page.

  async function onSelectSource(sourceId: string) {
    setResources([]);
    setRecordsHandle('');
    setFields([]);
    setGatewayError(null);
    await mutate(
      () => apiFetch(`/consent/forms/${id}/source`, { method: 'PATCH', body: { sourceId: sourceId || null } }),
      sourceId ? 'Data source linked to this form.' : 'Data source association cleared.',
    );
  }

  async function gatewayCall(path: string, body: Record<string, unknown>) {
    const base = agentUrl.trim().replace(/\/+$/, '');
    if (!base) throw new Error('Enter the Gateway address.');
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GATEWAY_AUTH_HEADER]: sessionToken.trim() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error ? `Gateway refused: ${j.error}` : `Gateway error (${res.status}).`);
    }
    return res.json();
  }

  async function onDiscoverResources() {
    if (!form?.sourceId) return;
    setGatewayBusy(true);
    setGatewayError(null);
    try {
      const res = (await gatewayCall('/source/discover', { sourceId: form.sourceId })) as { handles: ResourceHandle[] };
      setResources(res.handles);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : 'Connection/discovery failed.');
    } finally {
      setGatewayBusy(false);
    }
  }

  async function onLoadFields(handle: string) {
    if (!form?.sourceId || !handle) return;
    setRecordsHandle(handle);
    setGatewayBusy(true);
    setGatewayError(null);
    setFields([]);
    try {
      // Structure only — column names/types, never a customer row.
      const res = (await gatewayCall('/source/fields', { sourceId: form.sourceId, handle })) as { fields: FieldDescriptor[] };
      setFields(res.fields);
    } catch (err) {
      setGatewayError(err instanceof Error ? err.message : 'Field discovery failed.');
    } finally {
      setGatewayBusy(false);
    }
  }

  async function onSaveIdentityColumn() {
    if (!form?.sourceId) return;
    await mutate(async () => {
      await apiFetch(`/data-sources/${form.sourceId}/identity-column`, {
        method: 'PATCH',
        body: { identityColumn: identitySelection || null },
      });
      const s = await apiFetch<DataSource>(`/data-sources/${form.sourceId}`);
      setSourceDetail(s);
    }, 'Customer identifier column saved.');
  }

  function resetCustomerFieldForm() {
    setCfLabel('');
    setCfType('text');
    setCfRequired(false);
    setCfDestination('consent_record');
    setCfMappedColumn('');
    setCfCreatingNew(false);
    setCfNewColumnName('');
    setCfNewColumnType('text');
  }

  async function onAddCustomerField() {
    if (!cfLabel.trim()) {
      setError('A customer-data field needs a label.');
      return;
    }
    const usesMapping = cfDestination !== 'consent_record';
    await mutate(
      () =>
        apiFetch(`/consent/forms/${id}/customer-fields`, {
          method: 'POST',
          body: {
            label: cfLabel.trim(),
            fieldType: cfType,
            required: cfRequired,
            destination: cfDestination,
            mappedColumn: usesMapping && !cfCreatingNew && cfMappedColumn ? cfMappedColumn : null,
            newColumnName: usesMapping && cfCreatingNew && cfNewColumnName.trim() ? cfNewColumnName.trim() : null,
            newColumnType: usesMapping && cfCreatingNew && cfNewColumnName.trim() ? cfNewColumnType : null,
          },
        }),
      'Customer-data field added.',
    );
    resetCustomerFieldForm();
  }

  async function onRemoveCustomerField(field: ConsentFormCustomerField) {
    if (!window.confirm(`Remove the "${field.label}" field from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/customer-fields/${field.id}`, { method: 'DELETE' }), 'Field removed.');
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
              <div className="reveal" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
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

      {/* --- Phase 3G-1: customer-data fields --- */}
      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Customer-data fields</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Distinct from the consent questions above: a customer-data field (e.g. &quot;Aadhaar Card&quot;,
          &quot;Phone Number&quot;) can be configured to store its response in an existing column of your
          connected customer database — never assumed, always your explicit choice. This section is
          <strong> configuration only</strong>: no value is stored here, and no database is changed until
          you separately confirm a schema change in a later step.
        </p>

        <label htmlFor="cf-source">Customer data source (optional)</label>
        <select
          id="cf-source"
          value={form.sourceId ?? ''}
          onChange={(e) => void onSelectSource(e.target.value)}
          disabled={busy || !canManage}
        >
          <option value="">Not connected — consent-only form</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        {!form.sourceId && (
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            No data source is linked. This form works exactly as before — consent questions only. Link a
            Gateway-connected data source above to also map fields to existing customer columns.
          </p>
        )}

        {form.sourceId && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Connect to your Enterprise Gateway to discover which columns exist in{' '}
              <strong>{sourceDetail?.name ?? 'this source'}</strong> — this reads structure only (column
              names/types), never a customer row.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 240px' }}>
                <label htmlFor="cf-gw-url">Gateway address</label>
                <input id="cf-gw-url" value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} placeholder="e.g. https://gateway.your-network.example:7071" disabled={gatewayBusy} />
              </div>
              <div style={{ flex: '1 1 240px' }}>
                <label htmlFor="cf-gw-token">Session token</label>
                <input id="cf-gw-token" value={sessionToken} onChange={(e) => setSessionToken(e.target.value)} placeholder="from pairing" disabled={gatewayBusy} />
              </div>
              <button type="button" onClick={() => void onDiscoverResources()} disabled={gatewayBusy || !agentUrl.trim() || !sessionToken.trim()}>
                {gatewayBusy ? 'Working…' : 'Discover'}
              </button>
            </div>
            {gatewayError && <div className="error" style={{ marginTop: 10 }}>{gatewayError}</div>}

            {resources.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="cf-resource">Which resource holds your customer records?</label>
                <select id="cf-resource" value={recordsHandle} onChange={(e) => void onLoadFields(e.target.value)} disabled={gatewayBusy}>
                  <option value="">Select…</option>
                  {resources.map((r) => (
                    <option key={r.handle} value={r.handle}>{r.descriptor.label}</option>
                  ))}
                </select>
              </div>
            )}

            {fields.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="cf-identity">Customer identifier column</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select id="cf-identity" value={identitySelection} onChange={(e) => setIdentitySelection(e.target.value)} disabled={busy} style={{ flex: 1 }}>
                    <option value="">Not configured</option>
                    {fields.map((f) => (
                      <option key={f.name} value={f.name}>{f.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => void onSaveIdentityColumn()} disabled={busy || identitySelection === (sourceDetail?.identityColumn ?? '')}>
                    Save
                  </button>
                </div>
                <p className="muted" style={{ fontSize: '0.78rem' }}>
                  Which existing column identifies a customer (e.g. email, mobile, or your own customer
                  ID) — your explicit choice, never assumed.
                </p>
              </div>
            )}
          </div>
        )}

        {/* existing customer-data fields */}
        {form.customerFields.length > 0 && (
          <div style={{ marginTop: 16 }}>
            {form.customerFields.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{f.label}</strong>
                    <span className="badge neutral">{f.fieldType}</span>
                    {f.required && <span className="badge warning">required</span>}
                    <span className="badge info">→ {DESTINATION_LABEL[f.destination]}</span>
                    {f.mappedColumn && <span className="badge success">column: {f.mappedColumn}</span>}
                    {f.newColumnName && <span className="badge success">new column: {f.newColumnName} ({f.newColumnType})</span>}
                  </div>
                </div>
                {canManage && (
                  <button type="button" disabled={busy} onClick={() => void onRemoveCustomerField(f)}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}

        {canManage && (
          <div style={{ marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Add a customer-data field</h3>
            <label htmlFor="cf-label">Field label</label>
            <input id="cf-label" value={cfLabel} onChange={(e) => setCfLabel(e.target.value)} placeholder="e.g. Aadhaar Card" disabled={busy} />

            <label htmlFor="cf-type">Field type</label>
            <select id="cf-type" value={cfType} onChange={(e) => setCfType(e.target.value as typeof cfType)} disabled={busy}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={cfRequired} onChange={(e) => setCfRequired(e.target.checked)} disabled={busy} />
              Required
            </label>

            <label style={{ marginTop: 8 }}>Store response in</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {CONSENT_FIELD_DESTINATIONS.map((d) => (
                <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'normal' }}>
                  <input
                    type="radio"
                    name="cf-destination"
                    style={{ width: 'auto' }}
                    checked={cfDestination === d}
                    onChange={() => setCfDestination(d)}
                    disabled={busy}
                  />
                  {DESTINATION_LABEL[d]}
                </label>
              ))}
            </div>

            {cfDestination !== 'consent_record' && (
              <div className="reveal" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
                {!cfCreatingNew ? (
                  <>
                    <label htmlFor="cf-mapped" style={{ marginTop: 0 }}>Existing customer field</label>
                    {fields.length === 0 ? (
                      <p className="muted" style={{ fontSize: '0.8rem' }}>
                        Connect to the Gateway above and discover fields to choose an existing column.
                      </p>
                    ) : (
                      <>
                        <select id="cf-mapped" value={cfMappedColumn} onChange={(e) => setCfMappedColumn(e.target.value)} disabled={busy}>
                          <option value="">Select an existing column…</option>
                          {fields.map((f) => (
                            <option key={f.name} value={f.name}>{f.name}</option>
                          ))}
                        </select>
                        {(() => {
                          const suggestion = suggestColumnMatch(cfLabel, fields.map((f) => f.name));
                          return suggestion && suggestion !== cfMappedColumn ? (
                            <p className="muted" style={{ fontSize: '0.8rem' }}>
                              Possible match: <strong>{suggestion}</strong>{' '}
                              <button type="button" onClick={() => setCfMappedColumn(suggestion)} disabled={busy}>
                                Use this field
                              </button>
                            </p>
                          ) : null;
                        })()}
                      </>
                    )}
                    <button type="button" style={{ marginTop: 8 }} onClick={() => setCfCreatingNew(true)} disabled={busy}>
                      + Create new customer field
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="cf-new-name" style={{ marginTop: 0 }}>New column name</label>
                    <input id="cf-new-name" value={cfNewColumnName} onChange={(e) => setCfNewColumnName(e.target.value)} placeholder="e.g. aadhaar_number" disabled={busy} />
                    <label htmlFor="cf-new-type">Data type</label>
                    <select id="cf-new-type" value={cfNewColumnType} onChange={(e) => setCfNewColumnType(e.target.value as typeof cfNewColumnType)} disabled={busy}>
                      {NEW_COLUMN_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <p className="muted" style={{ fontSize: '0.78rem' }}>
                      This only saves the request. No column is created in your database yet — that is a
                      separate, explicitly-confirmed step.
                    </p>
                    <button type="button" style={{ marginTop: 8 }} onClick={() => setCfCreatingNew(false)} disabled={busy}>
                      Use an existing column instead
                    </button>
                  </>
                )}
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <button className="primary" type="button" disabled={busy || !cfLabel.trim()} onClick={() => void onAddCustomerField()}>
                {busy ? 'Adding…' : 'Add field'}
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
