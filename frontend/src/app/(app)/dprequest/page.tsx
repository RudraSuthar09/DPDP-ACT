'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  DPR_RIGHT_TYPES,
  DPR_RIGHT_TYPE_LABELS,
  REQUEST_STATUSES,
  type DprDeadlinePolicy,
  type DprRightType,
  type RequestStatus,
  type RequestTicket,
} from '@dpdp/shared';
import { apiFetch, ApiError, downloadFile } from '../../../lib/api';
import { slaBadgeClass, slaCountdownLabel, slaUrgency } from '../../../lib/sla';

interface TeamMember {
  userId: string;
  fullName: string;
  email: string;
}

interface DprListTicket extends RequestTicket {
  rightType: DprRightType | null;
  subjectRefResolved: boolean;
}

/** The short label for a table cell — the full option text on the public form
 *  carries the section reference, which is useful when a data principal is
 *  choosing and just noise in a queue of forty rows. */
const SHORT_LABELS: Record<DprRightType, string> = {
  access: 'Access',
  correction: 'Correction',
  erasure: 'Erasure',
  nomination: 'Nomination',
  portability: 'Portability',
  withdraw_consent: 'Withdraw consent',
};

/**
 * The DPR staff queue (FR-DPR-01/03/06) — against the real `/dprequest/tickets`
 * surface, which is the shared request substrate (`requestType=dprequest`) plus
 * the two facts the substrate deliberately does not know: which right is being
 * exercised, and whether a subject reference has been resolved for it.
 *
 * Deliberately the same shape as the Grievance inbox, down to the SLA badge
 * coming from the same `lib/sla` helpers — a DPO working both queues in one
 * shift should not have to learn two visual languages for "this is about to
 * breach". What differs is what the clock MEANS: a grievance's is an
 * organisational service level, a rights request's is a statutory deadline, and
 * the deadline strip above the table is there so nobody has to guess which
 * version of the rules the queue is being judged against.
 */
export default function DPRequestQueuePage() {
  const [tickets, setTickets] = useState<DprListTicket[]>([]);
  const [policies, setPolicies] = useState<DprDeadlinePolicy[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [rightType, setRightType] = useState<DprRightType | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  async function exportRegister() {
    setExporting(true);
    setError(null);
    try {
      // FR-DPR-06: the on-time-closure evidence export, generated fresh from
      // the register on every call — same discipline as the RoPA/grievance
      // exports, never a stored artefact that could go stale.
      await downloadFile('/dprequest/register/export', `dpr-register-${new Date().toISOString().slice(0, 10)}.pdf`, {
        method: 'POST',
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not export the register.');
    } finally {
      setExporting(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (status) params.set('status', status);
      // Right-type filtering IS server-side here, unlike Grievance's category —
      // the backend already filters on it, so there is no reason to fetch rows
      // only to hide them.
      if (rightType) params.set('rightType', rightType);
      const [ticketsRes, policiesRes, teamRes] = await Promise.all([
        apiFetch<{ tickets: DprListTicket[] }>(`/dprequest/tickets?${params.toString()}`),
        apiFetch<{ policies: DprDeadlinePolicy[] }>('/dprequest/deadline-policies'),
        apiFetch<TeamMember[]>('/users'),
      ]);
      setTickets(ticketsRes.tickets);
      setPolicies(policiesRes.policies);
      setTeam(teamRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the rights-request queue.');
    } finally {
      setLoading(false);
    }
  }, [status, rightType]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = (userId: string | null): string => {
    if (!userId) return '—';
    return team.find((m) => m.userId === userId)?.fullName ?? userId.slice(0, 8);
  };

  return (
    <div>
      <h1>Data Principal Requests</h1>
      <p className="muted">
        Rights requests filed through the public portal, tracked on the same request
        substrate as the Grievance Register. Each one waits on identity verification before it can
        be worked, and each carries the statutory deadline for the right it exercises.
      </p>

      <div className="toolbar">
        <div className="field">
          <label htmlFor="status-filter">Status</label>
          <select
            id="status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as RequestStatus | '')}
          >
            <option value="">All statuses</option>
            {REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="right-filter">Right</label>
          <select
            id="right-filter"
            value={rightType}
            onChange={(e) => setRightType(e.target.value as DprRightType | '')}
          >
            <option value="">All rights</option>
            {DPR_RIGHT_TYPES.map((r) => (
              <option key={r} value={r}>
                {SHORT_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          data-testid="export-register-btn"
          onClick={() => void exportRegister()}
          disabled={exporting}
        >
          {exporting ? 'Exporting…' : 'Export closure evidence (PDF)'}
        </button>
      </div>

      {/* The deadlines in force, and which VERSION says so. A number with no
          citation is what the versioned policy record exists to replace, so the
          screen that shows the clock shows the record too. */}
      {policies.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 18 }} data-testid="deadline-policies">
          <table>
            <thead>
              <tr>
                <th>Right</th>
                <th>Statutory deadline</th>
                <th>Policy in force</th>
                <th>Effective from</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.rightType} data-testid={`policy-${p.rightType}`}>
                  <td>{SHORT_LABELS[p.rightType]}</td>
                  <td>{p.isFallback ? <span className="muted">none in force</span> : `${p.slaDays} days`}</td>
                  <td>
                    <span className="badge neutral">
                      {p.isFallback ? 'unset' : `${p.policyKey} v${p.version}`}
                    </span>
                  </td>
                  <td>
                    {p.isFallback ? '—' : new Date(p.effectiveFrom).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && tickets.length === 0 ? (
        <p className="muted" data-testid="dpr-inbox-empty">
          No rights requests match this filter.
        </p>
      ) : (
        !loading && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Right</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Statutory deadline</th>
                  <th>Subject ref</th>
                  <th>Assignee</th>
                  <th>Escalation</th>
                </tr>
              </thead>
              <tbody data-testid="dpr-ticket-table">
                {tickets.map((t) => {
                  const closed = t.status === 'resolved' || t.status === 'closed';
                  const urgency = slaUrgency(t.slaDueAt, closed);
                  return (
                    <tr key={t.id} data-testid={`dpr-row-${t.referenceCode}`}>
                      <td>
                        <Link href={`/dprequest/${t.id}`} className="mono">
                          {t.referenceCode}
                        </Link>
                      </td>
                      <td data-testid={`dpr-right-${t.referenceCode}`}>
                        {t.rightType ? (
                          SHORT_LABELS[t.rightType]
                        ) : (
                          <span className="muted">Unknown</span>
                        )}
                      </td>
                      <td>{t.subject}</td>
                      <td>
                        <span className={`badge ${statusBadge(t.status)}`}>
                          {t.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td data-testid={`dpr-sla-${t.referenceCode}`}>
                        <span className={`badge ${slaBadgeClass(urgency)}`}>
                          {slaCountdownLabel(t.slaDueAt, closed)}
                        </span>
                        {t.slaDueAt && !closed && (
                          <div className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
                            by {new Date(t.slaDueAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td>
                        {/* Whether, never what. The resolved reference is a
                            64-hex digest; putting it in a queue would only
                            teach staff to copy identifiers around. */}
                        {t.subjectRefResolved ? (
                          <span className="badge success">resolved</span>
                        ) : (
                          <span className="muted">not resolved</span>
                        )}
                      </td>
                      <td>{nameFor(t.assignedTo)}</td>
                      <td>{t.escalationLevel > 0 ? `Level ${t.escalationLevel}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function statusBadge(status: RequestStatus): string {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'pending_identity_verification') return 'info';
  return 'neutral';
}
