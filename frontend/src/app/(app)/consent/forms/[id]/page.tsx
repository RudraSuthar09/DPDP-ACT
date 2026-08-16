'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  CONSENT_FIELD_DESTINATIONS,
  CONSENT_FIELD_TYPES_WITHOUT_STORAGE,
  CONSENT_FORM_FIELD_TYPES,
  type ConsentFieldDestination,
  type ConsentFormCustomerField,
  type ConsentFormFieldType,
  type DataSource,
  type FieldDescriptor,
} from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../../../lib/api';
import { useAuth } from '../../../../../lib/auth';
import { useToast } from '../../../../../components/Toast';
import { suggestColumnMatch } from '../../../../../lib/field-suggest';
import {
  discoverFields,
  resolveCustomer,
  writeCustomerFields,
  createCustomer,
  CustomerResolutionError,
} from '../../../../../lib/customer-resolution';

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
  consent_record: "Don't store in customer record",
  customer_field: 'Existing/new customer field',
  both: 'Customer record note + a customer field',
};
const NEW_COLUMN_TYPES = ['text', 'integer', 'boolean', 'timestamp', 'date'] as const;

/** Quick-fill presets: convenience only. Choosing one pre-fills the label (and,
 *  for Document Upload/Signature, the field type) — it never selects or
 *  implies a database mapping. The label and type both remain freely editable
 *  afterward, and "Custom Field" leaves the label blank for free typing. */
const FIELD_LABEL_PRESETS: Array<{ label: string; fieldType: ConsentFormFieldType }> = [
  { label: 'Name', fieldType: 'text' },
  { label: 'Mobile Number', fieldType: 'text' },
  { label: 'Email', fieldType: 'text' },
  { label: 'Aadhaar Number', fieldType: 'text' },
  { label: 'PAN Number', fieldType: 'text' },
  { label: 'Address', fieldType: 'text' },
  { label: 'Date of Birth', fieldType: 'date' },
  { label: 'Document Upload', fieldType: 'document_upload' },
  { label: 'Signature', fieldType: 'signature' },
];

const NO_STORAGE_TYPES = new Set<string>(CONSENT_FIELD_TYPES_WITHOUT_STORAGE as readonly string[]);

/** Order-independent set equality for the writable-columns dirty-check. */
function sameColumns(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((c) => setB.has(c));
}

export default function ConsentFormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [form, setForm] = useState<FormDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryOption[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- Notice / Terms ---------------------------------------------------------
  const [formNoticeText, setFormNoticeText] = useState('');

  // Add-consent-item form state
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
  const [fields, setFields] = useState<FieldDescriptor[]>([]);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [fieldsBusy, setFieldsBusy] = useState(false);
  const [identitySelection, setIdentitySelection] = useState('');
  // Phase 3H-1: the CENTRAL customer-write configuration (identity_column's
  // sibling settings) — column NAMES only, never values, defaults closed.
  const [allowCreateSelection, setAllowCreateSelection] = useState(false);
  const [writableColumnsSelection, setWritableColumnsSelection] = useState<string[]>([]);

  // Add-form-field state
  const [cfLabel, setCfLabel] = useState('');
  const [cfType, setCfType] = useState<ConsentFormFieldType>('text');
  const [cfRequired, setCfRequired] = useState(false);
  const [cfDestination, setCfDestination] = useState<ConsentFieldDestination>('consent_record');
  const [cfMappedColumn, setCfMappedColumn] = useState('');
  const [cfCreatingNew, setCfCreatingNew] = useState(false);
  const [cfNewColumnName, setCfNewColumnName] = useState('');
  const [cfNewColumnType, setCfNewColumnType] = useState<(typeof NEW_COLUMN_TYPES)[number]>('text');

  // --- Phase 3H-1: staff-assisted consent flow --------------------------------
  // NOT the anonymous public widget/hosted-link. A staff member, with their own
  // browser connected to the source (a local file they opened, or an Enterprise
  // Gateway session), resolves/writes the customer live and records consent
  // through the existing central ConsentService. The identity value and every
  // field value stay in this browser and go only to the connected source —
  // never to our backend. Only metadata (action names, counts) is logged.
  const [staffIdentityValue, setStaffIdentityValue] = useState('');
  const [staffMatch, setStaffMatch] = useState<'idle' | 'found' | 'not-found'>('idle');
  const [staffCustomerRef, setStaffCustomerRef] = useState<string | null>(null);
  const [staffFieldValues, setStaffFieldValues] = useState<Record<string, string>>({});
  const [staffResolveBusy, setStaffResolveBusy] = useState(false);
  const [staffResolveError, setStaffResolveError] = useState<string | null>(null);
  const [staffNotice, setStaffNotice] = useState<string | null>(null);
  const [staffGrantedRows, setStaffGrantedRows] = useState<Set<string>>(new Set());
  const [staffSubmitBusy, setStaffSubmitBusy] = useState(false);
  const [staffSubmitError, setStaffSubmitError] = useState<string | null>(null);

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
      setFormNoticeText(formRes.noticeText ?? '');
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
            setAllowCreateSelection(s.allowCustomerCreate);
            setWritableColumnsSelection(s.writableColumns);
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
      () =>
        apiFetch(`/consent/forms/${id}`, {
          method: 'PUT',
          body: { name: name.trim(), description: form.description, noticeText: form.noticeText },
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
          body: { name: form.name, description: form.description, noticeText: formNoticeText.trim() || null },
        }),
      'Notice saved.',
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

  // --- Phase 3G-1/3H-1: customer-data source + field mapping ------------------
  //
  // A form is associated with a data source only when explicitly chosen here.
  // Field discovery dispatches through customer-resolution.ts (never through
  // our backend): for a Gateway SQL source it talks to the Gateway directly
  // (reusing the existing 3C/3D session mechanism, no manual address/token
  // entry needed); for a SaaS local Excel/CSV source it reads headers from the
  // already-connected local file. Either way this is structure only — column
  // names/types, never a customer row/value.

  async function onSelectSource(sourceId: string) {
    setFields([]);
    setFieldsError(null);
    await mutate(
      () => apiFetch(`/consent/forms/${id}/source`, { method: 'PATCH', body: { sourceId: sourceId || null } }),
      sourceId ? 'Customer data source linked to this form.' : 'Customer data source association cleared.',
    );
  }

  async function onDiscoverFields() {
    if (!sourceDetail) return;
    setFieldsBusy(true);
    setFieldsError(null);
    setFields([]);
    try {
      setFields(await discoverFields(sourceDetail));
    } catch (err) {
      setFieldsError(err instanceof CustomerResolutionError ? err.message : 'Field discovery failed.');
    } finally {
      setFieldsBusy(false);
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
    }, 'Customer identifier saved.');
  }

  function toggleWritableColumn(name: string) {
    setWritableColumnsSelection((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]));
  }

  async function onSaveCustomerWriteConfig() {
    if (!form?.sourceId) return;
    await mutate(async () => {
      await apiFetch(`/data-sources/${form.sourceId}/customer-write-config`, {
        method: 'PATCH',
        body: { allowCustomerCreate: allowCreateSelection, writableColumns: writableColumnsSelection },
      });
      const s = await apiFetch<DataSource>(`/data-sources/${form.sourceId}`);
      setSourceDetail(s);
    }, 'Customer-write configuration saved.');
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

  /** Quick-fill only: sets the label (and, for the two no-storage types, the
   *  field type) from a preset. Purely a convenience — never touches
   *  destination/mapping, and every field stays freely editable afterward. */
  function onPickPreset(presetLabel: string) {
    const preset = FIELD_LABEL_PRESETS.find((p) => p.label === presetLabel);
    if (!preset) return; // "Custom field…" — leave label as-is for free typing.
    setCfLabel(preset.label);
    onChangeFieldType(preset.fieldType);
  }

  /** Document Upload/Signature have no supported customer-column storage
   *  destination yet (see the discovery report) — switching to one of these
   *  types resets an incompatible destination choice back to consent-only,
   *  matching what the server itself would otherwise reject. */
  function onChangeFieldType(t: ConsentFormFieldType) {
    setCfType(t);
    if (NO_STORAGE_TYPES.has(t) && cfDestination !== 'consent_record') {
      setCfDestination('consent_record');
      setCfMappedColumn('');
      setCfCreatingNew(false);
    }
  }

  async function onAddCustomerField() {
    if (!cfLabel.trim()) {
      setError('A form field needs a label.');
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
      'Form field added.',
    );
    resetCustomerFieldForm();
  }

  async function onRemoveCustomerField(field: ConsentFormCustomerField) {
    if (!window.confirm(`Remove the "${field.label}" field from this form?`)) return;
    await mutate(() => apiFetch(`/consent/forms/${id}/customer-fields/${field.id}`, { method: 'DELETE' }), 'Field removed.');
  }

  // --- Phase 3H-1: staff-assisted consent flow --------------------------------

  const isGatewaySqlSource = !!sourceDetail && ['postgresql', 'mysql', 'sqlserver'].includes(sourceDetail.sourceKind);
  const isLocalFileSource = !!sourceDetail && (sourceDetail.sourceKind === 'excel' || sourceDetail.sourceKind === 'csv');
  const writableMappedFields = form
    ? form.customerFields.filter(
        (f) => (f.destination === 'customer_field' || f.destination === 'both') && f.mappedColumn && sourceDetail?.writableColumns.includes(f.mappedColumn),
      )
    : [];

  /** Best-effort, metadata-only fact — mirrors the existing Gateway browser
   *  page's auditGatewayEvent(). Never blocks the flow if it fails. */
  async function logCustomerEvent(action: string, rowCount?: number) {
    if (!form?.sourceId) return;
    try {
      await apiFetch(`/data-sources/${form.sourceId}/gateway-events`, { method: 'POST', body: { action, rowCount } });
    } catch {
      /* best-effort only */
    }
  }

  async function onStaffResolve() {
    if (!sourceDetail || !staffIdentityValue.trim()) return;
    setStaffResolveBusy(true);
    setStaffResolveError(null);
    setStaffNotice(null);
    setStaffMatch('idle');
    setStaffCustomerRef(null);
    setStaffFieldValues({});
    try {
      const res = await resolveCustomer(sourceDetail, staffIdentityValue.trim());
      setStaffMatch(res.exists ? 'found' : 'not-found');
      setStaffCustomerRef(res.customerRef);
      void logCustomerEvent('gateway.customer.resolved', res.exists ? 1 : 0);
    } catch (err) {
      setStaffResolveError(err instanceof CustomerResolutionError ? err.message : 'Could not resolve this customer.');
    } finally {
      setStaffResolveBusy(false);
    }
  }

  async function onStaffSaveFields() {
    if (!sourceDetail || !staffCustomerRef) return;
    const toSend = Object.fromEntries(Object.entries(staffFieldValues).filter(([, v]) => v.trim().length > 0));
    if (Object.keys(toSend).length === 0) {
      setStaffResolveError('Enter at least one field value to save.');
      return;
    }
    setStaffResolveBusy(true);
    setStaffResolveError(null);
    setStaffNotice(null);
    try {
      await writeCustomerFields(sourceDetail, staffCustomerRef, toSend);
      setStaffNotice('Saved — the mapped fields were updated in the connected source.');
      void logCustomerEvent('gateway.customer.updated');
    } catch (err) {
      setStaffResolveError(err instanceof CustomerResolutionError ? err.message : 'Could not save the mapped fields.');
      void logCustomerEvent('gateway.customer.write_failed');
    } finally {
      setStaffResolveBusy(false);
    }
  }

  async function onStaffCreateCustomer() {
    if (!sourceDetail || !staffIdentityValue.trim()) return;
    const toSend = Object.fromEntries(Object.entries(staffFieldValues).filter(([, v]) => v.trim().length > 0));
    setStaffResolveBusy(true);
    setStaffResolveError(null);
    setStaffNotice(null);
    try {
      const res = await createCustomer(sourceDetail, staffIdentityValue.trim(), toSend);
      setStaffCustomerRef(res.customerRef);
      setStaffMatch('found');
      setStaffNotice(res.created ? 'Customer created in the connected source.' : 'A customer with this identity already existed — using the existing record.');
      void logCustomerEvent('gateway.customer.created');
    } catch (err) {
      setStaffResolveError(
        err instanceof CustomerResolutionError
          ? `${err.message} (creation may be disabled for this source)`
          : 'Could not create the customer.',
      );
    } finally {
      setStaffResolveBusy(false);
    }
  }

  function toggleGrantedRow(rowId: string) {
    setStaffGrantedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  /**
   * Record consent for every checked purpose — through the EXISTING, unchanged
   * POST /consent/events (the same staff-authenticated endpoint that already
   * exists). The central backend receives only customerId/purposeId/status/
   * noticeVersionId — exactly what it already accepts; no field value, no
   * customer row, ever included.
   */
  async function onStaffRecordConsent() {
    if (!staffIdentityValue.trim()) {
      setStaffSubmitError('Enter the identity value first.');
      return;
    }
    if (staffGrantedRows.size === 0) {
      setStaffSubmitError('Select at least one consent item to record.');
      return;
    }
    setStaffSubmitBusy(true);
    setStaffSubmitError(null);
    try {
      for (const rowId of staffGrantedRows) {
        const row = form?.rows.find((r) => r.id === rowId);
        if (!row) continue;
        await apiFetch('/consent/events', {
          method: 'POST',
          body: {
            customerId: staffIdentityValue.trim(),
            purposeId: row.consentPurposeId,
            status: 'GRANTED',
            noticeVersionId: row.noticeVersionId,
            source: 'api',
          },
        });
      }
      const count = staffGrantedRows.size;
      setStaffGrantedRows(new Set());
      setStaffIdentityValue('');
      setStaffMatch('idle');
      setStaffCustomerRef(null);
      setStaffFieldValues({});
      setStaffResolveError(null);
      setStaffNotice(`Consent recorded for ${count} item(s).`);
    } catch (err) {
      setStaffSubmitError(err instanceof ApiError ? err.message : 'Could not record consent.');
    } finally {
      setStaffSubmitBusy(false);
    }
  }

  if (!form) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;

  const hostedLink =
    form.slug && typeof window !== 'undefined' ? `${window.location.origin}/forms/${form.slug}` : null;
  const shareText = encodeURIComponent('Please review and complete this consent form: ');
  const noStorageSelected = NO_STORAGE_TYPES.has(cfType);

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
        Build your consent form in one place: a Notice, the form fields you want to collect, and the
        consent items your customer agrees to. Toggle the form on to make it live on your website embed
        and its hosted link.
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
          The information you collect from the customer — Name, Mobile Number, Aadhaar Number, Document
          Upload, Signature, or anything custom. For each field you explicitly choose where its response
          goes: an existing field in your connected Customer Data Source, a newly created one, or nowhere
          (consent-only).
        </p>

        <label htmlFor="cf-source">Customer Data Source (optional)</label>
        <select
          id="cf-source"
          value={form.sourceId ?? ''}
          onChange={(e) => void onSelectSource(e.target.value)}
          disabled={busy || !canManage}
        >
          <option value="">Not connected — this form won&apos;t store fields in a customer record</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        {!form.sourceId && (
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            No Customer Data Source is linked. You can still add form fields — connect a source above to
            also store responses in your customer record.
          </p>
        )}

        {form.sourceId && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              {sourceDetail && (sourceDetail.sourceKind === 'excel' || sourceDetail.sourceKind === 'csv')
                ? <>Reads the column headers from the connected local file for <strong>{sourceDetail.name}</strong> — open its Data Viewer first if it isn&apos;t connected in this browser yet.</>
                : <>Discovers which fields exist in <strong>{sourceDetail?.name ?? 'this source'}</strong> — structure only, never a customer row.</>}
            </p>
            <button type="button" onClick={() => void onDiscoverFields()} disabled={fieldsBusy}>
              {fieldsBusy ? 'Discovering…' : 'Discover customer fields'}
            </button>
            {fieldsError && <div className="error" style={{ marginTop: 10 }}>{fieldsError}</div>}

            {fields.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <label htmlFor="cf-identity">Customer Identifier</label>
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
                  Which existing customer field identifies a customer (e.g. email, mobile, or your own
                  customer ID) — your explicit choice, never assumed.
                </p>

                {/* Phase 3H-1: the central customer-write configuration. */}
                {sourceDetail && (sourceDetail.sourceKind === 'excel' || sourceDetail.sourceKind === 'csv') ? (
                  <p className="muted" style={{ fontSize: '0.78rem', marginTop: 12 }}>
                    Local Excel/CSV sources are currently read-only — DPDP cannot write customer field
                    values back to this file yet.
                  </p>
                ) : (
                  <div style={{ marginTop: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={allowCreateSelection}
                        onChange={(e) => setAllowCreateSelection(e.target.checked)}
                        disabled={busy}
                      />
                      Allow creating a new customer record when none is found
                    </label>

                    <label style={{ marginTop: 8 }}>Fields DPDP may write</label>
                    <p className="muted" style={{ fontSize: '0.78rem', marginTop: 0 }}>
                      Only fields explicitly checked here may ever be written by DPDP. Nothing is writable
                      until you choose it.
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {fields.map((f) => (
                        <label key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'normal' }}>
                          <input
                            type="checkbox"
                            style={{ width: 'auto' }}
                            checked={writableColumnsSelection.includes(f.name)}
                            onChange={() => toggleWritableColumn(f.name)}
                            disabled={busy}
                          />
                          {f.name}
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      style={{ marginTop: 8 }}
                      onClick={() => void onSaveCustomerWriteConfig()}
                      disabled={
                        busy ||
                        (allowCreateSelection === (sourceDetail?.allowCustomerCreate ?? false) &&
                          sameColumns(writableColumnsSelection, sourceDetail?.writableColumns ?? []))
                      }
                    >
                      Save write configuration
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* existing form fields */}
        {form.customerFields.length > 0 && (
          <div style={{ marginTop: 16 }}>
            {form.customerFields.map((f) => (
              <div key={f.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{f.label}</strong>
                    <span className="badge neutral">{f.fieldType}</span>
                    {f.required && <span className="badge warning">required</span>}
                    {NO_STORAGE_TYPES.has(f.fieldType) ? (
                      <span className="badge warning">Not stored — no supported destination yet</span>
                    ) : (
                      <span className="badge info">→ {DESTINATION_LABEL[f.destination]}</span>
                    )}
                    {f.mappedColumn && <span className="badge success">field: {f.mappedColumn}</span>}
                    {f.newColumnName && <span className="badge success">new field: {f.newColumnName} ({f.newColumnType})</span>}
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
            <h3 style={{ marginTop: 0 }}>+ Add Field</h3>

            <label htmlFor="cf-preset">Quick add (optional)</label>
            <select id="cf-preset" onChange={(e) => onPickPreset(e.target.value)} disabled={busy} defaultValue="">
              <option value="">Custom field…</option>
              {FIELD_LABEL_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>{p.label}</option>
              ))}
            </select>
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 0 }}>
              A convenience only — it just fills in the label (and type) below. It never chooses a
              database mapping for you.
            </p>

            <label htmlFor="cf-label">Field label</label>
            <input id="cf-label" value={cfLabel} onChange={(e) => setCfLabel(e.target.value)} placeholder="e.g. Aadhaar Number" disabled={busy} />

            <label htmlFor="cf-type">Field type</label>
            <select id="cf-type" value={cfType} onChange={(e) => onChangeFieldType(e.target.value as ConsentFormFieldType)} disabled={busy}>
              {CONSENT_FORM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={cfRequired} onChange={(e) => setCfRequired(e.target.checked)} disabled={busy} />
              Required
            </label>

            {noStorageSelected && (
              <div className="notice" style={{ marginTop: 8 }}>
                Document Upload and Signature responses aren&apos;t stored anywhere yet — there is no
                supported storage destination for them in this platform today. This field can still be
                part of your form, but it will be consent-only until a storage option is added in a future
                update.
              </div>
            )}

            <label style={{ marginTop: 8 }}>Where should this response be stored?</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {CONSENT_FIELD_DESTINATIONS.map((d) => {
                const disabledByType = noStorageSelected && d !== 'consent_record';
                return (
                  <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'normal', opacity: disabledByType ? 0.5 : 1 }}>
                    <input
                      type="radio"
                      name="cf-destination"
                      style={{ width: 'auto' }}
                      checked={cfDestination === d}
                      onChange={() => setCfDestination(d)}
                      disabled={busy || disabledByType}
                    />
                    {DESTINATION_LABEL[d]}
                    {disabledByType && <span className="muted" style={{ fontSize: '0.78rem' }}>(not available yet)</span>}
                  </label>
                );
              })}
            </div>

            {cfDestination !== 'consent_record' && (
              <div className="reveal" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
                {!cfCreatingNew ? (
                  <>
                    <label htmlFor="cf-mapped" style={{ marginTop: 0 }}>Existing Customer Field</label>
                    {fields.length === 0 ? (
                      <p className="muted" style={{ fontSize: '0.8rem' }}>
                        Use &quot;Discover customer fields&quot; above to choose an existing field.
                      </p>
                    ) : (
                      <>
                        <select id="cf-mapped" value={cfMappedColumn} onChange={(e) => setCfMappedColumn(e.target.value)} disabled={busy}>
                          <option value="">Select an existing field…</option>
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
                      Create New Customer Field
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="cf-new-name" style={{ marginTop: 0 }}>New field name</label>
                    <input id="cf-new-name" value={cfNewColumnName} onChange={(e) => setCfNewColumnName(e.target.value)} placeholder="e.g. aadhaar_number" disabled={busy} />
                    <label htmlFor="cf-new-type">Data type</label>
                    <select id="cf-new-type" value={cfNewColumnType} onChange={(e) => setCfNewColumnType(e.target.value as typeof cfNewColumnType)} disabled={busy}>
                      {NEW_COLUMN_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <p className="muted" style={{ fontSize: '0.78rem' }}>
                      This only saves the request. Nothing is created in your customer database yet — that
                      is a separate, explicitly-confirmed step. If your connected source doesn&apos;t
                      support creating fields (e.g. a local Excel/CSV file), you&apos;ll need to add the
                      field externally and then discover fields again.
                    </p>
                    <button type="button" style={{ marginTop: 8 }} onClick={() => setCfCreatingNew(false)} disabled={busy}>
                      Use an existing field instead
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

        {/* --- Phase 3H-1: staff-assisted consent (NOT the public widget/link) --- */}
        {form.sourceId && canManage && (
          <div style={{ marginTop: 16, borderTop: '2px solid var(--border)', paddingTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Staff-assisted consent</h3>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              For when a staff member records consent WITH the customer present (in person or on a call) —
              not the public website/hosted-link flow below, which is unchanged and still records consent
              items only. This uses <strong>your own</strong> connected browser session to resolve/update
              the customer in <strong>{sourceDetail?.name ?? 'the connected source'}</strong>; the identity
              value and any field value go only to that source — never to DPDP&apos;s servers.
            </p>

            <label htmlFor="staff-identity">
              Identity value{sourceDetail?.identityColumn ? ` (${sourceDetail.identityColumn})` : ''}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id="staff-identity"
                value={staffIdentityValue}
                onChange={(e) => setStaffIdentityValue(e.target.value)}
                placeholder="e.g. customer@example.com"
                disabled={staffResolveBusy}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                onClick={() => void onStaffResolve()}
                disabled={staffResolveBusy || !staffIdentityValue.trim() || !sourceDetail?.identityColumn}
              >
                {staffResolveBusy ? 'Resolving…' : 'Find customer'}
              </button>
            </div>
            {!sourceDetail?.identityColumn && (
              <p className="muted" style={{ fontSize: '0.78rem' }}>Configure a Customer Identifier above first.</p>
            )}

            {staffMatch === 'found' && <div className="notice" style={{ marginTop: 10 }}>Customer found in the connected source.</div>}
            {staffMatch === 'not-found' && (
              <div className="notice" style={{ marginTop: 10 }}>
                Not found in the connected source.
                {isGatewaySqlSource && sourceDetail?.allowCustomerCreate ? ' You may create it below.' : ''}
              </div>
            )}
            {staffResolveError && <div className="error" style={{ marginTop: 10 }}>{staffResolveError}</div>}
            {staffNotice && <div className="notice" style={{ marginTop: 10 }}>{staffNotice}</div>}

            {isLocalFileSource && staffMatch !== 'idle' && (
              <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
                Local Excel/CSV sources are currently read-only — DPDP cannot update or create records in
                this file yet.
              </p>
            )}

            {isGatewaySqlSource && staffMatch === 'found' && writableMappedFields.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <p className="muted" style={{ fontSize: '0.8rem' }}>Update mapped, writable fields:</p>
                {writableMappedFields.map((f) => (
                  <div key={f.id} style={{ marginBottom: 8 }}>
                    <label htmlFor={`staff-field-${f.id}`}>{f.label} <span className="muted">({f.mappedColumn})</span></label>
                    <input
                      id={`staff-field-${f.id}`}
                      value={staffFieldValues[f.mappedColumn!] ?? ''}
                      onChange={(e) => setStaffFieldValues((prev) => ({ ...prev, [f.mappedColumn!]: e.target.value }))}
                      disabled={staffResolveBusy}
                    />
                  </div>
                ))}
                <button type="button" onClick={() => void onStaffSaveFields()} disabled={staffResolveBusy}>Save fields</button>
              </div>
            )}

            {isGatewaySqlSource && staffMatch === 'not-found' && sourceDetail?.allowCustomerCreate && writableMappedFields.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <p className="muted" style={{ fontSize: '0.8rem' }}>Enter values to create this customer:</p>
                {writableMappedFields.map((f) => (
                  <div key={f.id} style={{ marginBottom: 8 }}>
                    <label htmlFor={`staff-newfield-${f.id}`}>{f.label} <span className="muted">({f.mappedColumn})</span></label>
                    <input
                      id={`staff-newfield-${f.id}`}
                      value={staffFieldValues[f.mappedColumn!] ?? ''}
                      onChange={(e) => setStaffFieldValues((prev) => ({ ...prev, [f.mappedColumn!]: e.target.value }))}
                      disabled={staffResolveBusy}
                    />
                  </div>
                ))}
                <button type="button" onClick={() => void onStaffCreateCustomer()} disabled={staffResolveBusy}>Create customer</button>
              </div>
            )}
            {isGatewaySqlSource && staffMatch === 'not-found' && !sourceDetail?.allowCustomerCreate && (
              <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
                Customer creation is disabled for this source — enable it above if this should be allowed.
              </p>
            )}

            <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <p className="muted" style={{ fontSize: '0.8rem' }}>Record consent for:</p>
              {form.rows.filter((r) => r.active).length === 0 && (
                <p className="muted" style={{ fontSize: '0.8rem' }}>No active consent items on this form yet.</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {form.rows.filter((r) => r.active).map((row) => (
                  <label key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'normal' }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={staffGrantedRows.has(row.id)}
                      onChange={() => toggleGrantedRow(row.id)}
                      disabled={staffSubmitBusy}
                    />
                    {row.label}
                  </label>
                ))}
              </div>
              {staffSubmitError && <div className="error" style={{ marginTop: 10 }}>{staffSubmitError}</div>}
              <button
                className="primary"
                type="button"
                style={{ marginTop: 10 }}
                onClick={() => void onStaffRecordConsent()}
                disabled={staffSubmitBusy || !staffIdentityValue.trim() || staffGrantedRows.size === 0}
              >
                {staffSubmitBusy ? 'Recording…' : 'Record consent'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ================= 3. CONSENT ================= */}
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
