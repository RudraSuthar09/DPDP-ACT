'use client';

import { Fragment, useState } from 'react';
import type { FulfilmentOutcome, FulfilmentRecord, PersonalDataSummary } from '@dpdp/shared';
import { apiFetch, ApiError } from '../lib/api';

/**
 * FR-DPR-04/05/07 — the two-tier Personal Data Summary, wired to Prompt 32's
 * real API. No mocked data: every field below is read verbatim off
 * `PersonalDataSummary` / `FulfilmentOutcome` as the backend returns them.
 *
 * TIER 1 renders `summary` once assembled and never mutates it — the whole
 * point of Tier 1 is that it is derived, not stored, so this component treats
 * it as a read-only snapshot of one POST.
 *
 * TIER 2 is where the discipline matters most. `lastValues` holds whatever a
 * `relay`-mode fulfilment returned, and it exists ONLY so the screen can show
 * it ONE TIME. It is cleared the moment the requester dismisses it or
 * navigates on — never re-fetched, never left sitting in state after this
 * component unmounts (React discards component state on unmount by design;
 * nothing here persists it anywhere else, and no effect re-derives it from a
 * server that also does not store it — see FulfilmentService's header on the
 * backend for why there is nothing to re-fetch).
 */
export function PersonalDataSummaryPanel({
  ticketId,
  canHandle,
}: {
  ticketId: string;
  canHandle: boolean;
}) {
  const [summary, setSummary] = useState<PersonalDataSummary | null>(null);
  const [fulfilments, setFulfilments] = useState<FulfilmentRecord[]>([]);
  const [lastOutcome, setLastOutcome] = useState<FulfilmentOutcome | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadFulfilments() {
    const res = await apiFetch<{ fulfilments: FulfilmentRecord[] }>(`/dprequest/tickets/${ticketId}/fulfilments`);
    setFulfilments(res.fulfilments);
  }

  async function assembleSummary() {
    setBusy('summary');
    setError(null);
    try {
      const res = await apiFetch<PersonalDataSummary>(
        `/dprequest/tickets/${ticketId}/personal-data-summary`,
        { method: 'POST' },
      );
      setSummary(res);
      await loadFulfilments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not assemble the summary.');
    } finally {
      setBusy(null);
    }
  }

  async function runFulfilment(kind: 'values' | 'correction' | 'erasure') {
    setBusy(kind);
    setError(null);
    // Any PREVIOUS relayed values are dropped the instant a new call starts —
    // never carried alongside a second, unrelated round trip.
    setLastOutcome(null);
    try {
      const res = await apiFetch<FulfilmentOutcome>(`/dprequest/tickets/${ticketId}/fulfilment/${kind}`, {
        method: 'POST',
      });
      setLastOutcome(res);
      await loadFulfilments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The fulfilment call did not complete.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="personal-data-summary-panel">
      <h2>Personal Data Summary</h2>

      {error && <div className="error">{error}</div>}

      {canHandle && (
        <div className="portal-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="primary"
            data-testid="assemble-summary-btn"
            onClick={() => void assembleSummary()}
            disabled={busy !== null}
          >
            {busy === 'summary' ? 'Assembling…' : summary ? 'Re-assemble summary' : 'Assemble summary (Tier 1)'}
          </button>
        </div>
      )}

      {!summary && (
        <p className="muted">
          Not yet assembled. Tier 1 is derived fresh from the Data Inventory, the Consent Register
          and this tenant&apos;s own request history on every call — nothing about this person is
          stored between requests.
        </p>
      )}

      {summary && (
        <>
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Generated {new Date(summary.generatedAt).toLocaleString()} for subject{' '}
            <span className="mono">{summary.subjectRef.slice(0, 24)}…</span>
          </p>

          <h3>Data categories held</h3>
          {summary.dataCategories.length === 0 ? (
            <p className="muted" data-testid="no-data-categories">
              No inventory entries are currently attributed to this person.
            </p>
          ) : (
            <div className="table-wrap" data-testid="data-categories-table">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Storage location</th>
                    <th>Purpose</th>
                    <th>Legal basis</th>
                    <th>Retention</th>
                    <th>Systems</th>
                    <th>Vendors</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.dataCategories.map((cat) => (
                    <Fragment key={cat.entryId}>
                      {cat.purposes.map((p, i) => (
                        <tr key={`${cat.entryId}-${i}`} data-testid={`category-row-${cat.entryId}`}>
                          {i === 0 && (
                            <>
                              <td rowSpan={cat.purposes.length}>
                                {cat.category}
                                {cat.description && (
                                  <div className="muted" style={{ fontSize: '0.78rem' }}>
                                    {cat.description}
                                  </div>
                                )}
                              </td>
                              <td rowSpan={cat.purposes.length}>{cat.storageLocation}</td>
                            </>
                          )}
                          <td>
                            {p.purposeName}
                            <div className="muted" style={{ fontSize: '0.75rem' }}>
                              via {p.viaConsentPurposes.join(', ')}
                            </div>
                          </td>
                          <td>
                            {p.legalBasis.replace(/_/g, ' ')}
                            {p.legalBasisNote && (
                              <div className="muted" style={{ fontSize: '0.75rem' }}>
                                {p.legalBasisNote}
                              </div>
                            )}
                          </td>
                          <td>{p.retentionPeriod}</td>
                          {i === 0 && (
                            <>
                              <td rowSpan={cat.purposes.length}>
                                {cat.systems.map((s) => s.name).join(', ') || '—'}
                              </td>
                              <td rowSpan={cat.purposes.length}>
                                {cat.vendors.map((v) => v.name).join(', ') || '—'}
                              </td>
                            </>
                          )}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* The honesty section — a gap in the tenant's own mapping, shown
              plainly rather than folded into "no data categories". */}
          {summary.unattributedConsentPurposes.length > 0 && (
            <p className="notice" data-testid="unattributed-purposes">
              <strong>Unattributed:</strong> this person has consent history for{' '}
              {summary.unattributedConsentPurposes.map((p) => `"${p.purposeName}"`).join(', ')}, which
              {summary.unattributedConsentPurposes.length === 1 ? ' has' : ' have'} not yet been mapped
              to a data inventory purpose. This does not mean no data is held for it — it means the
              mapping has not been made yet.
            </p>
          )}
          {summary.unrelatedEntryCount > 0 && (
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              This organisation also holds {summary.unrelatedEntryCount} other data element(s) unrelated
              to any consent this person has given.
            </p>
          )}

          <h3>Consent history</h3>
          <div className="table-wrap" data-testid="consent-history-table">
            <table>
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th>Status</th>
                  <th>Occurred</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {summary.consentHistory.map((c, i) => (
                  <tr key={i} data-testid={`consent-event-${i}`}>
                    <td>{c.purposeName ?? c.purposeId}</td>
                    <td>
                      {/* Withdrawn consents render exactly like any other status
                          — never filtered out, never re-labelled. A withdrawn
                          consent is still evidence that processing happened. */}
                      <span className={`badge ${c.status === 'WITHDRAWN' ? 'warning' : 'success'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td>{new Date(c.occurredAt).toLocaleString()}</td>
                    <td>{c.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Prior requests</h3>
          {summary.requestHistory.length === 0 ? (
            <p className="muted">No prior rights requests from this person.</p>
          ) : (
            <ul className="muted" style={{ fontSize: '0.85rem' }}>
              {summary.requestHistory.map((r) => (
                <li key={r.referenceCode}>
                  {r.referenceCode} — {r.rightType ?? 'unknown'} — {r.status}
                  {r.closedOnTime !== null && (
                    <> — {r.closedOnTime ? 'closed on time' : 'closed late'}</>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* --- Tier 2 ------------------------------------------------------ */}
          <h2>Fulfilment (Tier 2)</h2>
          <p className="muted">
            The platform holds no customer values. Requesting values asks the tenant&apos;s own
            system for them over a signed channel; the tenant may return a secure link (values never
            enter this platform) or relay the values through it once, for display only.
          </p>

          {canHandle && (
            <div className="portal-actions" style={{ marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => void runFulfilment('values')}
                disabled={busy !== null}
                data-testid="request-values-btn"
              >
                {busy === 'values' ? 'Requesting…' : 'Request data values'}
              </button>
              {summary.rightType === 'correction' && (
                <button
                  type="button"
                  onClick={() => void runFulfilment('correction')}
                  disabled={busy !== null}
                  data-testid="request-correction-btn"
                >
                  {busy === 'correction' ? 'Requesting…' : 'Request correction'}
                </button>
              )}
              {summary.rightType === 'erasure' && (
                <button
                  type="button"
                  onClick={() => void runFulfilment('erasure')}
                  disabled={busy !== null}
                  data-testid="request-erasure-btn"
                >
                  {busy === 'erasure' ? 'Requesting…' : 'Request erasure'}
                </button>
              )}
            </div>
          )}

          {lastOutcome && (
            <div className="notice" data-testid="fulfilment-outcome">
              {lastOutcome.responseKind === 'link' && lastOutcome.url && (
                <>
                  <strong>Secure link received.</strong> The tenant&apos;s system returned a one-time
                  link — the values themselves never reached this platform.{' '}
                  <a href={lastOutcome.url} target="_blank" rel="noreferrer">
                    Open the secure link
                  </a>
                  {lastOutcome.linkExpiresAt && (
                    <> (expires {new Date(lastOutcome.linkExpiresAt).toLocaleString()})</>
                  )}
                  .
                </>
              )}
              {lastOutcome.responseKind === 'relay' && (
                <>
                  <strong>Relayed for display below.</strong> These values passed through the
                  platform once and are shown here only — dismiss this panel and they are gone from
                  this screen; the platform never wrote them anywhere.
                  <RelayValues data={lastOutcome.data} onDismiss={() => setLastOutcome(null)} />
                </>
              )}
              {lastOutcome.responseKind === 'confirmation' && (
                <>
                  <strong>Confirmed.</strong> The tenant&apos;s system reported{' '}
                  {lastOutcome.status} at{' '}
                  {lastOutcome.confirmedAt ? new Date(lastOutcome.confirmedAt).toLocaleString() : '—'}.
                  No content was returned — only the confirmation and the timestamp.
                </>
              )}
              {lastOutcome.status === 'failed' && (
                <>
                  <strong>Failed.</strong> {lastOutcome.failureReason ?? 'The client system did not respond.'}
                </>
              )}
            </div>
          )}

          <h3>Fulfilment history</h3>
          {fulfilments.length === 0 ? (
            <p className="muted">No fulfilment calls have been made for this request.</p>
          ) : (
            <div className="table-wrap" data-testid="fulfilment-history-table">
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>Response</th>
                    <th>Requested</th>
                    <th>Confirmed</th>
                  </tr>
                </thead>
                <tbody>
                  {fulfilments.map((f) => (
                    <tr key={f.id} data-testid={`fulfilment-row-${f.id}`}>
                      <td>{f.kind.replace(/_/g, ' ')}</td>
                      <td>
                        <span
                          className={`badge ${
                            f.status === 'confirmed' ? 'success' : f.status === 'failed' ? 'denied' : 'neutral'
                          }`}
                        >
                          {/* requested -> client notified -> client responded -> relayed,
                              collapsed onto the one status column the API returns. */}
                          {f.status === 'pending' ? 'requested → awaiting client' : f.status}
                        </span>
                      </td>
                      <td>{f.responseKind ?? '—'}</td>
                      <td>{new Date(f.requestedAt).toLocaleString()}</td>
                      <td>{f.confirmedAt ? new Date(f.confirmedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Renders relayed values for exactly as long as this element is mounted.
 * `onDismiss` is the only way this data leaves view — there is no timer, no
 * localStorage, no second component that remembers it after this one is gone.
 */
function RelayValues({ data, onDismiss }: { data: unknown; onDismiss: () => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <pre
        data-testid="relayed-values"
        style={{ background: 'var(--surface-2, #f4f4f4)', padding: 10, borderRadius: 6, overflowX: 'auto' }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
      <button type="button" onClick={onDismiss} data-testid="dismiss-relayed-values">
        Dismiss
      </button>
    </div>
  );
}
