'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';
import { PiiConfidenceBadge } from '../../../../components/PiiConfidenceBadge';

interface PurposeLink {
  id: string;
  consentPurposeId: string;
  consentPurposeName: string | null;
  inventoryPurposeId: string;
  inventoryPurposeName: string | null;
  entryCategory: string | null;
  origin: 'manual' | 'accepted_suggestion';
  suggestionConfidence: number | null;
  linkedAt: string;
}

interface PurposeLinkSuggestion {
  consentPurposeId: string;
  consentPurposeName: string;
  inventoryPurposeId: string;
  inventoryPurposeName: string;
  entryCategory: string;
  confidence: number;
  reason: string;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/** Same three-bucket vocabulary as the PII classifier's confidence badge
 *  (high/medium/low), applied to the Jaccard score `scoreCandidate` returns
 *  server-side. Bucketed here purely for display — the number itself is what
 *  gets re-derived and stored, never the bucket. */
function bucketConfidence(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.7) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/**
 * FR-DPR-04 staff review screen for `consent_purpose_inventory_links` — the
 * mapping Tier 1 Personal Data Summaries depend on to say "these categories of
 * YOUR data" rather than dumping the whole register. The backend
 * (dprequest module) only ever SUGGESTS a pairing by name-similarity; this
 * screen is the human decision the suggester's own comments insist on. No new
 * backend logic — same endpoints and same server-side confidence re-derivation
 * already built for POST/DELETE /dprequest/purpose-links.
 */
export default function PurposeLinksPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [links, setLinks] = useState<PurposeLink[]>([]);
  const [suggestions, setSuggestions] = useState<PurposeLinkSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [linksRes, suggestionsRes] = await Promise.all([
        apiFetch<{ links: PurposeLink[] }>('/dprequest/purpose-links'),
        apiFetch<{ suggestions: PurposeLinkSuggestion[] }>('/dprequest/purpose-links/suggestions'),
      ]);
      setLinks(linksRes.links);
      setSuggestions(suggestionsRes.suggestions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load purpose mappings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAccept(s: PurposeLinkSuggestion) {
    const key = `${s.consentPurposeId}:${s.inventoryPurposeId}`;
    setBusyKey(key);
    setError(null);
    try {
      await apiFetch('/dprequest/purpose-links', {
        method: 'POST',
        body: { consentPurposeId: s.consentPurposeId, inventoryPurposeId: s.inventoryPurposeId },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this suggestion.');
    } finally {
      setBusyKey(null);
    }
  }

  async function onRemove(link: PurposeLink) {
    const reason = window.prompt(
      'Why are you removing this mapping? (required, kept as evidence — a summary already ' +
        'issued under this mapping is unaffected)',
    );
    if (reason === null) return;
    if (reason.trim().length < 5) {
      setError('A reason of at least 5 characters is required to remove a mapping.');
      return;
    }
    setBusyKey(link.id);
    setError(null);
    try {
      await apiFetch(`/dprequest/purpose-links/${link.id}`, { method: 'DELETE', body: { reason: reason.trim() } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this mapping.');
    } finally {
      setBusyKey(null);
    }
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div>
      <h1>Consent ↔ Inventory mapping</h1>
      <p className="muted">
        Which inventory purposes each consent purpose reaches — the mapping Tier 1 Personal Data
        Summaries use to attribute data categories to a subject&apos;s consent (FR-DPR-04). A
        pairing here is only ever a suggestion by name similarity; nothing is added to a summary
        until a person accepts it.
      </p>

      {error && <div className="error">{error}</div>}

      <h2>Suggestions awaiting review</h2>
      {suggestions.length === 0 ? (
        <p className="muted">No unreviewed suggestions right now.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Consent purpose</th>
                <th>Inventory purpose</th>
                <th>Category</th>
                <th>Confidence</th>
                <th>Reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => {
                const key = `${s.consentPurposeId}:${s.inventoryPurposeId}`;
                return (
                  <tr key={key}>
                    <td>{s.consentPurposeName}</td>
                    <td>{s.inventoryPurposeName}</td>
                    <td>{s.entryCategory}</td>
                    <td>
                      <PiiConfidenceBadge confidence={bucketConfidence(s.confidence)} />
                    </td>
                    <td className="muted">{s.reason}</td>
                    <td>
                      {canManage && (
                        <button
                          type="button"
                          className="primary"
                          disabled={busyKey === key}
                          onClick={() => void onAccept(s)}
                        >
                          Accept
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Active mappings</h2>
      {links.length === 0 ? (
        <p className="muted">No purposes are mapped yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Consent purpose</th>
                <th>Inventory purpose</th>
                <th>Category</th>
                <th>Origin</th>
                <th>Linked</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td>{l.consentPurposeName ?? <span className="muted">(deleted)</span>}</td>
                  <td>{l.inventoryPurposeName ?? <span className="muted">(deleted)</span>}</td>
                  <td>{l.entryCategory}</td>
                  <td>
                    {l.suggestionConfidence === null ? (
                      <span className="badge muted" style={{ border: '1px solid var(--border)' }}>
                        Manual
                      </span>
                    ) : (
                      <PiiConfidenceBadge confidence={bucketConfidence(l.suggestionConfidence)} />
                    )}
                  </td>
                  <td className="muted">{new Date(l.linkedAt).toLocaleString()}</td>
                  <td>
                    {canManage && (
                      <button type="button" disabled={busyKey === l.id} onClick={() => void onRemove(l)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
