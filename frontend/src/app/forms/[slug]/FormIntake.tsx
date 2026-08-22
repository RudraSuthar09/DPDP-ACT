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
import { getStorageHandle, queryStorageHandlePermission } from '../../../lib/local-storage-handles';

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
}

interface SubmitResponse {
  submissionId: string;
  subjectRef: string;
  /** The stable INTERNAL customer UUID (data_principals registry) — never
   *  the subjectRef hash. This is what storage_mappings.entity_id (moduleKey
   *  'data_principal') actually uses; the browser never derives it itself. */
  customerId: string;
  answers: Array<{ consentPurposeId: string; granted: boolean }>;
}

const ACCEPT: Record<'pdf' | 'excel', string> = {
  pdf: 'application/pdf',
  excel: '.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The interactive half of the hosted consent form. Renders EXACTLY the
 * fields the client configured — no hardcoded Name/Email/Phone. Whichever
 * field the client marked "Use as Customer Identifier" renders like any
 * other field; its typed value rides along as `identityValue` on submit,
 * feeding ConsentFormsService.submitLink()'s subject_ref hash (I2). No
 * identifier field configured -> identityValue is null -> the submission is
 * legitimate but won't be recognised as a repeat customer later.
 *
 * A field's VALUE never touches the backend at all (I1) — only its
 * CONFIGURATION (label/type/required/isIdentifier) was ever fetched from
 * `/forms/:slug`. Central DPDP Storage dual-write (best-effort, never blocks
 * the confirmation screen): if THIS browser already has Central DPDP
 * Storage connected — true for a staff-operated device/kiosk, essentially
 * never true for a customer's own personal device — the customer's own
 * folder is resolved-or-created under Customers/ (reused on a repeat
 * submission, never duplicated — see central-storage.ts's
 * resolveCustomerFolder), Customer Information/ is written, then every
 * field's value under Consent Register/<template>/<field>/. If this browser
 * is not connected, field values are simply not recoverable later (they
 * were never sent anywhere to recover FROM) — only the consent grant
 * itself, already durably recorded server-side, is picked up by the Storage
 * page's deferred sync sweep, filed under the same customerId the backend
 * already resolved (data_principals — the SAME customer, never a duplicate
 * folder, whichever browser eventually does the writing).
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

  function missingRequiredField(): string | null {
    for (const field of fields) {
      if (!field.required) continue;
      if (field.fieldType === 'text' && !fieldValues[field.id]?.trim()) return field.label;
      if (field.fieldType !== 'text' && !fieldFiles[field.id]) return field.label;
    }
    return null;
  }
  const canSubmit = missingRequiredField() === null;

  async function writeFieldsLocally(handle: FileSystemDirectoryHandle, customerFolderName: string) {
    for (const field of fields) {
      const value: string | File | undefined = field.fieldType === 'text' ? fieldValues[field.id] : fieldFiles[field.id];
      if (value === undefined || (typeof value === 'string' && !value.trim())) continue;

      try {
        await writeFieldValueLocally(handle, customerFolderName, templateName, field.label, value);
      } catch {
        // Best-effort per field — one field's write failure never blocks another's.
      }

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

  async function writeLocallyIfConnected(response: SubmitResponse, identityValue: string | null) {
    try {
      const central = await getCentralStorageStatus();
      if (central.status !== 'connected' || !central.handle || !central.root) return;

      const displayNameHint = identityValue?.trim() || `customer-${response.customerId.slice(0, 8)}`;
      const customer = await resolveCustomerFolder(central.handle, central.root.id, response.customerId, displayNameHint);

      await writeCustomerInformation(
        central.handle,
        customer.name,
        {
          customerId: response.customerId,
          subjectRef: response.subjectRef,
          displayName: identityValue?.trim() || null,
          createdAt: new Date().toISOString(),
        },
        { templateName, retentionMonths },
      );
      await writeFieldsLocally(central.handle, customer.name);

      // Best-effort only: this call needs a staff session to succeed (the
      // MANAGE-gated endpoint) — on a true public/self-service device there
      // is none, and that's fine: local_synced_at just stays NULL and the
      // Storage page's deferred sync sweep picks it up later (consent grant
      // only — field values were never sent anywhere to recover from).
      await apiFetch(`/consent/forms/${formId}/submissions/${response.submissionId}/mark-synced`, { method: 'POST' }).catch(
        () => undefined,
      );
    } catch {
      // Local write is a mirror, never the source of truth — the consent
      // grant itself is already durably recorded server-side regardless.
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

      const response = await formPortalFetch<SubmitResponse>(`/forms/${encodeURIComponent(slug)}/submit`, {
        method: 'POST',
        body: {
          identityValue: identityValue || undefined,
          answers: rows.map((r) => ({ consentPurposeId: r.consentPurposeId, granted: !!granted[r.consentPurposeId] })),
        },
      });
      setDone(true);
      void writeLocallyIfConnected(response, identityValue);
    } catch (err) {
      setError(err instanceof FormPortalApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
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
