'use client';

import { useState } from 'react';
import { ApiError } from '../lib/api';

export interface InventoryEntryFields {
  category: string;
  description: string;
  storageLocation: string;
}

const STEPS = ['category', 'description', 'storageLocation', 'review'] as const;
type StepKey = (typeof STEPS)[number];

const STEP_TITLES: Record<StepKey, string> = {
  category: 'What is collected?',
  description: 'Anything more to describe it?',
  storageLocation: 'Where is it stored?',
  review: 'Review & submit',
};

const REQUIRED_STEPS = new Set<StepKey>(['category', 'storageLocation']);

function valueForStep(step: StepKey, fields: InventoryEntryFields): string {
  switch (step) {
    case 'category':
      return fields.category;
    case 'description':
      return fields.description;
    case 'storageLocation':
      return fields.storageLocation;
    case 'review':
      return '';
  }
}

/**
 * Guided multi-step entry for one Data Inventory register entry (FR-INV-01):
 * what's collected, where it's stored. Shared by "add a data element" and
 * "edit" (edit pre-fills `initial` and submits a PATCH, which the backend
 * turns into a new version — FR-INV-08, never an overwrite).
 *
 * Purpose/legal-basis/retention are NOT collected here (Prompt 14, FR-INV-05):
 * a data element can have several purposes, each with its own legal basis and
 * retention rule, which a single wizard field can't express. Those are added
 * afterward from the entry detail page's Purposes panel, one at a time.
 */
export function InventoryEntryWizard({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: InventoryEntryFields;
  onSubmit: (fields: InventoryEntryFields) => Promise<void>;
  submitLabel: string;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [fields, setFields] = useState<InventoryEntryFields>(
    initial ?? { category: '', description: '', storageLocation: '' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const step = STEPS[stepIndex];
  const canAdvance = !REQUIRED_STEPS.has(step) || valueForStep(step, fields).trim().length > 0;

  function update(key: keyof InventoryEntryFields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        category: fields.category.trim(),
        description: fields.description.trim(),
        storageLocation: fields.storageLocation.trim(),
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Step {stepIndex + 1} of {STEPS.length} — {STEP_TITLES[step]}
      </p>

      {step === 'category' && (
        <>
          <label>Category (what is collected)</label>
          <input
            value={fields.category}
            onChange={(e) => update('category', e.target.value)}
            placeholder="e.g. Mobile number, Aadhaar number, Email address"
            autoFocus
          />
        </>
      )}

      {step === 'description' && (
        <>
          <label>Description (optional)</label>
          <input
            value={fields.description}
            onChange={(e) => update('description', e.target.value)}
            placeholder="Any further detail a compliance reviewer would want — optional"
          />
        </>
      )}

      {step === 'storageLocation' && (
        <>
          <label>Storage location (where it&apos;s stored)</label>
          <input
            value={fields.storageLocation}
            onChange={(e) => update('storageLocation', e.target.value)}
            placeholder="e.g. Primary Postgres DB, customers table"
          />
        </>
      )}

      {step === 'review' && (
        <>
          <dl style={{ margin: 0 }}>
            <ReviewItem label="Category" value={fields.category} />
            <ReviewItem label="Description" value={fields.description || '—'} />
            <ReviewItem label="Storage location" value={fields.storageLocation} />
          </dl>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Next, you&apos;ll add at least one processing purpose (with its legal basis and retention
            period) from the data element&apos;s page.
          </p>
        </>
      )}

      {error && <div className="error">{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
        <button
          type="button"
          disabled={stepIndex === 0 || busy}
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
        >
          Back
        </button>
        {step === 'review' ? (
          <button className="primary" type="button" disabled={busy} onClick={() => void handleSubmit()}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            disabled={!canAdvance}
            onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <dt className="muted" style={{ fontSize: '0.8rem' }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
