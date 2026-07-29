'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

/**
 * Consent purposes (FR-CON-01) against the real /consent/purposes endpoints
 * (Prompt 18). Same list shape as the Data Inventory register: current
 * version + status, tombstone rather than hard-delete, tombstoned rows stay
 * visible (never hidden) via the "Show tombstoned" toggle.
 */
interface PurposeListItem {
  id: string;
  status: 'active' | 'tombstoned';
  versionNumber: number;
  name: string;
  description: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

export default function ConsentPage() {
  const { user } = useAuth();
  const router = useRouter();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [purposes, setPurposes] = useState<PurposeListItem[]>([]);
  const [includeTombstoned, setIncludeTombstoned] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = includeTombstoned ? '?includeTombstoned=true' : '';
      const res = await apiFetch<{ purposes: PurposeListItem[] }>(`/consent/purposes${query}`);
      setPurposes(res.purposes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load consent purposes.');
    } finally {
      setLoading(false);
    }
  }, [includeTombstoned]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <h1>Consent Register</h1>
      <p className="muted">
        Purposes and notices consent is collected against (FR-CON-01/02) — versioned, never
        hard-deleted.
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
          <button className="primary" type="button" onClick={() => router.push('/consent/purposes/new')}>
            + New purpose
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Version</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {purposes.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.description || <span className="muted">—</span>}</td>
                <td className="mono">v{p.versionNumber}</td>
                <td>
                  <span className={`badge ${p.status === 'active' ? 'success' : 'denied'}`}>
                    {p.status}
                  </span>
                </td>
                <td>
                  <Link href={`/consent/purposes/${p.id}`}>View</Link>
                </td>
              </tr>
            ))}
            {purposes.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No consent purposes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
