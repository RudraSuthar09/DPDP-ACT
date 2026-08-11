'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { PageHeader } from '../../../components/PageHeader';

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
      <PageHeader
        title="Data Inventory"
        subtitle="Categories of data, purposes, and retention — descriptions, never customer records."
        actions={
          canManage ? (
            <>
              <button type="button" onClick={() => router.push('/inventory/import')}>
                Import CSV/Excel
              </button>
              <button className="primary" type="button" onClick={() => router.push('/inventory/register')}>
                + Add data element
              </button>
            </>
          ) : undefined
        }
      />

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={includeTombstoned}
            onChange={(e) => setIncludeTombstoned(e.target.checked)}
          />
          Show tombstoned
        </label>
      </div>

      <div className="entry-grid" data-tour="inventory-register">
        {elements.map((el) => (
          <div key={el.id} className="entry-card">
            <div className="entry-card-title">{el.category}</div>
            <div className="entry-card-meta">
              <div className="entry-card-field">
                <div className="field-label">Purpose</div>
                <div className="field-value">
                  {el.purposeCount > 0 ? (
                    `${el.purposeCount} purpose${el.purposeCount === 1 ? '' : 's'}`
                  ) : (
                    <span className="muted">None yet</span>
                  )}
                </div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Storage</div>
                <div className="field-value">{el.storageLocation}</div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Status</div>
                <div className={`field-value ${el.status === 'active' ? 'status-active' : 'status-muted'}`}>
                  {el.status === 'active' ? 'Active' : 'Tombstoned'}
                </div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Classification</div>
                <div className="field-value">
                  {el.piiDecision === 'accepted' && (
                    <span className="badge success">{el.piiCategory}</span>
                  )}
                  {el.piiDecision === 'rejected' && <span className="muted">Not classified</span>}
                  {el.piiDecision === 'undecided' && <span className="muted">Unreviewed</span>}
                </div>
              </div>
              <div className="entry-card-field">
                <div className="field-label">Version</div>
                <div className="field-value mono">v{el.versionNumber}</div>
              </div>
            </div>
            <div className="entry-card-footer">
              <button type="button" onClick={() => router.push(`/inventory/${el.id}`)}>
                View details
              </button>
            </div>
          </div>
        ))}
        {elements.length === 0 && !loading && (
          <p className="muted" style={{ textAlign: 'center', padding: 24, gridColumn: '1 / -1' }}>
            No data elements yet.
          </p>
        )}
      </div>
    </div>
  );
}
