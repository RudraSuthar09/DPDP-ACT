'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONSENT_FORM_FIELD_TYPES,
  describeUploadKind,
  type ConsentFormFileKind,
  type ConsentDeliveryState,
  type ConsentFormCustomerField,
  type ConsentFormFieldType,
  type StorageFolder,
  type StorageMapping,
  type StorageRoot,
} from '@dpdp/shared';
import { apiFetch, ApiError, downloadFile, fetchBlob } from '../../../../../lib/api';
import {
  GatewayStorageSessionError,
  openGatewayStorageSession,
  writeStorageFile,
} from '../../../../../lib/gateway-storage-session';
import { useAuth } from '../../../../../lib/auth';
import { useCapabilities } from '../../../../../lib/capabilities';
import { describeDestination, gatewayStorageRoots } from '../../../../../lib/gateway-destinations';
import { classifyGatewayConnection } from '../../../../../lib/gateway-connection';
import { DestinationPicker, type ChosenDestination } from '../../../../../components/DestinationPicker';
import { useToast } from '../../../../../components/Toast';
import { useDialog } from '../../../../../components/Dialog';
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
  /** Storage writes only — the answers above are already recorded either way. */
  deliveryState: ConsentDeliveryState;
  deliveryAttempts: number;
  /** Per destination, outcomes/counts only — never where. */
  centralDelivery?: 'stored' | 'pending' | 'failed' | 'partial' | 'not_configured';
  enterpriseCopies?: { total: number; stored: number; failed: number };
}

const CENTRAL_TEXT: Record<NonNullable<Submission['centralDelivery']>, string> = {
  stored: 'stored',
  pending: 'pending',
  failed: 'failed',
  partial: 'partly stored',
  not_configured: 'not configured',
};

/** " Central DPDP Storage: stored. Enterprise copies: 1 of 2 stored." —
 *  appended to the status tooltip, so the two destinations are told apart. */
function destinationSummary(s: Submission): string {
  const central = s.centralDelivery ? ` Central DPDP Storage: ${CENTRAL_TEXT[s.centralDelivery]}.` : '';
  const e = s.enterpriseCopies;
  if (!e || e.total === 0) return central;
  return `${central} Enterprise copies: ${e.stored} of ${e.total} stored${e.failed ? `, ${e.failed} failed` : ''}.`;
}

/** Storage status badge for one submission. Wording keeps the consent
 *  (always recorded) separate from where its data has been written. */
function deliveryBadge(s: Submission): { className: string; label: string; title: string } {
  switch (s.deliveryState) {
    case 'delivered':
      return { className: 'badge success', label: 'Stored', title: 'The submitted data was written to its storage destination.' };
    case 'partially_delivered':
      return {
        className: 'badge warning',
        label: 'Partly stored',
        title: 'Some storage destinations were written, but at least one failed after repeated attempts. The consent itself is recorded.',
      };
    case 'failed':
      return {
        className: 'badge denied',
        label: 'Storage failed',
        title: 'Writing this submission to storage failed after repeated attempts. The consent itself is recorded.',
      };
    default:
      return s.deliveryAttempts > 0
        ? { className: 'badge warning', label: `Retrying (${s.deliveryAttempts})`, title: 'A storage write failed and will be retried automatically.' }
        : { className: 'badge info', label: 'Pending', title: 'Waiting for connected storage or the DPDP Gateway to write this submission.' };
  }
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
const INVENTORY_NEW = '__new__';

/** Quick-fill presets: convenience only. Choosing one pre-fills the label
 *  and field type — it never selects or implies a storage location. The
 *  label and type both remain freely editable afterward, and "Custom
 *  field…" leaves the label blank for free typing. */
/** Plain words for each field type. The two legacy upload types are named as
 *  such so a form owner reaches for "File upload" on anything new. */
const FIELD_TYPE_LABEL: Record<ConsentFormFieldType, string> = {
  text: 'Text',
  file: 'File upload (photo or PDF)',
  pdf: 'PDF (older type)',
  excel: 'Excel (older type)',
};

/** Offered caps, in MB. Bounded by UPLOAD_MAX_BYTES_CEILING, which the
 *  backend and the table's own CHECK both enforce independently. */
const UPLOAD_SIZE_CHOICES_MB = [2, 5, 10, 15, 25];

interface ExportDestination {
  storageRootId: string | null;
  destinationName: string | null;
  /** False when the chosen folder has been removed or is no longer writable —
   *  shown as such rather than quietly becoming download-only. */
  available: boolean;
}

/** Mirrors the server's own exportFilename, so the name the customer sees
 *  when downloading matches the one written into their folder. The server's
 *  version is authoritative for the Content-Disposition header. */
function exportFilenameFor(formName: string): string {
  const stem = formName
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 60);
  return `${stem || 'consent-form'} submissions ${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the spreadsheet.'));
    reader.readAsDataURL(blob);
  });
}

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
  { label: 'Photo', fieldType: 'file' },
  { label: 'Passport Photo', fieldType: 'file' },
];

export default function ConsentFormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);
  const { capabilities } = useCapabilities();
  const hasGateway = capabilities?.features.enterpriseGateway ?? false;

  // Enterprise (Gateway) destinations for a field's Additional Storage: the
  // tenant's Gateway storage locations and their DPDP folder records.
  const [gwRoots, setGwRoots] = useState<StorageRoot[]>([]);
  const [gwFolders, setGwFolders] = useState<StorageFolder[]>([]);
  /** Gateway locations the organisation has removed. A field still pointing
   *  into one has NO usable destination and must be repointed by hand —
   *  DPDP never picks a different folder on someone's behalf. */
  const [removedRootIds, setRemovedRootIds] = useState<string[]>([]);
  /** The field whose destination picker is open, if any. */
  const [pickerField, setPickerField] = useState<ConsentFormCustomerField | null>(null);
  const [gatewayOnline, setGatewayOnline] = useState<boolean | undefined>(undefined);

  const [form, setForm] = useState<FormDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryOption[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();
  const { confirm, promptText } = useDialog();

  // --- Notice / Terms ---------------------------------------------------------
  const [formNoticeText, setFormNoticeText] = useState('');

  // --- Retention ---------------------------------------------------------------
  const [retentionMonthsInput, setRetentionMonthsInput] = useState('');

  // --- Central DPDP Storage status (read-only display) --------------------------
  const [centralStorage, setCentralStorage] = useState<CentralStorageState>({
    status: 'checking',
    root: null,
    handle: null,
    fs: null,
    displayName: null,
  });

  // --- Form Fields: a simple, Google-Forms-like list + per-field Additional
  //     Storage (moduleKey 'consent_form_field', entityId = the field's own id) ---
  const [cfLabel, setCfLabel] = useState('');
  const [cfType, setCfType] = useState<ConsentFormFieldType>('text');
  const [cfRequired, setCfRequired] = useState(false);
  const [cfIsIdentifier, setCfIsIdentifier] = useState(false);
  const [cfIsCustomerName, setCfIsCustomerName] = useState(false);
  const [cfDescription, setCfDescription] = useState('');
  const [cfFileKinds, setCfFileKinds] = useState<ConsentFormFileKind>('image_pdf');
  const [cfMaxMb, setCfMaxMb] = useState(10);
  const [exportDestination, setExportDestination] = useState<ExportDestination | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
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

  /** Best-effort: without it, a field simply cannot be pointed at a Gateway
   *  folder from here; nothing else on the page depends on it. Also reads the
   *  Gateway's own online state, so an unavailable destination is labelled
   *  rather than silently offered. */
  /** Where this form's spreadsheet goes — a NAME and whether it is usable
   *  right now, never an id the customer has to see. */
  const loadExportDestination = useCallback(async () => {
    try {
      setExportDestination(
        await apiFetch<ExportDestination>(`/consent/forms/${id}/submissions/export-destination`),
      );
    } catch {
      // Best-effort, exactly like loadGatewayDestinations: without it the
      // export is download-only, and nothing else on the page depends on it.
      setExportDestination(null);
    }
  }, [id]);

  const loadGatewayDestinations = useCallback(async () => {
    try {
      // includeTombstoned, so a destination whose folder the organisation has
      // REMOVED can still be recognised below and labelled as gone. Without
      // it the mapping simply fails to resolve and the field would claim its
      // additional storage is connected when nothing can be written there.
      const allRoots = (await apiFetch<{ roots: StorageRoot[] }>('/storage/roots?includeTombstoned=true')).roots;
      const gwAll = gatewayStorageRoots(allRoots);
      const roots = gwAll.filter((r) => r.status === 'active');
      const folders = await Promise.all(
        gwAll.map((r) =>
          apiFetch<{ folders: StorageFolder[] }>(`/storage/roots/${r.id}/folders`)
            .then((x) => x.folders)
            .catch(() => [] as StorageFolder[]),
        ),
      );
      setGwRoots(roots);
      setRemovedRootIds(gwAll.filter((r) => r.status !== 'active').map((r) => r.id));
      setGwFolders(folders.flat());
      if (roots.length > 0) {
        const { device } = await apiFetch<{ device: { status: string; endpoint: string | null; lastHeartbeatAt: string | null } | null }>(
          '/gateway/devices/active',
        ).catch(() => ({ device: null }));
        setGatewayOnline(device ? classifyGatewayConnection(device, null) === 'connected' : false);
      }
    } catch {
      setGwRoots([]);
      setGwFolders([]);
      setRemovedRootIds([]);
    }
  }, []);

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
      void loadGatewayDestinations();
      void loadExportDestination();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this form.');
    }
  }, [id, loadGatewayDestinations, loadExportDestination]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRename() {
    if (!form) return;
    const name = await promptText({ title: 'Rename form', label: 'Form name', initialValue: form.name, required: true, confirmLabel: 'Rename' });
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
    if (!(await confirm({ message: `Remove the "${row.label}" consent item from this form?`, confirmLabel: 'Remove', danger: true }))) return;
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
          body: {
            label: cfLabel.trim(),
            fieldType: cfType,
            required: cfRequired,
            isIdentifier: cfIsIdentifier,
            isCustomerName: cfIsCustomerName,
            description: cfDescription.trim() || null,
            // Sent ONLY for a file field: the backend refuses this
            // configuration on any other type rather than ignoring it.
            ...(cfType === 'file'
              ? { allowedFileKinds: cfFileKinds, maxFileBytes: cfMaxMb * 1024 * 1024 }
              : {}),
          },
        }),
      'Field added.',
    );
    setCfLabel('');
    setCfType('text');
    setCfRequired(false);
    setCfIsIdentifier(false);
    setCfIsCustomerName(false);
  }

  async function onRemoveCustomerField(field: ConsentFormCustomerField) {
    if (!(await confirm({ message: `Remove the "${field.label}" field from this form?`, confirmLabel: 'Remove', danger: true }))) return;
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

  /** Points a field's Additional Storage at a folder of a Gateway storage
   *  location: reuses that folder's DPDP record if it exists, else creates
   *  it, then sets the field's EXISTING mapping (one folder per field). The
   *  real folder is created by the Gateway on first delivery, inside the
   *  location its administrator authorized — DPDP never writes it here. */
  /**
   * Applies what the picker returned, reusing the EXISTING per-field mapping
   * (storage_mappings, moduleKey 'consent_form_field') — no new model and no
   * new identifier. 'central' removes any extra mapping (Central alone is
   * still always written); a folder id maps the field to that folder, which
   * the picker has already mirrored into storage_folders.
   */
  async function onDestinationChosen(field: ConsentFormCustomerField, chosen: ChosenDestination) {
    setPickerField(null);
    if (chosen.kind === 'central') {
      if (fieldStorage[field.id]) await onRemoveFieldStorage(field);
      else showToast(`"${field.label}" is stored in Central DPDP Storage only.`);
      return;
    }
    setFieldStorageBusy((prev) => ({ ...prev, [field.id]: true }));
    setFieldStorageError(null);
    try {
      await apiFetch('/storage/mappings', {
        method: 'PUT',
        body: { moduleKey: 'consent_form_field', entityId: field.id, folderId: chosen.folderId },
      });
      const mapping = await getAdditionalStorageMapping('consent_form_field', field.id);
      setFieldStorage((prev) => ({ ...prev, [field.id]: mapping }));
      await loadGatewayDestinations();
      showToast(`"${field.label}" will also be copied to ${chosen.label}.`);
    } catch (err) {
      setFieldStorageError(err instanceof ApiError ? err.message : 'Could not save this destination.');
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

  // --- submissions export ----------------------------------------------------

  /**
   * Downloads the spreadsheet. POST because the route is audited — taking a
   * copy of a submissions register is recorded, like every other export in
   * this product.
   */
  async function onDownloadExport(): Promise<void> {
    setExportBusy(true);
    setExportNotice(null);
    setExportError(null);
    try {
      await downloadFile(`/consent/forms/${id}/submissions/export`, exportFilenameFor(form!.name), {
        method: 'POST',
      });
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Could not prepare the spreadsheet.');
    } finally {
      setExportBusy(false);
    }
  }

  /**
   * Saves a copy into the chosen authorized folder, through the Gateway's own
   * storage plane.
   *
   * Three things it deliberately does NOT do: it does not overwrite (the
   * filename carries today's date, and the write is sent with overwrite
   * false, so the Gateway refuses rather than replacing an existing file); it
   * does not claim success when the Gateway is unreachable (opening the
   * session fails first, and that failure is what gets reported); and it does
   * not fall back to a different folder.
   */
  async function onSaveExportToFolder(): Promise<void> {
    const rootId = exportDestination?.storageRootId;
    if (!rootId) return;
    setExportBusy(true);
    setExportNotice(null);
    setExportError(null);
    try {
      // Generated fresh, from the current records — never a cached copy.
      const blob = await fetchBlob(`/consent/forms/${id}/submissions/export`);
      const filename = exportFilenameFor(form!.name);
      const session = await openGatewayStorageSession(rootId);
      await writeStorageFile(session, {
        path: [],
        filename,
        contentBase64: await blobToBase64(blob),
      });
      setExportNotice(`Saved "${filename}" to ${exportDestination?.destinationName ?? 'your folder'}.`);
    } catch (err) {
      setExportError(
        err instanceof GatewayStorageSessionError || err instanceof ApiError
          ? err.message
          : 'Could not save the spreadsheet to that folder.',
      );
    } finally {
      setExportBusy(false);
    }
  }

  async function onSetExportDestination(storageRootId: string | null): Promise<void> {
    setExportBusy(true);
    setExportNotice(null);
    setExportError(null);
    try {
      await apiFetch(`/consent/forms/${id}/submissions/export-destination`, {
        method: 'PUT',
        body: { storageRootId },
      });
      await loadExportDestination();
      setExportNotice(storageRootId ? 'Spreadsheet folder saved.' : 'The spreadsheet is download-only now.');
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : 'Could not save that folder.');
    } finally {
      setExportBusy(false);
    }
  }

  if (!form) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;

  const hostedLink =
    form.slug && typeof window !== 'undefined' ? `${window.location.origin}/forms/${form.slug}` : null;
  const shareText = encodeURIComponent('Please review and complete this consent form: ');
  /** A form with no consent item on it has nothing to ask, so the public page
   *  refuses to open it even while the form is switched on. Say so here rather
   *  than letting the owner share a link that looks live and is not. */
  const activeRowCount = form.rows.filter((r) => r.active).length;
  const liveButEmpty = form.isActive && activeRowCount === 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{form.name}</h1>
        <span className={`badge ${liveButEmpty ? 'warning' : form.isActive ? 'success' : 'neutral'}`}>
          {liveButEmpty ? 'Unfinished' : form.isActive ? 'Live' : 'Off'}
        </span>
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
          Create the information you want to collect from the customer. Every field&apos;s value is always stored in{' '}
          <strong>Central DPDP Storage</strong>; each field can additionally be copied to one connected location — one
          field&apos;s choice never becomes another&apos;s.
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
                        {f.isCustomerName && <span className="badge info">Customer Name</span>}
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="badge success">✓ Central DPDP Storage</span>
                        {!fieldStorageLoaded ? (
                          <span className="muted" style={{ fontSize: '0.8rem' }}>Loading storage…</span>
                        ) : mapping ? (
                          (() => {
                            const gwFolder = gwFolders.find((x) => x.id === mapping.folderId);
                            const gwRoot = gwFolder && gwRoots.find((r) => r.id === gwFolder.storageRootId);
                            if (gwFolder && removedRootIds.includes(gwFolder.storageRootId)) {
                              return (
                                <span className="badge error" title="The folder this field was saving into has been removed. Choose another one; nothing is being saved there in the meantime.">
                                  Destination removed — choose another
                                </span>
                              );
                            }
                            return gwFolder && gwRoot ? (
                              <span className="badge success" title="Copied by the DPDP Gateway into a folder its administrator authorized for writing.">
                                Enterprise copy → {describeDestination(gwRoot, gwFolder)}
                              </span>
                            ) : (
                              <span className="badge success">Additional storage connected</span>
                            );
                          })()
                        ) : (
                          <span className="badge neutral">No additional storage</span>
                        )}
                        {canManage && fieldStorageLoaded && (
                          <button type="button" disabled={isBusy} onClick={() => setPickerField(f)} style={{ fontSize: '0.78rem' }}>
                            {isBusy ? 'Working…' : mapping ? 'Change destination' : 'Choose destination'}
                          </button>
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

        {pickerField && (
          <DestinationPicker
            fieldLabel={pickerField.label}
            locations={gwRoots}
            gatewayOnline={gatewayOnline}
            onCancel={() => setPickerField(null)}
            onChosen={(d) => void onDestinationChosen(pickerField, d)}
          />
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

            <label htmlFor="cf-label">Field Name</label>
            <input id="cf-label" value={cfLabel} onChange={(e) => setCfLabel(e.target.value)} placeholder="e.g. Aadhaar Number" disabled={busy} />

            <label htmlFor="cf-type">Field Type</label>
            <select id="cf-type" value={cfType} onChange={(e) => setCfType(e.target.value as ConsentFormFieldType)} disabled={busy}>
              {CONSENT_FORM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>
              ))}
            </select>

            {/* Only a File upload field has anything more to configure. */}
            {cfType === 'file' && (
              <div className="reveal" style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--accent-soft-border)' }}>
                <label htmlFor="cf-kinds">What can they upload?</label>
                <select
                  id="cf-kinds"
                  value={cfFileKinds}
                  onChange={(e) => setCfFileKinds(e.target.value as ConsentFormFileKind)}
                  disabled={busy}
                >
                  <option value="image_pdf">Photos or PDF</option>
                  <option value="image">Photos only</option>
                  <option value="pdf">PDF only</option>
                </select>
                <p className="muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>
                  {describeUploadKind(cfFileKinds)}. DPDP checks the file itself, not its name — a renamed
                  program or any other file type is refused.
                </p>

                <label htmlFor="cf-max-mb">Largest file allowed</label>
                <select id="cf-max-mb" value={cfMaxMb} onChange={(e) => setCfMaxMb(Number(e.target.value))} disabled={busy}>
                  {UPLOAD_SIZE_CHOICES_MB.map((mb) => (
                    <option key={mb} value={mb}>{mb} MB</option>
                  ))}
                </select>

                <label htmlFor="cf-description">Instructions for the customer (optional)</label>
                <input
                  id="cf-description"
                  value={cfDescription}
                  onChange={(e) => setCfDescription(e.target.value)}
                  placeholder="e.g. Both sides of the card, in one file"
                  disabled={busy}
                />
              </div>
            )}

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
              repeat submission. At most one field per form; none configured means every submission is
              treated as a new, unrelated customer.
            </p>

            {(() => {
              const existingCustomerName = form.customerFields.find((f) => f.isCustomerName);
              return (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, opacity: existingCustomerName ? 0.5 : 1 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={cfIsCustomerName}
                    onChange={(e) => setCfIsCustomerName(e.target.checked)}
                    disabled={busy || !!existingCustomerName}
                  />
                  Use as Customer Name
                  {existingCustomerName && (
                    <span className="muted" style={{ fontSize: '0.78rem' }}>
                      (&quot;{existingCustomerName.label}&quot; already is — remove it there first to change)
                    </span>
                  )}
                </label>
              );
            })()}
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: 0 }}>
              Names the customer&apos;s folder in Central DPDP Storage (e.g. &quot;Rudra Suthar&quot;) —
              separate from the Customer Identifier above; it can be the same field or a different one. At
              most one field per form; none configured falls back to an internal id-based folder name.
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
        {liveButEmpty && (
          <div className="notice">
            This form has no consent item turned on yet, so the link will not open for your
            customers. Add at least one consent item above, then share the link.
          </div>
        )}
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ marginTop: 0, marginBottom: 8 }}>Submissions</h2>
          {canManage && (
            <>
              <button type="button" disabled={exportBusy} onClick={() => void onDownloadExport()}>
                {exportBusy ? 'Preparing…' : 'Download as Excel'}
              </button>
              {exportDestination?.storageRootId && (
                <button type="button" disabled={exportBusy} onClick={() => void onSaveExportToFolder()}>
                  {exportBusy ? 'Saving…' : `Save a copy to ${exportDestination.destinationName ?? 'your folder'}`}
                </button>
              )}
            </>
          )}
        </div>

        {exportNotice && <div className="notice">{exportNotice}</div>}
        {exportError && <div className="error">{exportError}</div>}

        {canManage && (
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
            The spreadsheet lists every submission with its consent answers and any files collected.
            Answers the customer typed are kept in your own folder, not in DPDP, so the spreadsheet
            shows where to find them rather than repeating them.
          </p>
        )}

        {/* Where a copy of the spreadsheet is kept — the SAME picker a field's
            destination uses, so no id is ever typed. */}
        {canManage && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>Spreadsheet folder:</span>
            {exportDestination?.storageRootId ? (
              <span className={`badge ${exportDestination.available ? 'success' : 'error'}`}>
                {exportDestination.available
                  ? exportDestination.destinationName
                  : `${exportDestination.destinationName ?? 'That folder'} — no longer available`}
              </span>
            ) : (
              <span className="badge neutral">Download only</span>
            )}
            {/* The writable locations themselves — the same storage-root model
                a field's destination uses. A location, not a subfolder: the
                spreadsheet is one file kept at the top of the folder, and
                offering a subfolder here would promise placement this does
                not implement. Read-only folders cannot appear: gwRoots is
                active gateway-provider roots only, and such a root exists
                only because an administrator granted WRITE. */}
            <select
              value={exportDestination?.storageRootId ?? ''}
              disabled={exportBusy || gwRoots.length === 0}
              onChange={(e) => void onSetExportDestination(e.target.value || null)}
            >
              <option value="">Download only</option>
              {gwRoots.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            {gwRoots.length === 0 && (
              <span className="muted" style={{ fontSize: '0.8rem' }}>
                No folder is connected for saving yet — connect one in Sources &amp; Storage.
              </span>
            )}
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Submitted</th>
                <th>Consent (recorded)</th>
                <th>Storage</th>
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
                  <td>
                    {(() => {
                      const b = deliveryBadge(s);
                      return (
                        <>
                          <span className={b.className} title={b.title + destinationSummary(s)}>
                            {b.label}
                          </span>
                          {(s.enterpriseCopies?.total ?? 0) > 0 && (
                            <div className="muted" style={{ fontSize: '0.75rem', marginTop: 2 }}>
                              {destinationSummary(s).trim()}
                            </div>
                          )}
                        </>

                      );
                    })()}
                  </td>
                </tr>
              ))}
              {submissions.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>No submissions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
