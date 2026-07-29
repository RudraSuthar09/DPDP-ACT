'use client';

import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import { InventoryEntryWizard, type InventoryEntryFields } from '../../../../components/InventoryEntryWizard';

/** Guided-form entry (FR-INV-01) against the real POST /inventory/register. */
export default function NewInventoryEntryPage() {
  const router = useRouter();

  async function handleSubmit(fields: InventoryEntryFields) {
    const created = await apiFetch<{ id: string }>('/inventory/register', {
      method: 'POST',
      body: fields,
    });
    router.replace(`/inventory/${created.id}`);
  }

  return (
    <div>
      <h1>Add a data element</h1>
      <p className="muted">
        Guided entry for the Data Inventory register (FR-INV-01) — what&apos;s collected and where
        it&apos;s stored. Categories and descriptions only — never customer records (I1). You&apos;ll
        add processing purposes, legal basis, and retention next.
      </p>
      <InventoryEntryWizard onSubmit={handleSubmit} submitLabel="Add data element" />
    </div>
  );
}
