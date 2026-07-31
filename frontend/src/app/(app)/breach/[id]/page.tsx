'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  BREACH_GATES,
  BREACH_GATE_LABELS,
  type BreachGate,
  type BreachIncidentDetail,
  type BreachTemplate,
} from '@dpdp/shared';
import { apiFetch, ApiError, downloadFile } from '../../../../lib/api';

/**
 * One incident: the guided stepper (FR-BRC-03), the deadline clock per gate
 * (FR-BRC-04), evidence attestation (FR-BRC-05), the generated notices
 * (FR-BRC-06) and the closure packet (FR-BRC-07).
 *
 * The stepper mirrors the backend's ordering rule rather than inventing its
 * own: only the next unpassed gate is actionable. The backend still refuses an
 * out-of-order gate with a 409 — this just means a user is not invited to
 * attempt one. The rule lives in `BREACH_GATES`' order, in @dpdp/shared, so
 * there is one list and it cannot drift.
 */
export default function BreachIncidentPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<BreachIncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [gateNotes, setGateNotes] = useState('');
  const [closureNote, setClosureNote] = useState('');
  const [template, setTemplate] = useState<BreachTemplate | null>(null);

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidenceDesc, setEvidenceDesc] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await apiFetch<BreachIncidentDetail>(`/breach/incidents/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this incident.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await fn());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  if (loading && !detail) return <p className="muted">Loading…</p>;
  if (error && !detail) return <div className="error">{error}</div>;
  if (!detail) return null;

  const { incident, gateStatuses, gateEvents, dataCategories, evidence, escalations } = detail;
  const passed = new Set(gateEvents.map((g) => g.gate));
  const nextGate = BREACH_GATES.find((g) => !passed.has(g)) ?? null;

  return (
    <div>
      <p>
        <Link href="/breach">← Breach Register</Link>
      </p>

      <div className="portal-kicker">{incident.referenceCode}</div>
      <h1>{incident.title}</h1>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <span className={`badge ${incident.status === 'closed' ? 'success' : 'info'}`}>{incident.status}</span>
        <span className="badge denied">{incident.severity}</span>
        <span className="badge neutral">
          {incident.estimatedAffectedCount !== null
            ? `~${incident.estimatedAffectedCount} data principals`
            : 'scope not estimated'}
        </span>
      </div>
      <p className="muted" style={{ fontSize: '0.85rem' }}>
        Discovered {new Date(incident.discoveredAt).toLocaleString()} · systems:{' '}
        {incident.systemsAffected.join(', ') || 'none recorded'}
      </p>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <h2>Data categories involved</h2>
      {dataCategories.length === 0 ? (
        <p className="muted">No Data Inventory categories are linked to this incident.</p>
      ) : (
        <div className="table-wrap" data-testid="incident-categories">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Stored in</th>
                <th>Purpose / legal basis / retention</th>
              </tr>
            </thead>
            <tbody>
              {dataCategories.map((c) => (
                <tr key={c.entryId}>
                  <td>{c.category}</td>
                  <td>{c.storageLocation}</td>
                  <td>
                    {c.purposes.map((p, i) => (
                      <div key={i}>
                        {p.purposeName} — {p.legalBasis.replace(/_/g, ' ')} — {p.retentionPeriod}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- the guided stepper -------------------------------------------- */}
      <h2>Workflow</h2>
      <div data-testid="gate-stepper">
        {BREACH_GATES.map((gate, idx) => {
          const status = gateStatuses.find((g) => g.gate === gate)!;
          const event = gateEvents.find((g) => g.gate === gate);
          const isNext = gate === nextGate && incident.status === 'open';
          return (
            <div
              key={gate}
              data-testid={`gate-${gate}`}
              style={{
                borderLeft: `3px solid ${event ? '#1a7f37' : status.overdue ? '#b3261e' : '#ccc'}`,
                paddingLeft: 12,
                marginBottom: 14,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>
                  {idx + 1}. {BREACH_GATE_LABELS[gate]}
                </strong>
                {event ? (
                  <span
                    className={`badge ${status.completedOnTime === false ? 'warning' : 'success'}`}
                    data-testid={`gate-status-${gate}`}
                  >
                    {status.completedOnTime === false ? 'completed late' : 'completed'}
                  </span>
                ) : (
                  <span
                    className={`badge ${status.overdue ? 'denied' : 'neutral'}`}
                    data-testid={`gate-status-${gate}`}
                  >
                    {status.overdue ? 'overdue' : 'pending'}
                  </span>
                )}
                {status.escalationLevel > 0 && (
                  <span className="badge warning">escalated L{status.escalationLevel}</span>
                )}
              </div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                Due {status.dueAt ? new Date(status.dueAt).toLocaleString() : '—'}
                {status.policyVersion ? ` · ${status.policyKey} v${status.policyVersion}` : ''}
                {event ? ` · completed ${new Date(event.completedAt).toLocaleString()}` : ''}
              </div>
              {event && <div style={{ fontSize: '0.9rem', marginTop: 4 }}>{event.notes}</div>}

              {isNext && (
                <form
                  style={{ marginTop: 8 }}
                  data-testid={`gate-form-${gate}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(gate, async () => {
                      await apiFetch(`/breach/incidents/${id}/gates/${gate}`, {
                        method: 'POST',
                        body: { notes: gateNotes },
                      });
                      setGateNotes('');
                      return `${BREACH_GATE_LABELS[gate]} completed.`;
                    });
                  }}
                >
                  <textarea
                    data-testid={`gate-notes-${gate}`}
                    value={gateNotes}
                    onChange={(e) => setGateNotes(e.target.value)}
                    placeholder="What was done, and what was found? (recorded as evidence)"
                    minLength={10}
                    rows={3}
                    required
                    style={{ width: '100%' }}
                  />
                  <button className="primary" type="submit" disabled={busy !== null}>
                    {busy === gate ? 'Saving…' : `Complete ${BREACH_GATE_LABELS[gate]}`}
                  </button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      {/* --- closure -------------------------------------------------------- */}
      {incident.status === 'open' && nextGate === null && (
        <form
          className="portal-form"
          data-testid="closure-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act('close', async () => {
              await apiFetch(`/breach/incidents/${id}/close`, {
                method: 'POST',
                body: { note: closureNote },
              });
              return 'Incident closed and signed off.';
            });
          }}
        >
          <label htmlFor="closure-note">Closure sign-off</label>
          <textarea
            id="closure-note"
            value={closureNote}
            onChange={(e) => setClosureNote(e.target.value)}
            minLength={10}
            rows={3}
            required
          />
          <div className="portal-actions">
            <button className="primary" type="submit" disabled={busy !== null} data-testid="close-incident">
              {busy === 'close' ? 'Closing…' : 'Close incident'}
            </button>
          </div>
        </form>
      )}

      {/* --- evidence ------------------------------------------------------- */}
      <h2>Evidence</h2>
      <p className="muted">
        The file is hashed in your browser&apos;s request and the platform stores only its SHA-256 —
        never the file. Breach evidence is the likeliest material to contain personal data, so the
        platform attests to it rather than archiving it.
      </p>
      {incident.status === 'open' && (
        <form
          className="portal-form"
          data-testid="evidence-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!evidenceFile) return;
            void act('evidence', async () => {
              const buf = await evidenceFile.arrayBuffer();
              const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
              const res = await apiFetch<{ sha256: string; fileName: string }>(
                `/breach/incidents/${id}/evidence`,
                {
                  method: 'POST',
                  body: {
                    fileName: evidenceFile.name,
                    contentType: evidenceFile.type || null,
                    contentBase64: base64,
                    description: evidenceDesc || null,
                  },
                },
              );
              setEvidenceFile(null);
              setEvidenceDesc('');
              return `${res.fileName} attested — SHA-256 ${res.sha256}`;
            });
          }}
        >
          <label htmlFor="evidence-file">File</label>
          <input
            id="evidence-file"
            data-testid="evidence-file"
            type="file"
            onChange={(e) => setEvidenceFile(e.target.files?.[0] ?? null)}
            required
          />
          <label htmlFor="evidence-desc">Description</label>
          <input id="evidence-desc" value={evidenceDesc} onChange={(e) => setEvidenceDesc(e.target.value)} />
          <div className="portal-actions">
            <button className="primary" type="submit" disabled={busy !== null || !evidenceFile}>
              {busy === 'evidence' ? 'Hashing…' : 'Register evidence'}
            </button>
          </div>
        </form>
      )}
      {evidence.length > 0 && (
        <div className="table-wrap" data-testid="evidence-table">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>SHA-256</th>
                <th>Size</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map((e) => (
                <tr key={e.id} data-testid={`evidence-row-${e.id}`}>
                  <td>{e.fileName}</td>
                  <td className="mono" style={{ fontSize: '0.72rem', wordBreak: 'break-all' }} data-testid={`evidence-sha-${e.id}`}>
                    {e.sha256}
                  </td>
                  <td>{e.sizeBytes} B</td>
                  <td>{new Date(e.uploadedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- notices and packet --------------------------------------------- */}
      <h2>Notifications and closure packet</h2>
      <div className="portal-actions" style={{ marginBottom: 10 }}>
        <button
          type="button"
          data-testid="template-dp"
          disabled={busy !== null}
          onClick={() =>
            void act('tpl-dp', async () => {
              setTemplate(
                await apiFetch<BreachTemplate>(`/breach/incidents/${id}/templates/data_principal_notice`, {
                  method: 'POST',
                }),
              );
              return 'Data Principal notice generated.';
            })
          }
        >
          Generate Data Principal notice
        </button>
        <button
          type="button"
          data-testid="template-reg"
          disabled={busy !== null}
          onClick={() =>
            void act('tpl-reg', async () => {
              setTemplate(
                await apiFetch<BreachTemplate>(`/breach/incidents/${id}/templates/regulator_report`, {
                  method: 'POST',
                }),
              );
              return 'Regulator report generated.';
            })
          }
        >
          Generate regulator report
        </button>
        <button
          type="button"
          className="primary"
          data-testid="download-packet"
          disabled={busy !== null}
          onClick={() =>
            void act('packet', async () => {
              await downloadFile(
                `/breach/incidents/${id}/closure-packet`,
                `Breach-Closure-${incident.referenceCode}.pdf`,
                { method: 'POST' },
              );
              return 'Closure packet downloaded.';
            })
          }
        >
          Download closure packet
        </button>
      </div>

      {template && (
        <div data-testid="template-output">
          <h3>{template.title}</h3>
          {template.gaps.length > 0 && (
            <div className="notice" data-testid="template-gaps">
              <strong>Not ready to send.</strong> {template.gaps.join(' ')}
            </div>
          )}
          <pre
            style={{ background: 'var(--surface-2, #f4f4f4)', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap' }}
          >
            {template.body}
          </pre>
        </div>
      )}

      {escalations.length > 0 && (
        <>
          <h2>Escalations</h2>
          <ul className="muted" style={{ fontSize: '0.85rem' }} data-testid="escalations">
            {escalations.map((e, i) => (
              <li key={i}>
                {new Date(e.occurredAt).toLocaleString()} — {e.gate.replace(/_/g, ' ')} level {e.level} (
                {e.rung.replace(/_/g, ' ')}, {e.trigger}) —{' '}
                {e.notifiedOk ? `notified ${e.notifiedContact}` : 'no active holder to notify'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
