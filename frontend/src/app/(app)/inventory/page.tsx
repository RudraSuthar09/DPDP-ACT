'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

/**
 * Data Inventory register (FR-INV-01/08) against the real /inventory/register
 * endpoints. Categories/purposes/retention only — never customer records (I1).
 * Tombstoned entries stay visible (never hidden) but are read-only everywhere
 * in this UI, matching the backend's rejection of edits on them.
 */
interface RegisterListItem {
  id: string;
  status: 'active' | 'tombstoned';
  piiCategory: string | null;
  piiConfidence: 'high' | 'medium' | 'low' | null;
  piiDecision: 'undecided' | 'accepted' | 'rejected';
  versionNumber: number;
  category: string;
  description: string | null;
  storageLocation: string;
  purposeCount: number;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

export default function InventoryPage() {
  const { user } = useAuth();
  const router = useRouter();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [elements, setElements] = useState<RegisterListItem[]>([]);
  const [includeTombstoned, setIncludeTombstoned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = includeTombstoned ? '?includeTombstoned=true' : '';
      const res = await apiFetch<{ elements: RegisterListItem[] }>(`/inventory/register${query}`);
      setElements(res.elements);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the Data Inventory register.');
    } finally {
      setLoading(false);
    }
  }, [includeTombstoned]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>Data Inventory</h1>
      <p className="muted">
        Categories of data, purposes, and retention — descriptions, never customer records (I1).
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={includeTombstoned}
            onChange={(e) => setIncludeTombstoned(e.target.checked)}
          />
          Show tombstoned
        </label>
        {canManage && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={() => router.push('/inventory/import')}>
              Import CSV/Excel
            </button>
            <button className="primary" type="button" onClick={() => router.push('/inventory/register')}>
              + Add data element
            </button>
          </div>
        )}
      </div>

      <div className="table-wrap" data-tour="inventory-register">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Storage location</th>
              <th>Purposes</th>
              <th>Version</th>
              <th>Classification</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {elements.map((el) => (
              <tr key={el.id}>
                <td>{el.category}</td>
                <td>{el.storageLocation}</td>
                <td>
                  {el.purposeCount > 0 ? (
                    `${el.purposeCount} purpose${el.purposeCount === 1 ? '' : 's'}`
                  ) : (
                    <span className="muted">None yet</span>
                  )}
                </td>
                <td className="mono">v{el.versionNumber}</td>
                <td>
                  {el.piiDecision === 'accepted' && (
                    <span className="badge success">{el.piiCategory}</span>
                  )}
                  {el.piiDecision === 'rejected' && <span className="muted">Not classified</span>}
                  {el.piiDecision === 'undecided' && <span className="muted">Unreviewed</span>}
                </td>
                <td>
                  <span className={`badge ${el.status === 'active' ? 'success' : 'denied'}`}>
                    {el.status}
                  </span>
                </td>
                <td>
                  <Link href={`/inventory/${el.id}`}>View history</Link>
                </td>
              </tr>
            ))}
            {elements.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No data elements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
