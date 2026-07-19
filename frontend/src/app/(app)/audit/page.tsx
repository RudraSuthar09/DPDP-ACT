'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, ApiError } from '../../../lib/api';

/**
 * The audit-log viewer — the first real screen, reading the hash-chained log from
 * Prompt 5 live (GET /audit). Every row is who/what/when/outcome. Filters (date
 * range + action type) narrow the fetched page client-side. "Verify chain" calls
 * GET /audit/verify to prove the log has not been tampered with.
 *
 * Proof of liveness: signing in writes audit entries (password_verified,
 * session_issued, …). Land here after login and they are already in the table;
 * press Refresh after any action to watch new ones appear.
 */
interface AuditEntry {
  id: string;
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: 'success' | 'denied' | 'error';
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
}

interface ChainReport {
  intact: boolean;
  entriesChecked: number;
  headHash: string | null;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [chain, setChain] = useState<ChainReport | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ entries: AuditEntry[] }>('/audit?limit=200');
      setEntries(res.entries);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Your role cannot read the audit log (Owner, DPO, or Auditor only).');
      } else {
        setError(err instanceof ApiError ? err.message : 'Failed to load the audit log.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function verifyChain() {
    setVerifying(true);
    try {
      setChain(await apiFetch<ChainReport>('/audit/verify'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Chain verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  // Distinct action types present, for the filter dropdown.
  const actionTypes = useMemo(
    () => Array.from(new Set(entries.map((e) => e.action))).sort(),
    [entries],
  );

  const filtered = useMemo(() => {
    const fromMs = from ? new Date(from).getTime() : null;
    // `to` is a date; include the whole day by pushing to its end.
    const toMs = to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 : null;
    return entries.filter((e) => {
      if (action && e.action !== action) return false;
      const t = new Date(e.occurredAt).getTime();
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t >= toMs) return false;
      return true;
    });
  }, [entries, action, from, to]);

  return (
    <div>
      <h1>Audit Log</h1>
      <p className="muted">
        Append-only, hash-chained record of every state change in this workspace (FR-AUD-03).
      </p>

      <div className="toolbar">
        <div className="field">
          <label>Action type</label>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All actions</option>
            {actionTypes.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button onClick={() => void verifyChain()} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify chain'}
        </button>
      </div>

      {chain && (
        <div className={chain.intact ? 'notice' : 'error'} style={{ marginBottom: 16 }}>
          {chain.intact
            ? `Chain intact — ${chain.entriesChecked} entr${chain.entriesChecked === 1 ? 'y' : 'ies'} verified.`
            : 'Chain BROKEN — the log has been tampered with.'}
          {chain.headHash && (
            <>
              {' '}
              Head hash <span className="mono">{chain.headHash.slice(0, 16)}…</span>
            </>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {!error && (
        <>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Showing {filtered.length} of {entries.length} loaded entries.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Target</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.seq}</td>
                    <td>{new Date(e.occurredAt).toLocaleString()}</td>
                    <td>{who(e)}</td>
                    <td className="mono">{e.action}</td>
                    <td>
                      <span className={`badge ${e.outcome}`}>{e.outcome}</span>
                    </td>
                    <td>
                      {e.targetType ? (
                        <>
                          {e.targetType}
                          {e.targetId && (
                            <>
                              {' '}
                              <span className="mono muted">{e.targetId.slice(0, 8)}…</span>
                            </>
                          )}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{e.reason ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
                {filtered.length === 0 && !loading && (
                  <tr>
                    <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                      No entries match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** "Who" — the human label if we have one, else the actor's id, else the system. */
function who(e: AuditEntry): React.ReactNode {
  if (e.actorLabel) return e.actorLabel;
  if (e.actorId) return <span className="mono">{e.actorId.slice(0, 8)}…</span>;
  return <span className="muted">system</span>;
}
