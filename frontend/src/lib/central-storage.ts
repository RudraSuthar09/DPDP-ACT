/**
 * "DPDP Central Storage" — one local folder per tenant, structured as the
 * organisation's centralised DPDP data layer (not "where consent files get
 * dumped"). This is a thin orchestration layer over the EXISTING, unchanged
 * primitives:
 *   - backend `/storage/roots|folders|mappings` (storage.module.ts) — reused
 *     as-is, no backend changes this phase.
 *   - local-storage-handles.ts — IndexedDB persistence of the browser's
 *     granted FileSystemDirectoryHandle, keyed by storage_roots.id.
 *   - local-storage-provider.ts — real folder browse/create/verify + file
 *     write (text, JSON, or raw bytes), operating on an already-connected handle.
 *
 * There is deliberately no new table and no new concept in Postgres beyond
 * finally WIRING UP the `data_principal` storage-mapping key (added two
 * phases ago, unused until now): "the Central root" is the one
 * `storage_roots` row named CENTRAL_STORAGE_ROOT_NAME (the existing unique
 * index already guarantees at most one per tenant), and "a customer's own
 * folder" is a `storage_mappings` row with `moduleKey: 'data_principal'`,
 * `entityId: subjectRef` (opaque, I2) -> a `storage_folders` row under the
 * root's `Customers` folder — exactly the same generic mapping mechanism
 * `consent_form_field` uses for per-field Additional Storage, just a
 * different moduleKey.
 *
 * STRUCTURE (final, per the Central DPDP Storage architecture correction):
 *
 *   DPDP Central Storage/
 *   |-- Customers/
 *   |     `-- <Customer>/
 *   |           |-- Customer Information/{profile.json, retention.json}
 *   |           `-- Consent Register/<Template>/<Field>/<value>
 *   |-- Data Inventory/
 *   |-- Grievances/
 *   |-- DSR/
 *   `-- Breach/
 *
 * Customers are centralised under Customers/ (never a customer folder beside
 * the module folders at the root — see resolveCustomerFolder). The other
 * four module folders are shared, top-level, NOT duplicated per customer —
 * reserved names for a future module to write into directly, not customer-
 * nested (Consent Register is the only module folder that nests under a
 * customer today, since a consent submission is inherently per-customer).
 * All five are seeded once, deterministically, on connect.
 */

import type { StorageFolder, StorageMapping, StorageModuleKey, StorageRoot } from '@dpdp/shared';
import { apiFetch } from './api';
import { ADDITIONAL_STORAGE_ROOT_PREFIX } from './connected-locations';
import {
  getStorageHandle,
  isLocalStorageAdapterSupported,
  queryStorageHandlePermission,
  requestStorageHandlePermission,
  saveStorageHandle,
} from './local-storage-handles';
import {
  browserFsProvider,
  writeLocalRawFile,
  writeLocalTextFile,
  type CentralFsProvider,
} from './local-storage-provider';
import {
  electronFsProvider,
  getEnterpriseStatus,
  isElectronStorageAvailable,
  selectEnterpriseFolder,
  setEnterpriseFolder,
} from './electron-storage';

export const CENTRAL_STORAGE_ROOT_NAME = 'DPDP Central Storage';

/** Individual customer folders live ONLY here — never beside the module
 *  folders at the root (the architecture correction this phase exists for). */
export const CUSTOMERS_FOLDER_NAME = 'Customers';

/** The four SHARED, top-level module folders — reserved names for a future
 *  module's own writer, never customer-nested. Consent Register is
 *  deliberately not here: it nests under each customer instead (see
 *  CONSENT_REGISTER_FOLDER_NAME), since a consent submission is inherently
 *  per-customer already. */
export const TOP_LEVEL_MODULE_FOLDERS: Record<string, string> = {
  data_inventory: 'Data Inventory',
  grievance: 'Grievances',
  dprequest: 'DSR',
  breach: 'Breach',
};

/** Every top-level folder seeded on connect, in a fixed, deterministic order. */
const SEED_FOLDERS = [CUSTOMERS_FOLDER_NAME, ...Object.values(TOP_LEVEL_MODULE_FOLDERS)];

export const CONSENT_REGISTER_FOLDER_NAME = 'Consent Register';
export const CUSTOMER_INFORMATION_FOLDER_NAME = 'Customer Information';

export type CentralStorageStatus = 'checking' | 'unsupported' | 'not_configured' | 'connected' | 'needs_reconnect';

export interface CentralStorageState {
  status: CentralStorageStatus;
  root: StorageRoot | null;
  /** The browser File System Access handle — set only in the SaaS/browser
   *  path, always null in the installed Electron app (which uses `fs` +
   *  `displayName` instead). */
  handle: FileSystemDirectoryHandle | null;
  /** How reads/writes actually reach the filesystem for this connected state:
   *  browserFsProvider(handle) in a browser, electronFsProvider() in the
   *  installed app. Null unless status is 'connected'. Every write path uses
   *  THIS, never `handle` directly — that is the provider seam. */
  fs: CentralFsProvider | null;
  /** Display label for the connected location. In the browser this is the
   *  handle's folder name (no OS path is extractable there); in the installed
   *  Electron app this is the REAL absolute path (e.g. D:\DPDP-Storage). */
  displayName: string | null;
}

const UNSUPPORTED: CentralStorageState = { status: 'unsupported', root: null, handle: null, fs: null, displayName: null };
const NOT_CONFIGURED: CentralStorageState = { status: 'not_configured', root: null, handle: null, fs: null, displayName: null };

/** The tenant's Central DPDP Storage root record, if one has been connected —
 *  identified purely by its reserved name (see the module doc comment). */
export async function findCentralRoot(): Promise<StorageRoot | null> {
  const { roots } = await apiFetch<{ roots: StorageRoot[] }>('/storage/roots');
  return roots.find((r) => r.name === CENTRAL_STORAGE_ROOT_NAME && r.status === 'active') ?? null;
}

/** Full status. In the installed Electron app this reflects the native
 *  Enterprise Storage config + a real availability probe; in a browser it
 *  reflects whether THIS browser still holds a granted handle. Read-only —
 *  never prompts, safe to call automatically. */
export async function getCentralStorageStatus(): Promise<CentralStorageState> {
  if (isElectronStorageAvailable()) return getElectronCentralStorageStatus();
  if (!isLocalStorageAdapterSupported()) return UNSUPPORTED;

  const root = await findCentralRoot();
  if (!root) return NOT_CONFIGURED;

  const record = await getStorageHandle(root.id);
  if (!record) return { status: 'needs_reconnect', root, handle: null, fs: null, displayName: null };

  const permission = await queryStorageHandlePermission(record.handle);
  if (permission !== 'granted') {
    return { status: 'needs_reconnect', root, handle: record.handle, fs: null, displayName: record.handle.name };
  }
  return { status: 'connected', root, handle: record.handle, fs: browserFsProvider(record.handle), displayName: record.handle.name };
}

/** Electron-native status: CONFIGURED (a central root row exists AND this
 *  machine has a persisted rootPath) vs AVAILABLE (the main process can
 *  actually read/write that path right now) are answered separately. */
async function getElectronCentralStorageStatus(): Promise<CentralStorageState> {
  const root = await findCentralRoot();
  const es = await getEnterpriseStatus();
  if (!root || !es.rootPath) {
    return { status: 'not_configured', root: root ?? null, handle: null, fs: null, displayName: es.rootPath };
  }
  if (!es.available) {
    return { status: 'needs_reconnect', root, handle: null, fs: null, displayName: es.rootPath };
  }
  return { status: 'connected', root, handle: null, fs: electronFsProvider(), displayName: es.rootPath };
}

/** Idempotent, additive-only: creates any of the five top-level folders that
 *  don't already exist yet, both on disk and centrally — never deletes or
 *  renames anything already there (a client may have hand-created other
 *  folders during earlier testing; those are left exactly as they are). */
async function ensureTopLevelFolders(rootId: string, fs: CentralFsProvider): Promise<void> {
  const { folders } = await apiFetch<{ folders: StorageFolder[] }>(`/storage/roots/${rootId}/folders`);
  const existingTopLevel = new Set(folders.filter((f) => f.parentFolderId === null).map((f) => f.name));

  for (const name of SEED_FOLDERS) {
    if (!existingTopLevel.has(name)) {
      await apiFetch('/storage/folders', { method: 'POST', body: { storageRootId: rootId, parentFolderId: null, name } });
    }
    // Real disk folder too — createFolder is idempotent in both providers.
    await fs.createFolder([], name);
  }
}

/** MUST be called from a user gesture (a click handler). In the installed
 *  Electron app this opens the NATIVE OS folder picker and persists the real
 *  path; in a browser it opens the File System Access picker and saves the
 *  handle. Either way it creates the central root record on first connect and
 *  ensures the five top-level folders exist — safe to call again later. */
export async function connectCentralStorage(): Promise<CentralStorageState> {
  if (isElectronStorageAvailable()) return connectElectronCentralStorage();
  if (!isLocalStorageAdapterSupported() || !window.showDirectoryPicker) {
    throw new Error('This browser does not support local folder selection (File System Access API).');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

  let root = await findCentralRoot();
  if (!root) {
    root = await apiFetch<StorageRoot>('/storage/roots', {
      method: 'POST',
      body: { name: CENTRAL_STORAGE_ROOT_NAME, provider: 'local' },
    });
  }
  await saveStorageHandle(root.id, handle);
  const fs = browserFsProvider(handle);
  await ensureTopLevelFolders(root.id, fs);
  return { status: 'connected', root, handle, fs, displayName: handle.name };
}

/** The installed-app path: native folder dialog → persist the real absolute
 *  path (validated + write-probed in the Electron main process) → ensure the
 *  logical central root row + the five top-level real folders exist. */
async function connectElectronCentralStorage(): Promise<CentralStorageState> {
  const picked = await selectEnterpriseFolder();
  if (!picked) {
    // User dismissed the native picker — surfaced like the browser's own
    // AbortError so callers (storage/page.tsx) treat it as a silent cancel.
    throw new DOMException('The folder picker was dismissed.', 'AbortError');
  }
  const saved = await setEnterpriseFolder(picked);
  if (!saved.available) {
    throw new Error(saved.reason || 'The selected folder cannot be used for Enterprise Storage.');
  }
  let root = await findCentralRoot();
  if (!root) {
    root = await apiFetch<StorageRoot>('/storage/roots', {
      method: 'POST',
      body: { name: CENTRAL_STORAGE_ROOT_NAME, provider: 'local' },
    });
  }
  const fs = electronFsProvider();
  await ensureTopLevelFolders(root.id, fs);
  return { status: 'connected', root, handle: null, fs, displayName: saved.rootPath };
}

/** Re-establish access for an already-known root. In the installed app this
 *  re-opens the native picker (choosing a replacement folder updates the
 *  persisted config); in a browser it re-requests handle permission. MUST be
 *  called from a user gesture. */
export async function reconnectCentralStorage(state: CentralStorageState): Promise<CentralStorageState> {
  if (isElectronStorageAvailable()) return connectCentralStorage();
  if (!state.root) return connectCentralStorage();
  if (!state.handle) {
    // No handle persisted at all in THIS browser (e.g. a different device) —
    // the only way forward is picking the folder again.
    return connectCentralStorage();
  }
  const permission = await requestStorageHandlePermission(state.handle);
  if (permission !== 'granted') return { ...state, status: 'needs_reconnect' };
  return { ...state, status: 'connected', fs: browserFsProvider(state.handle) };
}

/** Filesystem-safe label — collapses path separators/control characters so a
 *  client-supplied raw name (customer id, template name, field label) can
 *  never escape the intended folder or break on Windows/macOS/Linux. */
export function sanitizeFolderLabel(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[\\/:*?"<>|-]/g, '_')
    .slice(0, 120);
  return cleaned || 'unnamed';
}

// --- generic per-entity storage_mappings helpers (reused by both customer
//     resolution below and per-field Additional Storage) -------------------

/** The current mapping for one entity, or null — wraps the existing generic
 *  GET /storage/mappings. Generic over moduleKey: used for a customer's own
 *  folder (moduleKey 'data_principal', entityId subjectRef) AND for a
 *  field's Additional Storage (moduleKey 'consent_form_field'). */
export async function getAdditionalStorageMapping(moduleKey: StorageModuleKey, entityId: string): Promise<StorageMapping | null> {
  const { mapping } = await apiFetch<{ mapping: StorageMapping | null }>(
    `/storage/mappings?moduleKey=${encodeURIComponent(moduleKey)}&entityId=${encodeURIComponent(entityId)}`,
  );
  return mapping;
}

// --- deferred sync (submissions recorded centrally while this browser had no
//     connected storage, or wasn't the one that submitted them) -----------

/** Local mirror of a GET .../submissions/pending-local-sync row — enough to
 *  file it under Customers/. */
export interface PendingSubmission {
  id: string;
  channel: 'widget' | 'link';
  submittedAt: string;
  subjectRef: string;
  /** The stable INTERNAL customer UUID (data_principals registry) — never
   *  the subjectRef hash. See resolveCustomerFolder below. */
  customerId: string;
  /** The customer's human-readable name (data_principals.display_name), from
   *  whichever field the client marked "Use as Customer Name" — used ONLY
   *  for the filesystem folder name, never for identity. Null if no such
   *  field is configured (falls back to a UUID-derived label). */
  displayName: string | null;
  answers: Array<{ purposeName: string | null; granted: boolean }>;
}

/**
 * The one sync routine — reused by BOTH the automatic "on platform open"
 * trigger ((app)/layout.tsx, so it runs no matter which page a staff member
 * lands on) and the Storage page's manual "Sync now" fallback button. Writes
 * ONLY Customer Information (folder + profile.json + retention.json) — a
 * submission's field VALUES were never sent to this backend at all (I1);
 * they are recoverable here only if THIS SAME browser was the one that
 * originally collected them (already written at submit time by
 * FormIntake.tsx), never from central state. `state` must already be
 * `status: 'connected'`; the caller checks that first (see
 * getCentralStorageStatus, safe to call automatically — no user gesture).
 */
export async function syncPendingSubmissions(
  state: Pick<CentralStorageState, 'fs' | 'root'>,
): Promise<{ synced: number; failed: number }> {
  if (!state.fs || !state.root) return { synced: 0, failed: 0 };
  const fs = state.fs;
  const rootId = state.root.id;

  let synced = 0;
  let failed = 0;
  const { forms } = await apiFetch<{ forms: Array<{ id: string; name: string; retentionMonths: number | null }> }>('/consent/forms');
  for (const form of forms) {
    const { submissions } = await apiFetch<{ submissions: PendingSubmission[] }>(
      `/consent/forms/${form.id}/submissions/pending-local-sync`,
    );
    for (const submission of submissions) {
      try {
        const displayNameHint = submission.displayName?.trim() || `customer-${submission.customerId.slice(0, 8)}`;
        const customer = await resolveCustomerFolder(fs, rootId, submission.customerId, displayNameHint);
        await writeCustomerInformation(
          fs,
          customer.name,
          { customerId: submission.customerId, subjectRef: submission.subjectRef, displayName: submission.displayName, createdAt: submission.submittedAt },
          { templateName: form.name, retentionMonths: form.retentionMonths },
        );
        await apiFetch(`/consent/forms/${form.id}/submissions/${submission.id}/mark-synced`, { method: 'POST' });
        synced += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { synced, failed };
}

/** Resolves which root a folder belongs to (the mapping only carries a
 *  folderId). Small tenant-scale scan across the tenant's own roots. */
export async function findRootForFolder(folderId: string): Promise<{ root: StorageRoot; folder: StorageFolder } | null> {
  const { roots } = await apiFetch<{ roots: StorageRoot[] }>('/storage/roots');
  for (const root of roots) {
    const { folders } = await apiFetch<{ folders: StorageFolder[] }>(`/storage/roots/${root.id}/folders`);
    const folder = folders.find((f) => f.id === folderId);
    if (folder) return { root, folder };
  }
  return null;
}

// --- customer resolution (Customers/<name> reuse-or-create) ----------------

export interface CustomerFolder {
  folderId: string;
  /** The REAL, current folder name on disk/in the DB — reused verbatim on a
   *  repeat submission, even if it was disambiguated on first creation. */
  name: string;
}

/** Resolve-or-create a customer's own folder under Customers/, keyed by the
 *  opaque, INTERNAL `customerId` UUID (never the display name, and never the
 *  64-character `subject_ref` HMAC — that is a different, EXTERNAL,
 *  deterministic identifier; storage_mappings.entity_id is a `uuid` column
 *  and `customerId` is what the backend already resolved subject_ref TO,
 *  via DataPrincipalService.resolveCustomerId — see
 *  ConsentFormsService.submit()). This function never derives or guesses a
 *  customer identity itself; it only ever receives an already-resolved one.
 *
 * 1. Look up storage_mappings(moduleKey='data_principal', entityId=customerId).
 *    Found -> reuse that folder verbatim (same customer submitting again).
 * 2. Not found -> this is either a brand-new customer, or a DIFFERENT
 *    customer who happens to share a display name with someone already
 *    filed under Customers/ — checked by listing existing siblings; on a
 *    real name collision, disambiguate with a short customerId-derived
 *    suffix so two different "Rudra Suthar"s never merge into one folder.
 *    Then create the real folder + the mapping.
 *
 * MUST be called with a connected `fs` provider for `rootId` — this does real
 * disk + real API calls, never a guess. The provider is either the browser's
 * File System Access adapter or the Electron native adapter; the resolution
 * logic here is identical for both. */
export async function resolveCustomerFolder(
  fs: CentralFsProvider,
  rootId: string,
  customerId: string,
  displayNameHint: string,
): Promise<CustomerFolder> {
  const existing = await getAdditionalStorageMapping('data_principal', customerId);
  if (existing) {
    const resolved = await findRootForFolder(existing.folderId);
    if (resolved) return { folderId: existing.folderId, name: resolved.folder.name };
    // The mapping outlived its folder (e.g. manually removed) — fall through
    // and create a fresh one; the mapping PUT below will repoint it.
  }

  const { folders } = await apiFetch<{ folders: StorageFolder[] }>(`/storage/roots/${rootId}/folders`);
  const customersFolder = folders.find((f) => f.parentFolderId === null && f.name === CUSTOMERS_FOLDER_NAME);
  if (!customersFolder) {
    throw new Error(`The "${CUSTOMERS_FOLDER_NAME}" folder is missing — reconnect Central DPDP Storage first.`);
  }
  const siblingNames = new Set(folders.filter((f) => f.parentFolderId === customersFolder.id).map((f) => f.name));

  const baseName = sanitizeFolderLabel(displayNameHint);
  const name = siblingNames.has(baseName) ? `${baseName} (${customerId.slice(0, 6)})` : baseName;

  await fs.createFolder([CUSTOMERS_FOLDER_NAME], name);
  const folder = await apiFetch<StorageFolder>('/storage/folders', {
    method: 'POST',
    body: { storageRootId: rootId, parentFolderId: customersFolder.id, name },
  });
  await apiFetch('/storage/mappings', {
    method: 'PUT',
    body: { moduleKey: 'data_principal', entityId: customerId, folderId: folder.id },
  });
  return { folderId: folder.id, name: folder.name };
}

/** Writes/refreshes a customer's own metadata — never a sensitive field
 *  value, only what the platform legitimately knows about the association
 *  (never invented). Local only; none of this reaches PostgreSQL.
 *
 *  `customerId` is the stable INTERNAL identity (storage_mappings.entity_id).
 *  `subjectRef` is included alongside it purely for cross-reference — the
 *  existing EXTERNAL, deterministic identifier (SubjectRefHasher, I2) every
 *  other consent record (consent_events, consent_form_submissions,
 *  retention_records) already uses; it is not itself an identity this
 *  storage layer resolves anything by. */
export async function writeCustomerInformation(
  fs: CentralFsProvider,
  customerFolderName: string,
  profile: { customerId: string; subjectRef: string; displayName: string | null; createdAt: string },
  retention: { templateName: string; retentionMonths: number | null } | null,
): Promise<void> {
  const path = [CUSTOMERS_FOLDER_NAME, customerFolderName, CUSTOMER_INFORMATION_FOLDER_NAME];
  await fs.writeJson(path, 'profile.json', profile);
  if (retention) {
    await fs.writeJson(path, 'retention.json', retention);
  }
}

// --- consent field values ---------------------------------------------------

/** The deterministic path ONE field's value is written under, inside
 *  Customers/<customer>/Consent Register/<template>/<field>/ — never a
 *  different shape. */
export function fieldValuePath(customerFolderName: string, templateName: string, fieldLabel: string): string[] {
  return [CUSTOMERS_FOLDER_NAME, customerFolderName, CONSENT_REGISTER_FOLDER_NAME, sanitizeFolderLabel(templateName), sanitizeFolderLabel(fieldLabel)];
}

/** Writes ONE field's submitted value under its deterministic path. Text is
 *  written as plain, readable `value.txt` — never JSON-wrapped. A file
 *  (pdf/excel) is written with its ORIGINAL bytes and filename — a PDF stays
 *  a PDF, an Excel file stays Excel. This is the ONLY place a field's actual
 *  value is ever written anywhere — never through the backend, never into
 *  PostgreSQL (I1). */
export async function writeFieldValueLocally(
  fs: CentralFsProvider,
  customerFolderName: string,
  templateName: string,
  fieldLabel: string,
  value: string | File,
): Promise<void> {
  const path = fieldValuePath(customerFolderName, templateName, fieldLabel);
  if (typeof value === 'string') {
    await fs.writeText(path, 'value.txt', value);
  } else {
    await fs.writeRaw(path, value.name || 'value', value);
  }
}

// --- per-field Additional Storage (moduleKey 'consent_form_field') ---------

/** The single top-level folder created inside a per-field Additional
 *  Storage root — the root is already dedicated to ONE field, so this is
 *  just a fixed landing folder, never a second layer of naming. */
const ADDITIONAL_STORAGE_FOLDER_NAME = 'Additional Storage';

/** MUST be called from a user gesture. Picks a NEW dedicated folder for one
 *  field's Additional Storage, creating its own small storage_roots row
 *  (auto-named, unique per entityId) + one folder + the mapping — reusing
 *  the exact same generic endpoints as the Central root, just scoped 1:1 to
 *  this one field. One field's choice never becomes another field's. */
export async function connectAdditionalStorageForEntity(
  moduleKey: StorageModuleKey,
  entityId: string,
  label: string,
): Promise<{ root: StorageRoot; folder: StorageFolder; handle: FileSystemDirectoryHandle }> {
  if (!isLocalStorageAdapterSupported() || !window.showDirectoryPicker) {
    throw new Error('This browser does not support local folder selection (File System Access API).');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

  const root = await apiFetch<StorageRoot>('/storage/roots', {
    method: 'POST',
    body: { name: `${ADDITIONAL_STORAGE_ROOT_PREFIX}${sanitizeFolderLabel(label)} (${entityId.slice(0, 8)})`, provider: 'local' },
  });
  await saveStorageHandle(root.id, handle);
  const folder = await apiFetch<StorageFolder>('/storage/folders', {
    method: 'POST',
    body: { storageRootId: root.id, parentFolderId: null, name: ADDITIONAL_STORAGE_FOLDER_NAME },
  });
  await apiFetch('/storage/mappings', {
    method: 'PUT',
    body: { moduleKey, entityId, folderId: folder.id },
  });
  return { root, folder, handle };
}

/** Removes one entity's Additional Storage mapping (the mapped folder and its
 *  root stay on disk — this only clears the CENTRAL configuration, never
 *  touches the client's real files). */
export async function removeAdditionalStorageMapping(mapping: StorageMapping): Promise<void> {
  await apiFetch(`/storage/mappings/${mapping.id}`, { method: 'DELETE' });
}

/** Writes a field's value into its own Additional Storage root (if connected
 *  and permitted in THIS browser) — the SAME value, same file-format
 *  discipline (text stays readable text, pdf/excel keep original bytes) as
 *  the central write, just under this field's dedicated Additional Storage
 *  folder instead of Customers/<customer>/Consent Register/.... */
export async function writeFieldValueToAdditionalStorage(
  handle: FileSystemDirectoryHandle,
  customerFolderName: string,
  value: string | File,
): Promise<void> {
  const path = [ADDITIONAL_STORAGE_FOLDER_NAME, sanitizeFolderLabel(customerFolderName)];
  if (typeof value === 'string') {
    await writeLocalTextFile(handle, path, 'value.txt', value);
  } else {
    await writeLocalRawFile(handle, path, value.name || 'value', value);
  }
}
