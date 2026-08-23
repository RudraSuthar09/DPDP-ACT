'use client';

import { useState } from 'react';
import { formPortalFetch, FormPortalApiError } from '../../../lib/form-portal-api';
import { apiFetch } from '../../../lib/api';
import {
  getAdditionalStorageMapping,
  getCentralStorageStatus,
  findRootForFolder,
  resolveCustomerFolder,
  writeCustomerInformation,
  writeFieldValueLocally,
  writeFieldValueToAdditionalStorage,
} from '../../../lib/central-storage';
import type { CentralFsProvider } from '../../../lib/local-storage-provider';
import { isElectronStorageAvailable } from '../../../lib/electron-storage';
import { getStorageHandle, queryStorageHandlePermission } from '../../../lib/local-storage-handles';

/**
 * Thrown when the consent grant WAS recorded server-side but writing the
 * customer's field data/documents to Central DPDP Storage failed (or the
 * store isn't available). Distinct from a submission failure so the UI can
 * be honest: "consent recorded, but data not saved locally" — never a bland
 * "Thank you" that falsely implies the documents were stored.
 */
class StorageWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageWriteError';
  }
}

interface PublicFormRow {
  consentPurposeId: string;
  label: string;
  noticeText: string;
}

interface PublicFormField {
  id: string;
  label: string;
  fieldType: 'text' | 'pdf' | 'excel';
  required: boolean;
  /** Whether this field's value is the raw identity hashed into subject_ref
   *  and used to resolve/reuse the customer's Central DPDP Storage folder —
   *  rendered exactly like any other field; nothing about the public form
   *  singles it out for the visitor. */
  isIdentifier: boolean;
  /** Whether this field's value becomes the customer's human-readable
   *  filesystem folder name — independent of isIdentifier; may be the same
   *  field or a different one, or neither may be configured. */
  isCustomerName: boolean;
}

interface SubmitResponse {
  submissionId: string;
  subjectRef: string;
  /** The stable INTERNAL customer UUID (data_principals registry) — never
   *  the subjectRef hash. This is what storage_mappings.entity_id (moduleKey
   *  'data_principal') actually uses; the browser never derives it itself. */
  customerId: string;
  /** The customer's resolved display name (data_principals.display_name),
   *  authoritative from the backend — the browser uses THIS for the local
   *  folder name, never re-deriving it from the identifier's raw value. */
  displayName: string | null;
  answers: Array<{ consentPurposeId: string; granted: boolean }>;
}

interface ServerFieldValue {
  fieldId: string;
  textValue?: string;
  file?: { filename: string; contentBase64: string };
}

/**
 * Builds the `fieldValues` sent alongside every hosted-link submission — now
 * ALWAYS built and sent (no hasServerStorage gate): the backend uses them for
 * whichever local-delivery path applies —
 *   - the synchronous Enterprise 'server'-provider write
 *     (EnterpriseStorageSyncService), unchanged; or
 *   - staging them (encrypted) on the submission delivery queue
 *     (SubmissionDeliveryService) for the tenant's own local delivery agent
 *     to pick up and write via CentralFsProvider/electronFsProvider — the
 *     case a customer filling this form on THEIR OWN device (with zero
 *     access to the tenant's local storage) requires.
 * Files are base64-encoded for JSON transit; decoded server-side back to the
 * original bytes, never re-encoded (I1's "original bytes, original filename"
 * discipline is unchanged, just moved server-side for both cases). */
async function buildFieldValuesForSubmit(
  fields: PublicFormField[],
  textValues: Record<string, string>,
  files: Record<string, File>,
): Promise<ServerFieldValue[]> {
  const out: ServerFieldValue[] = [];
  for (const field of fields) {
    if (field.fieldType === 'text') {
      const value = textValues[field.id];
      if (value && value.trim()) out.push({ fieldId: field.id, textValue: value });
    } else {
      const file = files[field.id];
      if (file) out.push({ fieldId: field.id, file: { filename: file.name || 'value', contentBase64: await fileToBase64(file) } });
    }
  }
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // "data:<mime>;base64,<data>" — only the part after the comma is needed.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

const ACCEPT: Record<'pdf' | 'excel', string> = {
  pdf: 'application/pdf',
  excel: '.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The interactive half of the hosted consent form. Renders EXACTLY the
 * fields the client configured — no hardcoded Name/Email/Phone. Two
 * INDEPENDENT designations a field may carry (the same field, or two
 * different ones, or neither): "Use as Customer Identifier" (its value
 * rides along as `identityValue`, feeding ConsentFormsService.submitLink()'s
 * subject_ref hash, I2 — no identifier configured means the submission is
 * legitimate but won't be recognised as a repeat customer) and "Use as
 * Customer Name" (its value rides along as `customerNameValue`, becoming
 * data_principals.display_name server-side — used ONLY to name the
 * filesystem folder, never for identity resolution).
 *
 * Field values now always ride along on submit (see
 * buildFieldValuesForSubmit) — the backend picks the right local-delivery
 * path (synchronous Enterprise write, or the submission delivery queue for
 * later pickup by the tenant's own agent). Central DPDP Storage dual-write (best-
 * effort, never blocks the confirmation screen): if THIS browser already
 * has Central DPDP Storage connected — true for a staff-operated device/
 * kiosk, essentially never true for a customer's own personal device — the
 * customer's own folder is resolved-or-created under Customers/, NAMED
 * using the backend's resolved `displayName` (never re-derived locally —
 * see writeLocallyIfConnected), reused on a repeat submission (never
 * duplicated — see central-storage.ts's resolveCustomerFolder), Customer
 * Information/ is written, then every field's value under Consent
 * Register/<template>/<field>/. If this browser is not connected, field
 * values are simply not recoverable later (they were never sent anywhere to
 * recover FROM) — only the consent grant itself, already durably recorded
 * server-side, is picked up by the Storage page's deferred sync sweep,
 * filed under the same customerId/displayName the backend already resolved
 * (data_principals — the SAME customer, never a duplicate folder, whichever
 * browser eventually does the writing).
 */
export function FormIntake({
  slug,
  formId,
  templateName,
  retentionMonths,
  rows,
  fields,
}: {
  slug: string;
  formId: string;
  templateName: string;
  retentionMonths: number | null;
  rows: PublicFormRow[];
  fields: PublicFormField[];
}) {
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldFiles, setFieldFiles] = useState<Record<string, File>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Set when the consent was recorded but the local Central DPDP Storage write
  // failed — surfaced on the confirmation screen instead of a bland success.
  const [storageError, setStorageError] = useState<string | null>(null);

  function missingRequiredField(): string | null {
    for (const field of fields) {
      if (!field.required) continue;
      if (field.fieldType === 'text' && !fieldValues[field.id]?.trim()) return field.label;
      if (field.fieldType !== 'text' && !fieldFiles[field.id]) return field.label;
    }
    return null;
  }
  const canSubmit = missingRequiredField() === null;

  async function writeFieldsLocally(fs: CentralFsProvider, customerFolderName: string) {
    for (const field of fields) {
      const value: string | File | undefined = field.fieldType === 'text' ? fieldValues[field.id] : fieldFiles[field.id];
      if (value === undefined || (typeof value === 'string' && !value.trim())) continue;

      // CENTRAL write — REQUIRED. A failure here (e.g. the Electron IPC write
      // to the configured folder failing) must NOT be swallowed: it is the
      // whole point of the local-storage feature, so it propagates to the
      // caller and is surfaced to the user. (Previously this was wrapped in an
      // empty catch, which is exactly why field values/documents silently
      // failed to appear on disk while the form still showed "Thank you".)
      await writeFieldValueLocally(fs, customerFolderName, templateName, field.label, value);

      // ADDITIONAL per-field storage — genuinely optional/best-effort; a
      // failure here never blocks the central write above or another field.
      try {
        const mapping = await getAdditionalStorageMapping('consent_form_field', field.id);
        if (!mapping) continue;
        const resolved = await findRootForFolder(mapping.folderId);
        if (!resolved) continue;
        const additionalHandleRecord = await getStorageHandle(resolved.root.id);
        if (additionalHandleRecord && (await queryStorageHandlePermission(additionalHandleRecord.handle)) === 'granted') {
          await writeFieldValueToAdditionalStorage(additionalHandleRecord.handle, customerFolderName, value);
        }
      } catch {
        // Additional storage is optional per field — never blocks anything else.
      }
    }
  }

  /**
   * Persist the customer's field data + documents to Central DPDP Storage
   * AFTER the consent grant has been recorded server-side.
   *
   * In the installed Electron product this is REQUIRED (the whole local-
   * storage feature): getCentralStorageStatus() selects electronFsProvider()
   * (native filesystem via preload → IPC → enterprise-storage.js), and the
   * fieldValues/fieldFiles the customer entered — held here in the renderer —
   * are written directly to the configured folder (e.g. D:\Enterprise testing
   * old), never round-tripped through the backend. A failure or an
   * unavailable store is raised as StorageWriteError so the caller can tell
   * the user the truth instead of a bland "Thank you".
   *
   * In a plain browser (dev, no Electron bridge) with no connected storage,
   * this stays the legitimate deferred-sync case — it returns quietly and the
   * Storage page's sweep picks up the consent grant later.
   */
  async function writeToCentralStorage(response: SubmitResponse): Promise<void> {
    const electron = isElectronStorageAvailable();

    let central;
    try {
      central = await getCentralStorageStatus();
    } catch (err) {
      console.error('Central DPDP Storage status check failed:', err);
      if (electron) {
        throw new StorageWriteError(
          'Your consent was recorded, but Central DPDP Storage could not be reached to save the customer’s data. Open the Storage page to check the configured folder, then resubmit.',
        );
      }
      return; // browser/dev: nothing connected, deferred sync will handle it
    }

    if (central.status !== 'connected' || !central.fs || !central.root) {
      if (electron) {
        throw new StorageWriteError(
          central.status === 'needs_reconnect'
            ? 'Your consent was recorded, but the configured Central DPDP Storage folder is not reachable right now, so the customer’s data was not saved. Open Storage → Reconnect, then resubmit.'
            : 'Your consent was recorded, but Central DPDP Storage is not configured, so the customer’s data was not saved. Configure it on the Storage page, then resubmit.',
        );
      }
      return; // browser/dev deferred-sync case
    }

    try {
      const displayNameHint = response.displayName?.trim() || `customer-${response.customerId.slice(0, 8)}`;
      const customer = await resolveCustomerFolder(central.fs, central.root.id, response.customerId, displayNameHint);

      await writeCustomerInformation(
        central.fs,
        customer.name,
        {
          customerId: response.customerId,
          subjectRef: response.subjectRef,
          displayName: response.displayName,
          createdAt: new Date().toISOString(),
        },
        { templateName, retentionMonths },
      );
      await writeFieldsLocally(central.fs, customer.name);

      // Best-effort bookkeeping: mark the submission locally-synced. Needs a
      // staff session (MANAGE-gated); if absent it simply stays pending for
      // the Storage page's sweep — never a reason to report a storage failure,
      // since the actual field data is already written above.
      await apiFetch(`/consent/forms/${formId}/submissions/${response.submissionId}/mark-synced`, { method: 'POST' }).catch(
        () => undefined,
      );
    } catch (err) {
      console.error('Central DPDP Storage write failed:', err);
      throw new StorageWriteError(
        `Your consent was recorded, but saving the customer’s data to Central DPDP Storage failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const missing = missingRequiredField();
    if (missing) {
      setError(`"${missing}" is required.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identifierField = fields.find((f) => f.isIdentifier && f.fieldType === 'text');
      const identityValue = identifierField ? fieldValues[identifierField.id]?.trim() || null : null;
      const customerNameField = fields.find((f) => f.isCustomerName && f.fieldType === 'text');
      const customerNameValue = customerNameField ? fieldValues[customerNameField.id]?.trim() || null : null;

      // Always built and sent now — see buildFieldValuesForSubmit's header for
      // why (the backend picks the right delivery path; this browser makes no
      // assumption about which one applies).
      const submitFieldValues = await buildFieldValuesForSubmit(fields, fieldValues, fieldFiles);

      const response = await formPortalFetch<SubmitResponse>(`/forms/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        body: {
          identityValue: identityValue || undefined,
          customerNameValue: customerNameValue || undefined,
          answers: rows.map((r) => ({ consentPurposeId: r.consentPurposeId, granted: !!granted[r.consentPurposeId] })),
          fieldValues: submitFieldValues.length > 0 ? submitFieldValues : undefined,
        },
      });

      // Consent is now durably recorded server-side. Persist the customer's
      // field data + documents to Central DPDP Storage — AWAITED, so a failure
      // is caught and shown, never silently swallowed while "Thank you" implies
      // success. A StorageWriteError means the grant landed but the local write
      // did not; anything else is a genuine submission failure.
      try {
        await writeToCentralStorage(response);
        setDone(true);
      } catch (storageErr) {
        if (storageErr instanceof StorageWriteError) {
          setStorageError(storageErr.message);
          setDone(true); // the grant WAS recorded — show it, but with the warning, not a plain success
        } else {
          throw storageErr;
        }
      }
    } catch (err) {
      setError(err instanceof FormPortalApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    if (storageError) {
      return (
        <div>
          <h2>Consent recorded</h2>
          <div className="error">{storageError}</div>
        </div>
      );
    }
    return (
      <div>
        <h2>Thank you</h2>
        <p className="muted">Your choices have been recorded.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      {error && <div className="error">{error}</div>}

      {fields.map((field) => (
        <div key={field.id} style={{ margin: '0.75em 0' }}>
          <label htmlFor={`field-${field.id}`}>
            {field.label}
            {field.required ? ' *' : ''}
          </label>
          {field.fieldType === 'text' ? (
            <input
              id={`field-${field.id}`}
              value={fieldValues[field.id] ?? ''}
              onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
              required={field.required}
            />
          ) : (
            <input
              id={`field-${field.id}`}
              type="file"
              accept={ACCEPT[field.fieldType]}
              onChange={(e) => {
                const file = e.target.files?.[0];
                setFieldFiles((prev) => (file ? { ...prev, [field.id]: file } : prev));
              }}
              required={field.required}
            />
          )}
        </div>
      ))}

      <h3>Your choices</h3>
      {rows.map((r) => (
        <label key={r.consentPurposeId} style={{ display: 'block', margin: '0.75em 0' }}>
          <input
            type="checkbox"
            style={{ width: 'auto', marginRight: 8 }}
            checked={!!granted[r.consentPurposeId]}
            onChange={(e) => setGranted((prev) => ({ ...prev, [r.consentPurposeId]: e.target.checked }))}
          />
          <strong>{r.label}</strong>
          {r.noticeText && <span className="muted"> — {r.noticeText}</span>}
        </label>
      ))}

      <button className="primary" type="submit" disabled={busy || !canSubmit} style={{ marginTop: 16 }}>
        {busy ? 'Saving…' : 'Save my choices'}
      </button>
    </form>
  );
}
