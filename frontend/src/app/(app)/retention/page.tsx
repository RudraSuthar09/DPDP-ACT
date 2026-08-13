'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiFetch, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';

interface RetentionRecord {
  id: string;
  subjectRef: string;
  inventoryPurposeName: string | null;
  dataElement: string | null;
  basis: string;
  source: 'consent_grant' | 'manual_collection';
  startAt: string;
  retentionEnd: string;
  status: 'active' | 'reviewed';
  expiredFlaggedAt: string | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);
type Filter = 'approaching' | 'past' | 'all';

/**
 * Retention drill-down (data-lifecycle). Lists which pseudonymised subjects hold
 * data approaching or past its retention period — subject REFERENCE (HMAC),
 * purpose, data element and the frozen expiry date. Never a raw value. The
 * platform surfaces the list and records a review; it never deletes the client's
 * data (I1).
 */
export default function RetentionPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);
  const params = useSearchParams();
  const initial = (params.get('filter') as Filter) || 'approaching';

  const [filter, setFilter] = useState<Filter>(['approaching', 'past', 'all'].includes(initial) ? initial : 'approaching');
  const [records, setRecords] = useState<RetentionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ records: RetentionRecord[] }>(`/consent/retention?filter=${filter}`);
      setRecords(res.records);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load retention records.');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onReview(rec: RetentionRecord) {
    const note = window.prompt(
      'Record a review note (what you did — e.g. asked the client to delete this from their system). ' +
        'The platform does not delete their data itself.',
    );
    if (note === null) return;
    setBusyId(rec.id);
    setError(null);
    try {
      await apiFetch(`/consent/retention/${rec.id}/review`, { method: 'POST', body: { note: note.trim() || undefined } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark this reviewed.');
    } finally {
      setBusyId(null);
    }
  }

  const isPast = (r: RetentionRecord) => new Date(r.retentionEnd).getTime() <= Date.now();

  return (
    <div>
      <h1>Data retention</h1>
      <p className="muted">
        Which subjects hold data approaching or past its retention period, by pseudonymised
        reference. The platform surfaces this — it never deletes your client&apos;s data itself.
        Expiry dates are frozen at collection and never change if a purpose&apos;s retention is
        later edited.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar" style={{ gap: 6 }}>
        {(['approaching', 'past', 'all'] as Filter[]).map((f) => (
          <button key={f} type="button" className={filter === f ? 'primary' : ''} onClick={() => setFilter(f)}>
            {f === 'approaching' ? 'Approaching' : f === 'past' ? 'Past' : 'All'}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Subject (pseudonymised)</th>
                <th>Data element</th>
                <th>Purpose</th>
                <th>Basis</th>
                <th>Started</th>
                <th>Expiry</th>
                <th>Status</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: '0.75rem' }}>{r.subjectRef.slice(0, 16)}…</td>
                  <td>{r.dataElement ?? '—'}</td>
                  <td className="muted">{r.inventoryPurposeName ?? '—'}</td>
                  <td className="muted">{r.basis.replace(/_/g, ' ')}</td>
                  <td className="muted">{new Date(r.startAt).toLocaleDateString()}</td>
                  <td>
                    <span className={`badge ${isPast(r) ? 'denied' : 'warning'}`}>
                      {new Date(r.retentionEnd).toLocaleDateString()}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${r.status === 'reviewed' ? 'success' : 'neutral'}`}>{r.status}</span>
                  </td>
                  {canManage && (
                    <td>
                      {r.status === 'active' && (
                        <button type="button" disabled={busyId === r.id} onClick={() => void onReview(r)}>
                          Mark reviewed
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {records.length === 0 && (
                <tr>
                  <td colSpan={canManage ? 8 : 7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    Nothing {filter === 'all' ? 'tracked' : filter} right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
