'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../lib/api';
import { useToast } from './Toast';

export type LegalBasis = 'consent' | 'legitimate_use' | 'contract' | 'legal_obligation' | 'other';

export interface EntryPurpose {
  id: string;
  status: 'active' | 'tombstoned';
  versionNumber: number;
  purposeName: string;
  description: string | null;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  retentionPeriod: string;
  retentionMonths: number | null;
}

export const LEGAL_BASIS_OPTIONS: Array<{ value: LegalBasis; label: string }> = [
  { value: 'consent', label: 'Consent' },
  { value: 'legitimate_use', label: 'Legitimate use' },
  { value: 'contract', label: 'Contract' },
  { value: 'legal_obligation', label: 'Legal obligation' },
  { value: 'other', label: 'Other' },
];

const LEGAL_BASIS_LABELS: Record<LegalBasis, string> = Object.fromEntries(
  LEGAL_BASIS_OPTIONS.map((o) => [o.value, o.label]),
) as Record<LegalBasis, string>;

interface FormState {
  purposeName: string;
  description: string;
  legalBasis: LegalBasis;
  legalBasisNote: string;
  retentionPeriod: string;
  retentionMonths: string;
}

const EMPTY_FORM: FormState = {
  purposeName: '',
  description: '',
  legalBasis: 'consent',
  legalBasisNote: '',
  retentionPeriod: '',
  retentionMonths: '',
};

/**
 * Processing purposes + legal basis + retention (FR-INV-05) for one Data
 * Inventory register entry — a one-to-many list, each purpose independently
 * add/edit/remove-able, against the real /inventory/register/:id/purposes
 * endpoints from Prompt 14. Replaces the old single flat purpose/retention
 * fields the guided wizard used to collect.
 */
export function PurposesPanel({ entryId, canManage }: { entryId: string; canManage: boolean }) {
  const [purposes, setPurposes] = useState<EntryPurpose[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ purposes: EntryPurpose[] }>(
        `/inventory/register/${entryId}/purposes`,
      );
      setPurposes(res.purposes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purposes.');
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    void load();
  }, [load]);

  function toBody(f: FormState) {
    return {
      purposeName: f.purposeName.trim(),
      description: f.description.trim() || undefined,
      legalBasis: f.legalBasis,
      legalBasisNote: f.legalBasisNote.trim() || undefined,
      retentionPeriod: f.retentionPeriod.trim(),
      retentionMonths: f.retentionMonths.trim() ? Number(f.retentionMonths.trim()) : undefined,
    };
  }

  async function onAdd() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/${entryId}/purposes`, {
        method: 'POST',
        body: toBody(addForm),
      });
      setAddForm(EMPTY_FORM);
      setAdding(false);
      showToast('Purpose added.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this purpose.');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: EntryPurpose) {
    setEditingId(p.id);
    setEditForm({
      purposeName: p.purposeName,
      description: p.description ?? '',
      legalBasis: p.legalBasis,
      legalBasisNote: p.legalBasisNote ?? '',
      retentionPeriod: p.retentionPeriod,
      retentionMonths: p.retentionMonths != null ? String(p.retentionMonths) : '',
    });
  }

  async function onSaveEdit(purposeId: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/purposes/${purposeId}`, {
        method: 'PATCH',
        body: toBody(editForm),
      });
      setEditingId(null);
      showToast('Purpose saved as a new version.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this purpose.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(purposeId: string, purposeName: string) {
    const reason = window.prompt(
      `Why are you removing the "${purposeName}" purpose? (required, kept as evidence)`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to remove a purpose.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/purposes/${purposeId}`, {
        method: 'DELETE',
        body: { reason: reason.trim() },
      });
      showToast('Purpose removed.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this purpose.');
    } finally {
      setBusy(false);
    }
  }

  const canAdd = addForm.purposeName.trim().length > 0 && addForm.retentionPeriod.trim().length > 0;
  const canSaveEdit =
    editForm.purposeName.trim().length > 0 && editForm.retentionPeriod.trim().length > 0;

  return (
    <div className="panel" style={{ marginTop: 16 }} data-tour="purposes-panel">
      <h2 style={{ marginTop: 0 }}>Processing purposes</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        Why this data is collected, the DPDP ground relied on, and how long it&apos;s kept — one data
        element can have several purposes, each with its own legal basis and retention.
        Every edit creates a new version; nothing is overwritten.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && purposes.length === 0 && !adding && (
        <p className="muted">No purposes recorded yet.</p>
      )}

      {!loading &&
        purposes.map((p) =>
          editingId === p.id ? (
            <PurposeForm
              key={p.id}
              form={editForm}
              setForm={setEditForm}
              busy={busy}
              onCancel={() => setEditingId(null)}
              onSubmit={() => void onSaveEdit(p.id)}
              submitLabel="Save (new version)"
              canSubmit={canSaveEdit}
            />
          ) : (
            <div
              key={p.id}
              data-testid="purpose-row"
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <strong>{p.purposeName}</strong>{' '}
                  <span className="badge">{LEGAL_BASIS_LABELS[p.legalBasis]}</span>{' '}
                  <span className="muted mono" style={{ fontSize: '0.8rem' }}>
                    v{p.versionNumber}
                  </span>
                  {p.description && <div className="muted">{p.description}</div>}
                  {p.legalBasisNote && (
                    <div className="muted" style={{ fontSize: '0.85rem' }}>
                      Basis note: {p.legalBasisNote}
                    </div>
                  )}
                  <div style={{ fontSize: '0.85rem' }}>
                    Retention: {p.retentionPeriod}
                    {p.retentionMonths != null && (
                      <span className="badge info" style={{ marginLeft: 8 }}>
                        tracked · {p.retentionMonths} mo
                      </span>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button disabled={busy} onClick={() => startEdit(p)}>
                      Edit
                    </button>
                    <button disabled={busy} onClick={() => void onRemove(p.id, p.purposeName)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
          ),
        )}

      {canManage && adding && (
        <PurposeForm
          form={addForm}
          setForm={setAddForm}
          busy={busy}
          onCancel={() => {
            setAdding(false);
            setAddForm(EMPTY_FORM);
          }}
          onSubmit={() => void onAdd()}
          submitLabel="Add purpose"
          canSubmit={canAdd}
        />
      )}

      {canManage && !adding && (
        <button type="button" onClick={() => setAdding(true)}>
          + Add a purpose
        </button>
      )}
    </div>
  );
}

function PurposeForm({
  form,
  setForm,
  busy,
  onCancel,
  onSubmit,
  submitLabel,
  canSubmit,
}: {
  form: FormState;
  setForm: (updater: (f: FormState) => FormState) => void;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  canSubmit: boolean;
}) {
  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="reveal" style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <label>Purpose name</label>
      <input
        value={form.purposeName}
        onChange={(e) => set('purposeName', e.target.value)}
        placeholder="e.g. Marketing communications, Fraud prevention"
        autoFocus
      />

      <label>Description (optional)</label>
      <input value={form.description} onChange={(e) => set('description', e.target.value)} />

      <label>Legal basis</label>
      <select value={form.legalBasis} onChange={(e) => set('legalBasis', e.target.value as LegalBasis)}>
        {LEGAL_BASIS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label>Legal basis note (optional)</label>
      <input
        value={form.legalBasisNote}
        onChange={(e) => set('legalBasisNote', e.target.value)}
        placeholder="e.g. which legitimate-use ground, consent record reference"
      />

      <label>Retention period</label>
      <input
        value={form.retentionPeriod}
        onChange={(e) => set('retentionPeriod', e.target.value)}
        placeholder="e.g. 3 years after account closure"
      />

      <label>Retention period in months (optional — enables retention tracking)</label>
      <input
        type="number"
        min={1}
        value={form.retentionMonths}
        onChange={(e) => set('retentionMonths', e.target.value)}
        placeholder="e.g. 36"
      />
      <p className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
        A computable duration alongside the description above. Set it to track when a subject&apos;s
        data under this purpose reaches its retention expiry.
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" type="button" disabled={busy || !canSubmit} onClick={onSubmit}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </div>
  );
}
