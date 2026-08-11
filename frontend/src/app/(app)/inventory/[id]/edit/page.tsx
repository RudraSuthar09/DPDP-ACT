'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../../lib/api';
import Link from 'next/link';
import {
  InventoryEntryWizard,
  type InventoryEntryFields,
} from '../../../../../components/InventoryEntryWizard';
import { useToast } from '../../../../../components/Toast';

interface VersionEntry {
  versionNumber: number;
  category: string;
  description: string | null;
  storageLocation: string;
}
interface EntryDetail {
  status: 'active' | 'tombstoned';
  versions: VersionEntry[];
}

/** Edit an existing entry. Submitting PATCHes — the backend creates a new
 *  version rather than overwriting (FR-INV-08); it never touches this one. */
export default function EditInventoryEntryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [initial, setInitial] = useState<InventoryEntryFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entry = await apiFetch<EntryDetail>(`/inventory/register/${id}`);
      if (entry.status !== 'active') {
        setError('This data element has been tombstoned and can no longer be edited.');
        return;
      }
      const current = entry.versions[0];
      setInitial({
        category: current.category,
        description: current.description ?? '',
        storageLocation: current.storageLocation,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this data element.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(fields: InventoryEntryFields) {
    await apiFetch(`/inventory/register/${id}`, { method: 'PATCH', body: fields });
    showToast('Data element saved as a new version.');
    router.replace(`/inventory/${id}`);
  }

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <Link href={`/inventory/${id}`}>← Back to {initial ? initial.category : 'Data Inventory'}</Link>
      </p>
      <h1>Edit {initial ? initial.category : 'data element'}</h1>
      <p className="muted">
        Saving creates a new version — the previous one is kept, never overwritten.
      </p>
      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && initial && (
        <InventoryEntryWizard initial={initial} onSubmit={handleSubmit} submitLabel="Save new version" />
      )}
    </div>
  );
}
