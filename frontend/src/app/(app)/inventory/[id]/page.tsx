'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { PiiConfidenceBadge } from '../../../../components/PiiConfidenceBadge';
import { PurposesPanel } from '../../../../components/PurposesPanel';
import { LinkedSystemsPanel } from '../../../../components/LinkedSystemsPanel';
import { LinkedVendorsPanel } from '../../../../components/LinkedVendorsPanel';

interface VersionEntry {
  versionNumber: number;
  category: string;
  description: string | null;
  storageLocation: string;
  createdAt: string;
  // Deprecated (Prompt 14, FR-INV-05) — only ever set on versions created
  // before purposes moved to their own linked, versioned entity.
  legacyPurpose: string | null;
  legacyRetentionPeriod: string | null;
}
type PiiConfidence = 'high' | 'medium' | 'low';
type PiiDecision = 'undecided' | 'accepted' | 'rejected';

interface EntryDetail {
  id: string;
  status: 'active' | 'tombstoned';
  tombstoneReason: string | null;
  tombstonedAt: string | null;
  createdAt: string;
  updatedAt: string;
  piiCategory: string | null;
  piiConfidence: PiiConfidence | null;
  piiDecision: PiiDecision;
  piiDecisionReason: string | null;
  piiDecidedAt: string | null;
  versions: VersionEntry[];
}

interface Suggestion {
  category: string | null;
  confidence: PiiConfidence | null;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * One data element: its current version plus the FULL version history
 * (FR-INV-08) — every edit is a new row here, never an overwrite. Edit and
 * Remove are only offered while the entry is active; a tombstoned entry is
 * shown (never hidden) but is read-only, matching the backend's rejection of
 * edits on a tombstoned entry.
 */
export default function InventoryEntryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestionLoading, setSuggestionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntry(await apiFetch<EntryDetail>(`/inventory/register/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this data element.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // FR-INV-03: a suggestion is only meaningful while nothing has been decided
  // yet — an already-accepted/rejected entry shows its recorded decision
  // instead of re-suggesting. Classifies by NAME/TEXT only (the entry's own
  // category, falling back to its description) — never a data value (I1).
  useEffect(() => {
    if (!entry || entry.piiDecision !== 'undecided') {
      setSuggestion(null);
      return;
    }
    let cancelled = false;
    setSuggestionLoading(true);
    const current = entry.versions[0];
    const text = current.category || current.description || '';
    apiFetch<Suggestion>(`/inventory/register/classify-suggestion?text=${encodeURIComponent(text)}`)
      .then((res) => {
        if (!cancelled) setSuggestion(res);
      })
      .catch(() => {
        if (!cancelled) setSuggestion(null);
      })
      .finally(() => {
        if (!cancelled) setSuggestionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  async function onAcceptPii() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/${id}/pii-decision`, {
        method: 'POST',
        body: { decision: 'accepted' },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this classification.');
    } finally {
      setBusy(false);
    }
  }

  async function onRejectPii() {
    const reason = window.prompt(
      'Why are you rejecting this suggestion? (required, kept as evidence)',
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to reject a classification suggestion.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/${id}/pii-decision`, {
        method: 'POST',
        body: { decision: 'rejected', reason: reason.trim() },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reject this classification.');
    } finally {
      setBusy(false);
    }
  }

  async function onTombstone() {
    const reason = window.prompt(
      'Why are you removing this data element? (required, kept as evidence)',
    );
    if (reason === null) return;
    if (
      !window.confirm(
        'This entry will be tombstoned — hidden from the default view but never deleted, and no ' +
          'longer editable. Continue?',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/inventory/register/${id}`, { method: 'DELETE', body: { reason } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this data element.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (error && !entry) return <div className="error">{error}</div>;
  if (!entry) return null;

  const current = entry.versions[0];

  return (
    <div>
      <p className="muted" style={{ marginBottom: 4 }}>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            router.push('/inventory');
          }}
        >
          ← Back to Data Inventory
        </a>
      </p>
      <h1>{current.category}</h1>
      <span className={`badge ${entry.status === 'active' ? 'success' : 'denied'}`}>{entry.status}</span>

      {entry.status === 'tombstoned' && (
        <div className="notice" style={{ marginTop: 12 }}>
          Tombstoned{entry.tombstonedAt ? ` on ${new Date(entry.tombstonedAt).toLocaleString()}` : ''}
          {entry.tombstoneReason ? ` — ${entry.tombstoneReason}` : ''}. Never deleted, no longer
          editable.
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Current version (v{current.versionNumber})</h2>
        <Field label="Category" value={current.category} />
        <Field label="Description" value={current.description || '—'} />
        <Field label="Storage location" value={current.storageLocation} />
        {(current.legacyPurpose || current.legacyRetentionPeriod) && (
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Legacy purpose/retention from before FR-INV-05: {current.legacyPurpose || '—'} /{' '}
            {current.legacyRetentionPeriod || '—'}. See the Processing purposes panel below for the
            current, versioned purposes.
          </p>
        )}
      </div>

      <PurposesPanel entryId={entry.id} canManage={canManage && entry.status === 'active'} />
      <LinkedSystemsPanel entryId={entry.id} canManage={canManage && entry.status === 'active'} />
      <LinkedVendorsPanel entryId={entry.id} canManage={canManage && entry.status === 'active'} />

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>PII classification</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
          A rule-based suggestion your compliance officer confirms — the platform advises, never
          decides (FR-INV-03/04).
        </p>

        {entry.piiDecision === 'accepted' && (
          <p style={{ margin: 0 }}>
            <span className="badge success">Classified: {entry.piiCategory}</span>{' '}
            {entry.piiConfidence && <PiiConfidenceBadge confidence={entry.piiConfidence} />}{' '}
            <span className="muted" style={{ fontSize: '0.8rem' }}>
              accepted{entry.piiDecidedAt ? ` on ${new Date(entry.piiDecidedAt).toLocaleString()}` : ''}
            </span>
          </p>
        )}

        {entry.piiDecision === 'rejected' && (
          <p style={{ margin: 0 }}>
            <span className="badge denied">Not classified</span>{' '}
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              Rejected suggestion: {entry.piiCategory}
              {entry.piiConfidence ? ` (${entry.piiConfidence} confidence)` : ''}
              {entry.piiDecisionReason ? ` — ${entry.piiDecisionReason}` : ''}
            </span>
          </p>
        )}

        {entry.piiDecision === 'undecided' && (
          <>
            {suggestionLoading && <p className="muted">Checking for a suggestion…</p>}
            {!suggestionLoading && suggestion?.category && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>
                  Suggested: <strong>{suggestion.category}</strong>
                </span>
                {suggestion.confidence && <PiiConfidenceBadge confidence={suggestion.confidence} />}
                {canManage && entry.status === 'active' && (
                  <>
                    <button disabled={busy} onClick={() => void onAcceptPii()}>
                      Accept
                    </button>
                    <button disabled={busy} onClick={() => void onRejectPii()}>
                      Reject
                    </button>
                  </>
                )}
              </div>
            )}
            {!suggestionLoading && !suggestion?.category && (
              <p className="muted" style={{ margin: 0 }}>
                No PII classification suggested for this data element.
              </p>
            )}
          </>
        )}
      </div>

      {canManage && entry.status === 'active' && (
        <div style={{ marginTop: 16, display: 'flex', gap: 10 }}>
          <button
            className="primary"
            disabled={busy}
            onClick={() => router.push(`/inventory/${id}/edit`)}
          >
            Edit (creates a new version)
          </button>
          <button disabled={busy} onClick={() => void onTombstone()}>
            Remove (tombstone)
          </button>
        </div>
      )}

      <h2 style={{ marginTop: 28 }}>Version history</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Every edit creates a new version. Nothing is ever overwritten (FR-INV-08).
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Category</th>
              <th>Description</th>
              <th>Storage location</th>
              <th>Recorded</th>
            </tr>
          </thead>
          <tbody>
            {entry.versions.map((v) => (
              <tr key={v.versionNumber}>
                <td className="mono">
                  v{v.versionNumber}
                  {v.versionNumber === current.versionNumber ? ' (current)' : ''}
                </td>
                <td>{v.category}</td>
                <td>{v.description || '—'}</td>
                <td>{v.storageLocation}</td>
                <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: '0.8rem' }}>
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}
