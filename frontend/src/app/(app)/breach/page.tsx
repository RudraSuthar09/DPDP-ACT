'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  BREACH_GATE_LABELS,
  BREACH_SEVERITIES,
  type BreachDeadlinePolicy,
  type BreachIncident,
  type BreachSeverity,
} from '@dpdp/shared';
import { apiFetch, ApiError } from '../../../lib/api';

interface RegisterEntry {
  id: string;
  category: string;
  storageLocation: string;
  status?: string;
}

/**
 * The Breach Register (FR-BRC-01/02): the incident list, the deadline policies
 * in force, and intake.
 *
 * The intake form's data-category field is a MULTI-SELECT OF REAL INVENTORY
 * ENTRIES, not a text box. That is the requirement and it is also the reason
 * the feature is worth anything: a category chosen here is a foreign key, so
 * the incident inherits that entry's purposes, legal bases and retention for
 * the assessment and the regulator report. A free-text box would make every
 * downstream document an assertion nobody could trace.
 */
export default function BreachRegisterPage() {
  const [incidents, setIncidents] = useState<BreachIncident[]>([]);
  const [policies, setPolicies] = useState<BreachDeadlinePolicy[]>([]);
  const [entries, setEntries] = useState<RegisterEntry[]>([]);
  const [status, setStatus] = useState<'' | 'open' | 'closed'>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Intake fields
  const [title, setTitle] = useState('');
  const [whatHappened, setWhatHappened] = useState('');
  const [discoveredAt, setDiscoveredAt] = useState(() => toLocalInput(new Date()));
  const [systems, setSystems] = useState('');
  const [selectedEntries, setSelectedEntries] = useState<string[]>([]);
  const [affected, setAffected] = useState('');
  const [severity, setSeverity] = useState<BreachSeverity>('high');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (status) params.set('status', status);
      const [inc, pol, reg] = await Promise.all([
        apiFetch<{ incidents: BreachIncident[] }>(`/breach/incidents?${params.toString()}`),
        apiFetch<{ policies: BreachDeadlinePolicy[] }>('/breach/deadline-policies'),
        // The real Data Inventory register — the source of the category picker.
        // `elements` is the key this endpoint actually returns.
        apiFetch<{ elements: RegisterEntry[] }>('/inventory/register'),
      ]);
      setIncidents(inc.incidents);
      setPolicies(pol.policies);
      // Only ACTIVE entries can be referenced by an incident — the backend
      // rejects a tombstoned id, so offering one would be a dead option.
      setEntries((reg.elements ?? []).filter((e) => e.status !== 'tombstoned'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the breach register.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/breach/incidents', {
        method: 'POST',
        body: {
          title,
          whatHappened,
          discoveredAt: new Date(discoveredAt).toISOString(),
          systemsAffected: systems.split(',').map((s) => s.trim()).filter(Boolean),
          dataCategoryEntryIds: selectedEntries,
          estimatedAffectedCount: affected === '' ? null : Number(affected),
          severity,
        },
      });
      setShowForm(false);
      setTitle('');
      setWhatHappened('');
      setSystems('');
      setSelectedEntries([]);
      setAffected('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the incident.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Breach Register</h1>
      <p className="muted">
        Personal data breach incidents (DPDP §8(6)). Every gate&apos;s deadline runs from the moment
        the breach was <strong>discovered</strong> — not from when it was logged — and comes from a
        versioned policy record, never from code (FR-BRC-02).
      </p>

      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <div className="field">
          <label htmlFor="status-filter">Status</label>
          <select
            id="status-filter"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | 'open' | 'closed')}
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        <button
          type="button"
          className="primary"
          data-testid="new-incident-btn"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? 'Cancel' : 'Report an incident'}
        </button>
      </div>

      {showForm && (
        <form className="portal-form" onSubmit={submit} data-testid="incident-form">
          <label htmlFor="title">Title</label>
          <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required />

          <label htmlFor="what-happened">What happened</label>
          <textarea
            id="what-happened"
            value={whatHappened}
            onChange={(e) => setWhatHappened(e.target.value)}
            minLength={10}
            rows={5}
            required
          />

          <label htmlFor="discovered-at">When was it discovered?</label>
          <input
            id="discovered-at"
            type="datetime-local"
            value={discoveredAt}
            onChange={(e) => setDiscoveredAt(e.target.value)}
            required
          />
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: -6 }}>
            Every statutory clock starts here. Logging an incident late does not buy more time.
          </p>

          <label htmlFor="systems">Systems affected (comma separated)</label>
          <input id="systems" value={systems} onChange={(e) => setSystems(e.target.value)} />

          {/* THE REQUIREMENT: categories come from the real Data Inventory. */}
          <label htmlFor="categories">Data categories involved</label>
          {entries.length === 0 ? (
            <p className="muted" data-testid="no-inventory">
              Your Data Inventory has no active entries yet. Add entries there first — an incident
              references them, so there is nothing to select until they exist.
            </p>
          ) : (
            <select
              id="categories"
              data-testid="category-select"
              multiple
              size={Math.min(6, entries.length)}
              value={selectedEntries}
              onChange={(e) =>
                setSelectedEntries(Array.from(e.target.selectedOptions).map((o) => o.value))
              }
            >
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.category} — {entry.storageLocation}
                </option>
              ))}
            </select>
          )}

          <label htmlFor="affected">Estimated Data Principals affected</label>
          <input
            id="affected"
            type="number"
            min={0}
            value={affected}
            onChange={(e) => setAffected(e.target.value)}
          />

          <label htmlFor="severity">Severity</label>
          <select id="severity" value={severity} onChange={(e) => setSeverity(e.target.value as BreachSeverity)}>
            {BREACH_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <div className="portal-actions">
            <button className="primary" type="submit" disabled={busy} data-testid="submit-incident">
              {busy ? 'Opening…' : 'Open incident'}
            </button>
          </div>
        </form>
      )}

      <h2>Deadlines in force</h2>
      <div className="table-wrap" data-testid="breach-policies">
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>Deadline from discovery</th>
              <th>Policy in force</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.gate}>
                <td>{BREACH_GATE_LABELS[p.gate]}</td>
                <td>{p.isFallback ? <span className="muted">none</span> : formatHours(p.slaHours)}</td>
                <td>
                  <span className="badge neutral">
                    {p.isFallback ? 'unset' : `${p.policyKey} v${p.version}`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Incidents</h2>
      {loading && <p className="muted">Loading…</p>}
      {!loading && incidents.length === 0 ? (
        <p className="muted" data-testid="no-incidents">No incidents match this filter.</p>
      ) : (
        !loading && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Title</th>
                  <th>Severity</th>
                  <th>Discovered</th>
                  <th>Current gate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody data-testid="incident-table">
                {incidents.map((i) => (
                  <tr key={i.id} data-testid={`incident-row-${i.referenceCode}`}>
                    <td>
                      <Link href={`/breach/${i.id}`} className="mono">
                        {i.referenceCode}
                      </Link>
                    </td>
                    <td>{i.title}</td>
                    <td>
                      <span className={`badge ${i.severity === 'critical' || i.severity === 'high' ? 'denied' : 'neutral'}`}>
                        {i.severity}
                      </span>
                    </td>
                    <td>{new Date(i.discoveredAt).toLocaleString()}</td>
                    <td>{BREACH_GATE_LABELS[i.currentGate]}</td>
                    <td>
                      <span className={`badge ${i.status === 'closed' ? 'success' : 'info'}`}>{i.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function formatHours(hours: number): string {
  if (hours >= 24) {
    const days = Math.round((hours / 24) * 10) / 10;
    return `${days} day${days === 1 ? '' : 's'} (${hours}h)`;
  }
  return `${hours} hours`;
}

/** `datetime-local` wants a local-time string with no zone, so the browser
 *  shows the user their own clock rather than UTC. Converted back to a real
 *  instant on submit. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
