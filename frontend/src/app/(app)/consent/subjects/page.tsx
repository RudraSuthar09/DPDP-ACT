'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConsentEventRecord, ConsentStatus, ConsentStatusAsOf } from '@dpdp/shared';
import { apiFetch, downloadFile, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { NoticeViewer, type NoticeTranslation } from '../../../../components/NoticeViewer';

const WITHDRAW_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * One data principal's consent history (FR-CON-05/08), against the real
 * Prompt 20 endpoints:
 *
 *   POST /consent/subject-ref                                → the HMAC'd reference
 *   GET  /consent/subjects/:subjectRef/history?asOf=&knownAs= → the bitemporal read
 *
 * Two things this screen exists to get right.
 *
 * 1. The raw customer id is typed once and POSTed once, in a body. It is never
 *    put in a URL, a query string, or a route param — the derived reference is
 *    what travels from that point on. A raw customer id in a URL would sit in
 *    access logs and proxy logs indefinitely, quietly undoing the
 *    pseudonymisation it exists to provide (I2).
 *
 * 2. `asOf` and `knownAs` are two INDEPENDENT clocks and are presented as two
 *    independent questions. `asOf` bounds valid time (when it happened);
 *    `knownAs` bounds transaction time (when we learned of it). Conflating them
 *    — one "date" control feeding both — would silently answer whichever
 *    question the implementer happened to have in mind, and bitemporal storage
 *    would be pointless. See the composed sentence under the two controls: it
 *    always spells out, in English, which question is currently being asked.
 */

interface SubjectHistoryResponse {
  subjectRef: string;
  /** Echoed back resolved — both default to now server-side. */
  asOf: string;
  knownAs: string;
  events: ConsentEventRecord[];
  statusAsOf: ConsentStatusAsOf[];
}

interface NoticeVersion {
  id: string;
  purposeId: string;
  versionNumber: number;
  createdAt: string;
  translations: NoticeTranslation[];
}

export default function SubjectConsentHistoryPage() {
  const { user } = useAuth();
  const canWithdraw = !!user && WITHDRAW_ROLES.has(user.role);

  // The raw identifier lives only in this input's state, and only until it is
  // exchanged for a reference. It is never written to the URL or to storage.
  const [customerId, setCustomerId] = useState('');
  const [subjectRef, setSubjectRef] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // The two clocks. Empty string = "now" (the server's default).
  const [asOf, setAsOf] = useState('');
  const [knownAs, setKnownAs] = useState('');

  const [history, setHistory] = useState<SubjectHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `null` records a version we tried and could not resolve, so the prefetch
  // below never retries it forever (a failed id would otherwise stay "missing").
  const [notices, setNotices] = useState<Record<string, NoticeVersion | null>>({});
  const [expandedNotice, setExpandedNotice] = useState<string | null>(null);

  async function onLookup(e: React.FormEvent) {
    e.preventDefault();
    const raw = customerId.trim();
    if (!raw) return;

    setDeriving(true);
    setLookupError(null);
    setError(null);
    setHistory(null);
    try {
      // POST, not GET: the identifier belongs in a body, never a query string.
      const res = await apiFetch<{ subjectRef: string }>('/consent/subject-ref', {
        method: 'POST',
        body: { customerId: raw },
      });
      setSubjectRef(res.subjectRef);
    } catch (err) {
      setSubjectRef(null);
      setLookupError(
        err instanceof ApiError ? err.message : 'Could not derive a subject reference.',
      );
    } finally {
      setDeriving(false);
    }
  }

  const load = useCallback(async () => {
    if (!subjectRef) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (asOf) params.set('asOf', endOfDayIso(asOf));
      if (knownAs) params.set('knownAs', endOfDayIso(knownAs));
      const query = params.toString();
      // Only the derived reference is in this URL — never the customer id.
      setHistory(
        await apiFetch<SubjectHistoryResponse>(
          `/consent/subjects/${subjectRef}/history${query ? `?${query}` : ''}`,
        ),
      );
    } catch (err) {
      setHistory(null);
      setError(err instanceof ApiError ? err.message : 'Failed to load this consent history.');
    } finally {
      setLoading(false);
    }
  }, [subjectRef, asOf, knownAs]);

  // Re-runs when either clock moves — moving one clock is the whole interaction.
  useEffect(() => {
    void load();
  }, [load]);

  // Withdrawal (FR-CON-06): tracked per purpose so one in-flight withdrawal
  // doesn't disable every button on the page.
  const [withdrawingPurpose, setWithdrawingPurpose] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  async function onWithdraw(purposeId: string, purposeName: string | null) {
    if (!subjectRef) return;
    if (!window.confirm(`Withdraw consent for "${purposeName ?? purposeId}"? This writes a new WITHDRAWN event — the grant it revokes is never removed.`)) {
      return;
    }
    const reason = window.prompt('Reason for this withdrawal (optional, kept as evidence):') ?? '';
    setWithdrawingPurpose(purposeId);
    setWithdrawError(null);
    try {
      await apiFetch(`/consent/subjects/${subjectRef}/purposes/${purposeId}/withdraw`, {
        method: 'POST',
        body: { reason: reason.trim() || null },
      });
      await load();
    } catch (err) {
      setWithdrawError(err instanceof ApiError ? err.message : 'Could not withdraw consent.');
    } finally {
      setWithdrawingPurpose(null);
    }
  }

  // Proof of consent (FR-CON-08): purpose picker plus a date that defaults to
  // whatever "as of" clock is already on screen, so the common case — "the
  // certificate for what I'm already looking at" — needs no extra input.
  const purposeOptions = useMemo(() => {
    const byId = new Map<string, string | null>();
    for (const s of history?.statusAsOf ?? []) byId.set(s.purposeId, s.purposeName);
    for (const e of history?.events ?? []) if (!byId.has(e.purposeId)) byId.set(e.purposeId, e.purposeName);
    return Array.from(byId, ([purposeId, purposeName]) => ({ purposeId, purposeName }));
  }, [history]);

  const [proofPurposeId, setProofPurposeId] = useState('');
  const [proofDate, setProofDate] = useState('');
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);

  useEffect(() => {
    if (!proofPurposeId && purposeOptions.length > 0) {
      setProofPurposeId(purposeOptions[0]!.purposeId);
    }
  }, [purposeOptions, proofPurposeId]);

  async function onDownloadProof() {
    if (!subjectRef || !proofPurposeId) return;
    setProofBusy(true);
    setProofError(null);
    try {
      const effectiveDate = proofDate || asOf;
      const params = new URLSearchParams();
      if (effectiveDate) params.set('asOf', endOfDayIso(effectiveDate));
      const query = params.toString();
      await downloadFile(
        `/consent/subjects/${subjectRef}/purposes/${proofPurposeId}/proof-of-consent${query ? `?${query}` : ''}`,
        `proof-of-consent-${subjectRef.slice(0, 8)}-${effectiveDate || 'now'}.pdf`,
        { method: 'POST' },
      );
    } catch (err) {
      setProofError(err instanceof ApiError ? err.message : 'Could not generate the proof-of-consent PDF.');
    } finally {
      setProofBusy(false);
    }
  }

  // Resolve every distinct notice version the timeline references (Prompt 19),
  // so each event can name the exact version shown and link through to its text.
  const noticeIds = useMemo(
    () =>
      Array.from(
        new Set(
          (history?.events ?? [])
            .map((e) => e.noticeVersionId)
            .filter((id): id is string => id !== null),
        ),
      ),
    [history],
  );

  useEffect(() => {
    const missing = noticeIds.filter((id) => !(id in notices));
    if (missing.length === 0) return;
    let cancelled = false;
    // One request for every distinct version this timeline references, not one
    // per version — a subject with a long history across several purposes'
    // notice revisions used to mean a request (and, cross-origin, a CORS
    // preflight alongside each) per version.
    void apiFetch<{ notices: NoticeVersion[] }>(`/consent/notices?ids=${missing.join(',')}`)
      .then((res) => new Map(res.notices.map((n) => [n.id, n] as const)))
      .catch(() => new Map<string, NoticeVersion>())
      .then((found) => {
        if (cancelled) return;
        setNotices((prev) => {
          const next = { ...prev };
          for (const id of missing) next[id] = found.get(id) ?? null;
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [noticeIds, notices]);

  const clocksAtNow = !asOf && !knownAs;

  return (
    <div>
      <h1>Subject consent history</h1>
      <p className="muted">
        One data principal&apos;s complete consent record (FR-CON-05/08). The log is append-only: a
        withdrawal is a <strong>new entry alongside</strong> the grant it revokes — the grant is
        never overwritten or removed, which is the only reason the question &ldquo;what was true on
        3rd March?&rdquo; stays answerable.
      </p>

      <form className="panel" onSubmit={onLookup} style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Look up a subject</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          Your own system&apos;s customer or subject identifier. It is sent once, in the body of a
          POST, and hashed with this workspace&apos;s own secret. It never appears in a URL, a query
          string, or a log — only the derived reference below does, and that reference cannot be
          reversed back to the identifier by this platform (I2).
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 280px' }}>
            <label htmlFor="customer-id">Customer / subject identifier</label>
            <input
              id="customer-id"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="e.g. CUST-10482"
              autoComplete="off"
            />
          </div>
          <button className="primary" type="submit" disabled={deriving || !customerId.trim()}>
            {deriving ? 'Deriving…' : 'Look up'}
          </button>
        </div>

        {lookupError && <div className="error">{lookupError}</div>}

        {subjectRef && (
          <div style={{ marginTop: 14 }}>
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              Subject reference (derived server-side)
            </div>
            <div className="mono" data-testid="subject-ref">
              {subjectRef}
            </div>
          </div>
        )}
      </form>

      {subjectRef && (
        <>
          <div className="clock-grid">
            <div className="clock-card">
              <div className="clock-kicker">Valid time · occurred_at</div>
              <label htmlFor="as-of">As of — what was true then</label>
              <input
                id="as-of"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
              <p className="clock-help">
                Includes everything that <strong>happened</strong> up to the end of this day, judged
                with everything we know <em>today</em> — including corrections filed since. Leave
                empty for now.
              </p>
            </div>

            <div className="clock-card">
              <div className="clock-kicker">Transaction time · recorded_at</div>
              <label htmlFor="known-as">Known as of — what we knew by then</label>
              <input
                id="known-as"
                type="date"
                value={knownAs}
                onChange={(e) => setKnownAs(e.target.value)}
              />
              <p className="clock-help">
                Ignores anything <strong>recorded</strong> after the end of this day. This is the
                regulator&apos;s question: what could you honestly have said on that date? Leave
                empty for now.
              </p>
            </div>
          </div>

          <div className="clock-question" data-testid="clock-question">
            {questionSentence(asOf, knownAs)}
            {!clocksAtNow && (
              <button
                type="button"
                style={{ marginLeft: 12 }}
                onClick={() => {
                  setAsOf('');
                  setKnownAs('');
                }}
              >
                Reset both clocks to now
              </button>
            )}
          </div>

          {error && <div className="error">{error}</div>}
          {loading && <p className="muted">Loading…</p>}

          {history && !loading && (
            <>
              <h2 style={{ marginTop: 24 }}>Status at this point</h2>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
                Derived from the events below every time it is asked — there is no stored status
                column to read, which is exactly why a past answer is still recoverable.
              </p>
              {withdrawError && <div className="error">{withdrawError}</div>}

              {history.statusAsOf.length === 0 ? (
                <p className="muted" data-testid="status-empty">
                  No consent status for this subject at this point in both clocks.
                </p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Purpose</th>
                        <th>Status</th>
                        <th>From the event that happened</th>
                        <th>…which we recorded</th>
                        {canWithdraw && <th></th>}
                      </tr>
                    </thead>
                    <tbody data-testid="status-table">
                      {history.statusAsOf.map((s) => (
                        <tr key={s.purposeId}>
                          <td>
                            <Link href={`/consent/purposes/${s.purposeId}`}>
                              {s.purposeName ?? s.purposeId}
                            </Link>
                          </td>
                          <td>
                            <span className={`badge ${statusBadge(s.status)}`}>{s.status}</span>
                          </td>
                          <td>{new Date(s.occurredAt).toLocaleString()}</td>
                          <td className="muted">{new Date(s.recordedAt).toLocaleString()}</td>
                          {canWithdraw && (
                            <td>
                              {s.status === 'GRANTED' && clocksAtNow && (
                                <button
                                  type="button"
                                  data-testid={`withdraw-${s.purposeId}`}
                                  disabled={withdrawingPurpose === s.purposeId}
                                  onClick={() => void onWithdraw(s.purposeId, s.purposeName)}
                                >
                                  {withdrawingPurpose === s.purposeId ? 'Withdrawing…' : 'Withdraw'}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="panel" style={{ marginTop: 20 }}>
                <h2 style={{ marginTop: 0 }}>Download proof of consent</h2>
                <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
                  A certificate for one purpose showing status and the exact notice text and version
                  shown at that time (FR-CON-08).
                </p>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <label htmlFor="proof-purpose">Purpose</label>
                    <select
                      id="proof-purpose"
                      value={proofPurposeId}
                      onChange={(e) => setProofPurposeId(e.target.value)}
                    >
                      {purposeOptions.map((p) => (
                        <option key={p.purposeId} value={p.purposeId}>
                          {p.purposeName ?? p.purposeId}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="proof-date">As of date</label>
                    <input
                      id="proof-date"
                      type="date"
                      value={proofDate || asOf}
                      onChange={(e) => setProofDate(e.target.value)}
                    />
                  </div>
                  <button
                    className="primary"
                    type="button"
                    disabled={proofBusy || !proofPurposeId}
                    onClick={() => void onDownloadProof()}
                  >
                    {proofBusy ? 'Generating…' : 'Download proof of consent'}
                  </button>
                </div>
                {proofError && <div className="error">{proofError}</div>}
              </div>

              <h2 style={{ marginTop: 28 }}>
                Timeline{' '}
                <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem' }}>
                  ({history.events.length} event{history.events.length === 1 ? '' : 's'}, newest
                  first)
                </span>
              </h2>

              {history.events.length === 0 ? (
                <p className="muted" data-testid="timeline-empty">
                  No consent events for this subject within these two clock settings.
                  {!clocksAtNow && ' Reset both clocks to now to see the full record.'}
                </p>
              ) : (
                <ol className="timeline" data-testid="timeline">
                  {history.events.map((e) => {
                    const notice = e.noticeVersionId ? notices[e.noticeVersionId] : undefined;
                    const expanded = expandedNotice === e.id;
                    return (
                      <li key={e.id} className="timeline-item" data-testid="timeline-event">
                        <div className="timeline-head">
                          <span className={`badge ${statusBadge(e.status)}`}>{e.status}</span>
                          <strong>
                            <Link href={`/consent/purposes/${e.purposeId}`}>
                              {e.purposeName ?? e.purposeId}
                            </Link>
                          </strong>
                          <span
                            className={`badge ${
                              e.evidenceHashOrigin === 'client' ? 'info' : 'neutral'
                            }`}
                            data-testid="evidence-origin"
                            title={
                              e.evidenceHashOrigin === 'client'
                                ? "The client's own seal over evidence they hold (the rendered notice, the form state). We record it; we did not compute it."
                                : "Our canonical digest over exactly what was recorded. The client supplied no hash of their own."
                            }
                          >
                            evidence: {originLabel(e.evidenceHashOrigin)}
                          </span>
                        </div>

                        <div className="timeline-times">
                          <span>
                            <span className="muted">Happened</span>{' '}
                            {new Date(e.occurredAt).toLocaleString()}
                          </span>
                          <span>
                            <span className="muted">Recorded</span>{' '}
                            {new Date(e.recordedAt).toLocaleString()}
                          </span>
                          <span>
                            <span className="muted">Source</span> <span className="mono">{e.source}</span>
                          </span>
                        </div>

                        <div className="timeline-notice">
                          <span className="muted">Notice shown</span>{' '}
                          {e.noticeVersionId ? (
                            <>
                              <span className="mono" data-testid="notice-version">
                                v{notice ? notice.versionNumber : '…'}
                              </span>{' '}
                              <span className="mono muted">{e.noticeVersionId.slice(0, 8)}…</span>{' '}
                              <button
                                type="button"
                                onClick={() => setExpandedNotice(expanded ? null : e.id)}
                                disabled={!notice}
                              >
                                {expanded ? 'Hide notice text' : 'View notice text'}
                              </button>
                            </>
                          ) : e.legacyNoticeVersionRef ? (
                            <>
                              <span className="mono">{e.legacyNoticeVersionRef}</span>{' '}
                              <span className="muted">
                                (free-text reference from before notices were versioned — frozen as
                                recorded)
                              </span>
                            </>
                          ) : (
                            <span className="muted">— none recorded</span>
                          )}
                        </div>

                        {expanded && notice && (
                          <div style={{ marginTop: 10 }}>
                            <NoticeViewer translations={notice.translations} />
                          </div>
                        )}

                        <div className="timeline-evidence">
                          <span className="muted">Evidence hash</span>{' '}
                          <span className="mono">{e.evidenceHash}</span>
                          <div className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
                            {e.evidenceHashOrigin === 'client'
                              ? 'Client-attested — supplied by the client over evidence they hold. The platform recorded it, it did not compute it.'
                              : 'Platform-derived — our canonical digest over exactly what was recorded, because the client supplied no hash.'}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** GRANTED reads green, WITHDRAWN red, EXPIRED neutral. */
function statusBadge(status: ConsentStatus): string {
  if (status === 'GRANTED') return 'success';
  if (status === 'WITHDRAWN') return 'denied';
  return 'neutral';
}

function originLabel(origin: ConsentEventRecord['evidenceHashOrigin']): string {
  return origin === 'client' ? 'client-attested' : 'platform-derived';
}

/**
 * "As of 3 March" means the state at the CLOSE of 3 March, not its first
 * instant — so a date control means the end of that day, in the reader's own
 * timezone. Getting this backwards would silently exclude everything that
 * happened on the very day being asked about.
 */
function endOfDayIso(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString();
}

/**
 * The anti-conflation device: whatever the two controls are set to, say in
 * plain English which of the two questions is on screen. The four readings are
 * genuinely different answers, and a reader must never have to infer which one
 * they are looking at.
 */
function questionSentence(asOf: string, knownAs: string): React.ReactNode {
  if (!asOf && !knownAs) {
    return (
      <>
        <strong>Both clocks are at now.</strong> Showing everything that has happened, judged with
        everything we know today — the ordinary current answer.
      </>
    );
  }
  if (asOf && !knownAs) {
    return (
      <>
        <strong>Showing what we NOW believe was true on {dayLabel(asOf)}</strong> — including any
        event about that day that was recorded later. This is the corrected view of the past, not
        the view we had at the time.
      </>
    );
  }
  if (!asOf && knownAs) {
    return (
      <>
        <strong>Showing everything we had recorded by {dayLabel(knownAs)}</strong>, about anything
        that had happened up to today. Events recorded after that date are excluded even if they
        describe something that happened before it.
      </>
    );
  }
  return (
    <>
      <strong>
        Showing what we believed on {dayLabel(knownAs)} about what was true on {dayLabel(asOf)}
      </strong>{' '}
      — the answer we could have given on the day, with nothing recorded since.
    </>
  );
}
