'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { PortalRequestView } from '@dpdp/shared';
import { portalFetch, PortalApiError } from '../../../../../lib/portal-api';
import { portalTokenKey } from '../../../../../lib/portal-session';

/**
 * The requester's own read of their ticket — strictly what `PortalRequestView`
 * hands back: no assignee, no internal notes, no escalation detail (see
 * `RequestPortalService.portalView`'s comment on why that filtering happens
 * server-side, not here).
 *
 * Gated by the portal token from OTP verification, held only in this tab's
 * `sessionStorage` (see PortalIntake). There is deliberately no way to reach
 * this screen from a reference code alone — the backend does not accept one,
 * and mirroring that refusal client-side (rather than showing a form that can
 * only ever fail) is the honest version of this page for a visitor who
 * followed a stale link or opened it in a new tab.
 */
export default function PortalStatusPage() {
  const params = useParams<{ slug: string; ticketId: string }>();
  const slug = params.slug;
  const ticketId = params.ticketId;

  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<PortalRequestView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    setToken(window.sessionStorage.getItem(portalTokenKey(ticketId)));
  }, [ticketId]);

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setView(
        await portalFetch<PortalRequestView>(`/portal/${slug}/requests/${ticketId}`, { portalToken: token }),
      );
    } catch (err) {
      setError(err instanceof PortalApiError ? err.message : 'Could not load this request.');
    } finally {
      setLoading(false);
    }
  }, [slug, ticketId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onReply(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !reply.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      await portalFetch(`/portal/${slug}/requests/${ticketId}/correspondence`, {
        method: 'POST',
        portalToken: token,
        body: { body: reply.trim() },
      });
      setReply('');
      await load();
    } catch (err) {
      setSendError(err instanceof PortalApiError ? err.message : 'Could not send your message.');
    } finally {
      setSending(false);
    }
  }

  if (token === null) {
    return (
      <div className="portal-wrap">
        <div className="portal-card">
          <h1>Verify your contact channel</h1>
          <p className="muted">
            We can&apos;t confirm this is your request in this browser. Submit a new request or
            complete the one-time code verification again — the link from that step brings you
            here with access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="portal-wrap">
      <div className="portal-card" style={{ maxWidth: 560 }}>
        {loading && <p className="muted">Loading…</p>}
        {error && <div className="error">{error}</div>}

        {view && (
          <>
            <div className="portal-kicker">Reference {view.referenceCode}</div>
            <h1>{view.subject}</h1>
            <span className={`badge ${statusBadge(view.status)}`}>{formatStatus(view.status)}</span>
            {view.slaDueAt && (
              <p className="muted" style={{ marginTop: 10, fontSize: '0.85rem' }}>
                Response due by {new Date(view.slaDueAt).toLocaleString()}.
              </p>
            )}

            <h2 style={{ marginTop: 24 }}>Correspondence</h2>
            {view.correspondence.length === 0 ? (
              <p className="muted">No messages yet.</p>
            ) : (
              <ol className="timeline">
                {view.correspondence.map((entry, i) => (
                  <li key={i} className="timeline-item">
                    <div className="muted" style={{ fontSize: '0.78rem' }}>
                      {entry.direction === 'inbound' ? 'You' : 'Organisation'} ·{' '}
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                    <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{entry.body}</div>
                  </li>
                ))}
              </ol>
            )}

            <form className="portal-form" onSubmit={onReply} style={{ marginTop: 20 }}>
              <label htmlFor="reply">Add to this request</label>
              <textarea
                id="reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                maxLength={10000}
              />
              {sendError && <div className="error">{sendError}</div>}
              <div className="portal-actions">
                <button className="primary" type="submit" disabled={sending || !reply.trim()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function statusBadge(status: string): string {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'pending_identity_verification') return 'info';
  return 'neutral';
}
