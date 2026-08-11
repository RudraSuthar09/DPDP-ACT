'use client';

import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import { InventoryEntryWizard, type InventoryEntryFields } from '../../../../components/InventoryEntryWizard';
import { useToast } from '../../../../components/Toast';

/** Guided-form entry (FR-INV-01) against the real POST /inventory/register. */
export default function NewInventoryEntryPage() {
  const router = useRouter();
  const { showToast } = useToast();

  async function handleSubmit(fields: InventoryEntryFields) {
    const created = await apiFetch<{ id: string }>('/inventory/register', {
      method: 'POST',
      body: fields,
    });
    showToast('Data element added.');
    router.replace(`/inventory/${created.id}`);
  }

  return (
    <div>
      <h1>Add a data element</h1>
      <p className="muted">
        Guided entry for the Data Inventory register — what&apos;s collected and where
        it&apos;s stored. Categories and descriptions only — never customer records. You&apos;ll
        add processing purposes, legal basis, and retention next.
      </p>
      <InventoryEntryWizard onSubmit={handleSubmit} submitLabel="Add data element" />
    </div>
  );
}
