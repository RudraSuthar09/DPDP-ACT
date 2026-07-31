'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_CATEGORY_LABELS,
  REQUEST_STATUSES,
  type GrievanceCategory,
  type RequestStatus,
  type RequestTicket,
} from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../lib/api';
import { slaBadgeClass, slaCountdownLabel, slaUrgency } from '../../../lib/sla';

interface TeamMember {
  userId: string;
  fullName: string;
  email: string;
}

interface GrievanceListTicket extends RequestTicket {
  category: GrievanceCategory | null;
}

/**
 * The staff inbox (FR-GRV-02/06) — against the real `/grievance/tickets`
 * surface, which is the shared request substrate (`requestType=grievance`)
 * plus the one grievance-specific fact the substrate deliberately does not
 * know: category. See `backend/src/modules/grievance/grievance.controller.ts`.
 */
export default function GrievanceInboxPage() {
  const [tickets, setTickets] = useState<GrievanceListTicket[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [category, setCategory] = useState<GrievanceCategory | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (status) params.set('status', status);
      const [ticketsRes, teamRes] = await Promise.all([
        apiFetch<{ tickets: GrievanceListTicket[] }>(`/grievance/tickets?${params.toString()}`),
        apiFetch<TeamMember[]>('/users'),
      ]);
      setTickets(ticketsRes.tickets);
      setTeam(teamRes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the grievance inbox.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = (userId: string | null): string => {
    if (!userId) return '—';
    return team.find((m) => m.userId === userId)?.fullName ?? userId.slice(0, 8);
  };

  // Category has no server-side filter (the list is already small enough per
  // tenant that a second round trip isn't worth it) — filtered client-side
  // over the already-fetched, already-categorised rows.
  const visibleTickets = useMemo(
    () => (category ? tickets.filter((t) => t.category === category) : tickets),
    [tickets, category],
  );

  return (
    <div>
      <h1>Grievance Register</h1>
      <p className="muted">
        Complaints filed through the public portal (FR-GRV-01), tracked on the shared request
        substrate. Each ticket waits on identity verification before it can be worked (FR-GRV-04).
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
          <label htmlFor="category-filter">Category</label>
          <select
            id="category-filter"
            value={category}
            onChange={(e) => setCategory(e.target.value as GrievanceCategory | '')}
          >
            <option value="">All categories</option>
            {GRIEVANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {GRIEVANCE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {loading && <p className="muted">Loading…</p>}

      {!loading && visibleTickets.length === 0 ? (
        <p className="muted" data-testid="inbox-empty">
          No tickets match this filter.
        </p>
      ) : (
        !loading && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Subject</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>SLA</th>
                  <th>Assignee</th>
                  <th>Escalation</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody data-testid="ticket-table">
                {visibleTickets.map((t) => {
                  const closed = t.status === 'resolved' || t.status === 'closed';
                  const urgency = slaUrgency(t.slaDueAt, closed);
                  return (
                    <tr key={t.id} data-testid={`ticket-row-${t.referenceCode}`}>
                      <td>
                        <Link href={`/grievance/${t.id}`} className="mono">
                          {t.referenceCode}
                        </Link>
                      </td>
                      <td>{t.subject}</td>
                      <td>{t.category ? GRIEVANCE_CATEGORY_LABELS[t.category] : <span className="muted">Uncategorised</span>}</td>
                      <td>
                        <span className={`badge ${statusBadge(t.status)}`}>
                          {t.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${slaBadgeClass(urgency)}`}>
                          {slaCountdownLabel(t.slaDueAt, closed)}
                        </span>
                      </td>
                      <td>{nameFor(t.assignedTo)}</td>
                      <td>{t.escalationLevel > 0 ? `Level ${t.escalationLevel}` : '—'}</td>
                      <td>{new Date(t.createdAt).toLocaleDateString()}</td>
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
  if (status === 'created' || status === 'contact_verified') return 'neutral';
  return 'neutral';
}
