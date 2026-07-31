'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_CATEGORY_LABELS,
  IDENTITY_VERIFICATION_OUTCOMES,
  type GrievanceCategory,
  type IdentityVerificationOutcome,
  type RequestEscalation,
  type RequestCorrespondenceEntry,
  type RequestSlaPolicy,
  type RequestStatus,
  type RequestStatusEvent,
  type RequestTicket,
} from '@dpdp/shared';
import { apiFetch, downloadFile, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { slaBadgeClass, slaCountdownLabel, slaUrgency } from '../../../../lib/sla';

const HANDLER_ROLES = new Set(['owner', 'dpo', 'compliance_officer', 'grievance_officer']);

/** Mirrors STAFF_TRANSITIONS in backend/src/modules/request/request.service.ts —
 *  kept here as data, same as the backend, so "what can follow what" is one
 *  table a reviewer of THIS file can read, without pretending the frontend
 *  enforces it (the backend still rejects anything this table gets wrong). */
const STAFF_TRANSITIONS: Record<'in_progress' | 'resolved' | 'closed', RequestStatus[]> = {
  in_progress: ['assigned', 'in_progress'],
  resolved: ['assigned', 'in_progress'],
  closed: ['pending_identity_verification', 'assigned', 'in_progress', 'resolved'],
};

interface TeamMember {
  userId: string;
  fullName: string;
  email: string;
  role: string;
}

interface TicketDetail {
  ticket: RequestTicket;
  correspondence: RequestCorrespondenceEntry[];
  statusHistory: RequestStatusEvent[];
  escalations: RequestEscalation[];
  identityVerification: {
    status: 'pending' | 'completed';
    outcome: string | null;
    reason: string | null;
    completedBy: string | null;
    completedAt: string | null;
  } | null;
  timers: { level: number; rung: string; dueAt: string; status: string; firedAt: string | null }[];
  category: GrievanceCategory | null;
}

export default function GrievanceTicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canHandle = !!user && HANDLER_ROLES.has(user.role);

  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [policy, setPolicy] = useState<RequestSlaPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, teamRes] = await Promise.all([
        apiFetch<TicketDetail>(`/grievance/tickets/${id}`),
        apiFetch<TeamMember[]>('/users'),
      ]);
      setDetail(d);
      setTeam(teamRes);
      const policies = await apiFetch<{ policies: RequestSlaPolicy[] }>('/requests/sla-policies');
      setPolicy(policies.policies.find((p) => p.requestType === d.ticket.requestType) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this request.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = useCallback(
    (userId: string | null): string => {
      if (!userId) return '—';
      return team.find((m) => m.userId === userId)?.fullName ?? userId.slice(0, 8);
    },
    [team],
  );

  const handlerStaff = useMemo(() => team.filter((m) => HANDLER_ROLES.has(m.role)), [team]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <div className="error">{error}</div>;
  if (!detail) return null;

  const { ticket } = detail;
  const closed = ticket.status === 'resolved' || ticket.status === 'closed';
  const urgency = slaUrgency(ticket.slaDueAt, closed);
  const atTopOfLadder = policy ? ticket.escalationLevel >= policy.ladder.length : false;

  return (
    <div>
      <p>
        <Link href="/grievance">← Grievance Register</Link>
      </p>

      <div className="portal-kicker">{ticket.referenceCode}</div>
      <h1>{ticket.subject}</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 4px' }}>
        <span className={`badge ${statusBadge(ticket.status)}`}>{ticket.status.replace(/_/g, ' ')}</span>
        <span className={`badge ${slaBadgeClass(urgency)}`}>{slaCountdownLabel(ticket.slaDueAt, closed)}</span>
        {ticket.escalationLevel > 0 && <span className="badge info">Escalation level {ticket.escalationLevel}</span>}
        <span className="badge neutral">
          {detail.category ? GRIEVANCE_CATEGORY_LABELS[detail.category] : 'Uncategorised'}
        </span>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {ticket.contactChannel} · {ticket.contactValue} · filed {new Date(ticket.createdAt).toLocaleString()}
        {ticket.assignedTo && <> · assigned to {nameFor(ticket.assignedTo)}</>}
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
        {canHandle && <CategoryControl ticketId={ticket.id} current={detail.category} onDone={load} />}
        {closed && <ResolutionExportButton ticketId={ticket.id} referenceCode={ticket.referenceCode} />}
      </div>

      {!canHandle && (
        <p className="notice">
          Your role ({user?.role}) can view this request but not act on it. Handling requires
          Owner, DPO, Compliance Officer, or Grievance Officer.
        </p>
      )}

      {canHandle && detail.identityVerification?.status === 'pending' && (
        <IdentityVerificationPanel ticketId={ticket.id} onDone={load} />
      )}

      <div className="panel" style={{ marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>Correspondence</h2>
        {detail.correspondence.length === 0 ? (
          <p className="muted">No correspondence yet.</p>
        ) : (
          <ol className="timeline">
            {detail.correspondence.map((c) => (
              <li key={c.id} className="timeline-item">
                <div className="muted" style={{ fontSize: '0.78rem' }}>
                  {directionLabel(c.direction, c.authorType, c.authorLabel, nameFor(c.authorUserId))} ·{' '}
                  {new Date(c.createdAt).toLocaleString()}
                </div>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </li>
            ))}
          </ol>
        )}
        {canHandle && <CorrespondenceForm ticketId={ticket.id} onDone={load} />}
      </div>

      {canHandle && (ticket.status === 'assigned' || ticket.status === 'in_progress') && (
        <AssignPanel ticketId={ticket.id} staff={handlerStaff} currentAssignee={ticket.assignedTo} onDone={load} />
      )}

      {canHandle && !closed && <StatusPanel ticketId={ticket.id} status={ticket.status} onDone={load} />}

      <div className="panel" style={{ marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>Escalation ladder</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          Grievance Officer → DPO → escalation contact. Climbed automatically as the SLA clock
          runs, or manually below (FR-GRV-05) — one ladder, two ways of reaching the next rung.
        </p>

        {detail.timers.length === 0 ? (
          <p className="muted">No SLA clock is running.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Rung</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.timers.map((t) => (
                  <tr key={t.level}>
                    <td>{t.level}</td>
                    <td>{t.rung.replace(/_/g, ' ')}</td>
                    <td>{new Date(t.dueAt).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${timerBadge(t.status)}`}>{t.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {detail.escalations.length > 0 && (
          <>
            <h3 style={{ marginTop: 16, fontSize: '0.95rem' }}>Reached so far</h3>
            <ul className="activity-list">
              {detail.escalations.map((e, i) => (
                <li key={i}>
                  <div className="activity-main">
                    Level {e.level} · {e.rung.replace(/_/g, ' ')} · {e.trigger.replace(/_/g, ' ')}
                    {e.notifiedContact && (
                      <div className="muted" style={{ fontSize: '0.8rem' }}>
                        Notified {e.notifiedContact} — {e.notifiedOk ? 'delivered' : 'not confirmed'}
                      </div>
                    )}
                    {e.reason && <div className="muted" style={{ fontSize: '0.8rem' }}>{e.reason}</div>}
                  </div>
                  <div className="activity-when">{new Date(e.occurredAt).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {canHandle && !closed && (
          <EscalateForm ticketId={ticket.id} disabled={atTopOfLadder} onDone={load} />
        )}
      </div>
    </div>
  );
}

// --- panels -------------------------------------------------------------

function CategoryControl({
  ticketId,
  current,
  onDone,
}: {
  ticketId: string;
  current: GrievanceCategory | null;
  onDone: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<GrievanceCategory>(current ?? 'other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/grievance/tickets/${ticketId}/category`, { method: 'POST', body: { category: value } });
      setEditing(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the category.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} data-testid="recategorise-open">
        {current ? 'Recategorise' : 'Set category'}
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <select
        value={value}
        onChange={(e) => setValue(e.target.value as GrievanceCategory)}
        style={{ width: 'auto' }}
        data-testid="recategorise-select"
      >
        {GRIEVANCE_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {GRIEVANCE_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <button className="primary" type="button" onClick={() => void onSave()} disabled={busy} data-testid="recategorise-save">
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" onClick={() => setEditing(false)} disabled={busy}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function ResolutionExportButton({ ticketId, referenceCode }: { ticketId: string; referenceCode: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDownload() {
    setBusy(true);
    setError(null);
    try {
      await downloadFile(
        `/grievance/tickets/${ticketId}/resolution-export`,
        `Grievance-Resolution-${referenceCode}.pdf`,
        { method: 'POST' },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the resolution export.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button type="button" onClick={() => void onDownload()} disabled={busy} data-testid="resolution-export">
        {busy ? 'Generating…' : 'Download resolution PDF (FR-GRV-06)'}
      </button>
      {error && <span className="error" style={{ marginLeft: 8 }}>{error}</span>}
    </span>
  );
}

function IdentityVerificationPanel({ ticketId, onDone }: { ticketId: string; onDone: () => Promise<void> }) {
  const [outcome, setOutcome] = useState<IdentityVerificationOutcome>('matched');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/requests/${ticketId}/identity-verification`, {
        method: 'POST',
        body: { outcome, reason },
      });
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the verification.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit} style={{ marginTop: 16 }} data-testid="identity-verification-form">
      <h2 style={{ marginTop: 0 }}>Identity verification (FR-GRV-04)</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        The platform proved the requester controls the contact channel above. It cannot tell you
        who they are — that is a lookup in your own customer records. Record what you found.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '10px 0' }}>
        {IDENTITY_VERIFICATION_OUTCOMES.map((o) => (
          <label key={o} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
            <input
              type="radio"
              name="outcome"
              value={o}
              checked={outcome === o}
              onChange={() => setOutcome(o)}
              style={{ width: 'auto' }}
            />
            {outcomeLabel(o)}
          </label>
        ))}
      </div>

      <label htmlFor="verification-reason">Basis for this verdict (min 10 characters)</label>
      <textarea
        id="verification-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        minLength={10}
        maxLength={1000}
        required
      />

      {error && <div className="error">{error}</div>}
      <div style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={busy || reason.trim().length < 10}>
          {busy ? 'Recording…' : 'Record verdict'}
        </button>
      </div>
    </form>
  );
}

function CorrespondenceForm({ ticketId, onDone }: { ticketId: string; onDone: () => Promise<void> }) {
  const [direction, setDirection] = useState<'outbound' | 'internal_note'>('outbound');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/requests/${ticketId}/correspondence`, { method: 'POST', body: { direction, body } });
      setBody('');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add correspondence.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 16 }} data-testid="correspondence-form">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 160 }}>
          <label htmlFor="corr-direction">Type</label>
          <select
            id="corr-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'outbound' | 'internal_note')}
          >
            <option value="outbound">Reply to requester</option>
            <option value="internal_note">Internal note</option>
          </select>
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <label htmlFor="corr-body">Message</label>
          <textarea id="corr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={10000} />
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ marginTop: 10 }}>
        <button className="primary" type="submit" disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : direction === 'outbound' ? 'Send to requester' : 'Add note'}
        </button>
      </div>
    </form>
  );
}

function AssignPanel({
  ticketId,
  staff,
  currentAssignee,
  onDone,
}: {
  ticketId: string;
  staff: TeamMember[];
  currentAssignee: string | null;
  onDone: () => Promise<void>;
}) {
  const [assigneeUserId, setAssigneeUserId] = useState(currentAssignee ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/requests/${ticketId}/assign`, {
        method: 'POST',
        body: { assigneeUserId, reason: reason.trim() },
      });
      setReason('');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reassign this request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit} style={{ marginTop: 16 }} data-testid="assign-form">
      <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Reassign</h2>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="assignee">Assignee</label>
          <select id="assignee" value={assigneeUserId} onChange={(e) => setAssigneeUserId(e.target.value)}>
            <option value="">Select…</option>
            {staff.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.fullName}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="assign-reason">Reason (min 5 characters)</label>
          <input id="assign-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={1000} />
        </div>
        <button type="submit" disabled={busy || !assigneeUserId || reason.trim().length < 5}>
          {busy ? 'Assigning…' : 'Reassign'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function StatusPanel({
  ticketId,
  status,
  onDone,
}: {
  ticketId: string;
  status: RequestStatus;
  onDone: () => Promise<void>;
}) {
  const [target, setTarget] = useState<'in_progress' | 'resolved' | 'closed' | ''>('');
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets: Array<'in_progress' | 'resolved' | 'closed'> = ['in_progress', 'resolved', 'closed'];
  const needsResolution = target === 'resolved' || target === 'closed';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/requests/${ticketId}/status`, {
        method: 'POST',
        body: {
          status: target,
          reason: reason.trim(),
          ...(needsResolution && resolution.trim() ? { resolution: resolution.trim() } : {}),
        },
      });
      setTarget('');
      setReason('');
      setResolution('');
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change status.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit} style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Update status</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {targets.map((t) => {
          const allowed = STAFF_TRANSITIONS[t].includes(status);
          return (
            <button
              key={t}
              type="button"
              className={target === t ? 'primary' : undefined}
              disabled={!allowed}
              onClick={() => setTarget(t)}
              data-testid={`status-${t}`}
            >
              {`Mark ${t.replace('_', ' ')}`}
            </button>
          );
        })}
      </div>

      {target && (
        <>
          <label htmlFor="status-reason">Reason (min 5 characters)</label>
          <input id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={1000} />

          {needsResolution && (
            <>
              <label htmlFor="status-resolution">Resolution summary (optional)</label>
              <textarea
                id="status-resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </>
          )}

          {error && <div className="error">{error}</div>}
          <div style={{ marginTop: 10 }}>
            <button className="primary" type="submit" disabled={busy || reason.trim().length < 5} data-testid="status-confirm">
              {busy ? 'Saving…' : `Confirm: mark ${target.replace('_', ' ')}`}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function EscalateForm({ ticketId, disabled, onDone }: { ticketId: string; disabled: boolean; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/requests/${ticketId}/escalate`, { method: 'POST', body: { reason: reason.trim() } });
      setReason('');
      setOpen(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not escalate this request.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button type="button" disabled={disabled} onClick={() => setOpen(true)} data-testid="escalate-now">
          {disabled ? 'Already at top of ladder' : 'Escalate now'}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 14 }} data-testid="escalate-form">
      <label htmlFor="escalate-reason">Reason for escalating now (min 10 characters)</label>
      <textarea
        id="escalate-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        minLength={10}
        maxLength={1000}
      />
      {error && <div className="error">{error}</div>}
      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
        <button className="primary" type="submit" disabled={busy || reason.trim().length < 10} data-testid="escalate-confirm">
          {busy ? 'Escalating…' : 'Confirm escalation'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- labels ---------------------------------------------------------------

function statusBadge(status: RequestStatus): string {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'pending_identity_verification') return 'info';
  return 'neutral';
}

function timerBadge(status: string): string {
  if (status === 'fired') return 'warning';
  if (status === 'cancelled') return 'neutral';
  return 'info';
}

function outcomeLabel(o: IdentityVerificationOutcome): string {
  if (o === 'matched') return 'Matched — this is our customer';
  if (o === 'not_matched') return 'Not matched — not our customer';
  return 'Inconclusive — cannot tell';
}

function directionLabel(
  direction: string,
  authorType: string,
  authorLabel: string | null,
  staffName: string,
): string {
  if (direction === 'internal_note') return `Internal note · ${staffName}`;
  if (authorType === 'public_submitter') return 'Requester';
  if (authorType === 'system') return 'System';
  return `Staff · ${staffName !== '—' ? staffName : (authorLabel ?? 'staff')}`;
}
