'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  DPR_RIGHT_TYPE_LABELS,
  IDENTITY_VERIFICATION_OUTCOMES,
  type DprDeadlinePolicy,
  type DprRequestDetails,
  type IdentityVerificationOutcome,
  type RequestCorrespondenceEntry,
  type RequestStatus,
  type RequestStatusEvent,
  type RequestTicket,
} from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { slaBadgeClass, slaCountdownLabel, slaUrgency } from '../../../../lib/sla';
import { PersonalDataSummaryPanel } from '../../../../components/PersonalDataSummaryPanel';

const HANDLER_ROLES = new Set(['owner', 'dpo', 'compliance_officer', 'grievance_officer']);

interface DprDetail {
  ticket: RequestTicket;
  correspondence: RequestCorrespondenceEntry[];
  statusHistory: RequestStatusEvent[];
  identityVerification: {
    status: 'pending' | 'completed';
    outcome: string | null;
    reason: string | null;
    completedAt: string | null;
  } | null;
  timers: { level: number; rung: string; dueAt: string; status: string; firedAt: string | null }[];
  dpr: DprRequestDetails | null;
}

/**
 * One rights request (FR-DPR-01/02/03).
 *
 * The generic half — lifecycle, correspondence, escalation — is the substrate's
 * and is read from `/dprequest/tickets/:id`, which is `RequestService.detail`
 * plus DPR's own two fields. The two DPR-specific ACTIONS on this page are the
 * identity-verification verdict (shared with Grievance, on `/requests/*`) and
 * subject-reference resolution, which exists nowhere else in the product.
 */
export default function DPRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const canHandle = !!user && HANDLER_ROLES.has(user.role);

  const [detail, setDetail] = useState<DprDetail | null>(null);
  const [policy, setPolicy] = useState<DprDeadlinePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState('');
  const [resolveReason, setResolveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<IdentityVerificationOutcome>('matched');
  const [verifyReason, setVerifyReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<DprDetail>(`/dprequest/tickets/${id}`);
      setDetail(d);
      const { policies } = await apiFetch<{ policies: DprDeadlinePolicy[] }>(
        '/dprequest/deadline-policies',
      );
      setPolicy(policies.find((p) => p.rightType === d.dpr?.rightType) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this rights request.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error && !detail) return <div className="error">{error}</div>;
  if (!detail) return null;

  const { ticket, dpr } = detail;
  const closed = ticket.status === 'resolved' || ticket.status === 'closed';
  const urgency = slaUrgency(ticket.slaDueAt, closed);

  return (
    <div>
      <p>
        <Link href="/dprequest">← Data Principal Requests</Link>
      </p>

      <div className="portal-kicker">{ticket.referenceCode}</div>
      <h1>{ticket.subject}</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 4px' }}>
        <span className={`badge ${statusBadge(ticket.status)}`}>
          {ticket.status.replace(/_/g, ' ')}
        </span>
        <span className={`badge ${slaBadgeClass(urgency)}`} data-testid="dpr-detail-sla">
          {slaCountdownLabel(ticket.slaDueAt, closed)}
        </span>
        {dpr && (
          <span className="badge info" data-testid="dpr-detail-right">
            {DPR_RIGHT_TYPE_LABELS[dpr.rightType]}
          </span>
        )}
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        {ticket.contactChannel} · {ticket.contactValue} · filed{' '}
        {new Date(ticket.createdAt).toLocaleString()}
      </p>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* The clock, with its citation. "Due in 26d" is an assertion; "due in 26d
          under dprequest:access v1" is one a DPO can defend. */}
      <h2>Statutory deadline</h2>
      <p>
        {ticket.slaDueAt ? (
          <>
            Response due <strong>{new Date(ticket.slaDueAt).toLocaleString()}</strong>
            {policy && !policy.isFallback && (
              <>
                {' '}
                — {policy.slaDays} days under <span className="mono">{policy.policyKey}</span> v
                {policy.version}, effective{' '}
                {new Date(policy.effectiveFrom).toLocaleDateString()}.
              </>
            )}
          </>
        ) : (
          <span className="muted">
            The clock has not started. It starts when the requester proves their contact channel,
            not when they submit — an unverified submission is a claim, not a request.
          </span>
        )}
      </p>
      {detail.timers.length > 0 && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Escalation ladder:{' '}
          {detail.timers
            .map((t) => `L${t.level} ${t.rung} ${new Date(t.dueAt).toLocaleDateString()} (${t.status})`)
            .join(' · ')}
        </p>
      )}

      {/* FR-DPR-02. The only place in the product that accepts a raw customer
          id — and the copy says plainly what happens to it, because a verifier
          typing a real customer's identifier deserves to know. */}
      <h2>Subject reference</h2>
      {dpr?.subjectRef ? (
        <p data-testid="subject-ref-resolved">
          Resolved <strong>{new Date(dpr.subjectRefResolvedAt!).toLocaleString()}</strong> to{' '}
          <span className="mono">{dpr.subjectRef.slice(0, 24)}…</span> — matching{' '}
          {dpr.subjectRefMatchCount ?? 0} consent record(s).
        </p>
      ) : (
        <>
          <p className="muted">
            Enter this person&apos;s customer id from your own systems. It is hashed with your
            organisation&apos;s own secret to locate matching consent records, and the raw id is
            never stored on this platform and cannot be recovered from what is (I2).
          </p>
          {canHandle && (
            <form
              className="portal-form"
              data-testid="subject-ref-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const res = await apiFetch<{ subjectRef: string; matchCount: number }>(
                    `/dprequest/tickets/${id}/subject-reference`,
                    { method: 'POST', body: { customerId, reason: resolveReason } },
                  );
                  setCustomerId('');
                  setResolveReason('');
                  return `Resolved to ${res.subjectRef.slice(0, 16)}… (${res.matchCount} consent record(s)).`;
                });
              }}
            >
              <label htmlFor="customer-id">Customer id (in your systems)</label>
              <input
                id="customer-id"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                maxLength={200}
                required
              />
              <label htmlFor="resolve-reason">How you verified this is the same person</label>
              <textarea
                id="resolve-reason"
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                minLength={10}
                maxLength={1000}
                rows={3}
                required
              />
              <div className="portal-actions">
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Resolving…' : 'Resolve subject reference'}
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <h2>Identity verification</h2>
      {detail.identityVerification?.status === 'completed' ? (
        <p>
          <span className="badge success">{detail.identityVerification.outcome}</span>{' '}
          {detail.identityVerification.reason}
        </p>
      ) : ticket.status === 'pending_identity_verification' && canHandle ? (
        <form
          className="portal-form"
          data-testid="identity-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await apiFetch(`/requests/${id}/identity-verification`, {
                method: 'POST',
                body: { outcome, reason: verifyReason },
              });
              setVerifyReason('');
              return `Identity verification recorded as ${outcome}.`;
            });
          }}
        >
          <p className="muted">
            The platform proved the contact channel and can prove nothing further. Whether this is
            one of your data principals is a question only your records answer (FR-GRV-04).
          </p>
          <label htmlFor="outcome">Verdict</label>
          <select
            id="outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as IdentityVerificationOutcome)}
          >
            {IDENTITY_VERIFICATION_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <label htmlFor="verify-reason">Basis for this decision</label>
          <textarea
            id="verify-reason"
            value={verifyReason}
            onChange={(e) => setVerifyReason(e.target.value)}
            minLength={10}
            maxLength={1000}
            rows={3}
            required
          />
          <div className="portal-actions">
            <button className="primary" type="submit" disabled={busy}>
              {busy ? 'Recording…' : 'Record verdict'}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">No identity-verification task is open for this request.</p>
      )}

      {/* Tier 1/2 only make sense once there is a subject to assemble a summary
          FOR (FR-DPR-02) — the backend itself refuses to assemble one without
          a resolved subject_ref, so the panel is gated on the same fact here. */}
      {dpr?.subjectRef && <PersonalDataSummaryPanel ticketId={ticket.id} canHandle={canHandle} />}

      <h2>Correspondence</h2>
      {detail.correspondence.map((c) => (
        <div key={c.id} style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: '0.8rem' }}>
            {c.direction} · {c.authorLabel ?? c.authorType} ·{' '}
            {new Date(c.createdAt).toLocaleString()}
          </div>
          <div>{c.body}</div>
        </div>
      ))}

      <h2>Lifecycle</h2>
      <ul className="muted" style={{ fontSize: '0.85rem' }}>
        {detail.statusHistory.map((s, i) => (
          <li key={i}>
            {new Date(s.occurredAt).toLocaleString()} — {s.fromStatus} → {s.toStatus} ({s.reason})
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusBadge(status: RequestStatus): string {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'pending_identity_verification') return 'info';
  return 'neutral';
}
