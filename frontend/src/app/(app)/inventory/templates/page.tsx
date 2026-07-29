'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../../../../lib/api';
import { useAuth } from '../../../../lib/auth';

interface TemplateListItem {
  id: string;
  sector: string;
  name: string;
  elementCount: number;
}
interface AppliedResult {
  template: { id: string; sector: string; name: string };
  created: Array<{ entryId: string; category: string; purposeCount: number }>;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * FR-INV-11: sector templates pre-seed common data elements (+ purposes,
 * legal basis, retention) via POST /inventory/sector-templates/:id/apply.
 * Reachable from settings/here for BOTH a fresh tenant at onboarding and an
 * existing one wanting a head start — there is no separate onboarding wizard
 * in Stage 1 yet, so this page serves both.
 */
export default function SectorTemplatesPage() {
  const { user } = useAuth();
  const canManage = !!user && MANAGE_ROLES.has(user.role);

  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedResult | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<{ templates: TemplateListItem[] }>('/inventory/sector-templates');
        setTemplates(res.templates);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load sector templates.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onApply(t: TemplateListItem) {
    if (
      !window.confirm(
        `Apply "${t.name}"? This will add ${t.elementCount} new data element(s) (with their purposes) to your register. It never removes or changes anything already there.`,
      )
    ) {
      return;
    }
    setApplyingId(t.id);
    setError(null);
    setApplied(null);
    try {
      const res = await apiFetch<AppliedResult>(`/inventory/sector-templates/${t.id}/apply`, {
        method: 'POST',
      });
      setApplied(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not apply this template.');
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <div>
      <h1>Sector templates</h1>
      <p className="muted">
        Pre-seed common data elements — with processing purposes, legal basis, and retention already
        filled in — for your sector (FR-INV-11). Nothing already in your register is changed.
      </p>

      {error && <div className="error">{error}</div>}

      {applied && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>{applied.template.name}</strong> applied — {applied.created.length} data element(s)
          added:
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {applied.created.map((c) => (
              <li key={c.entryId}>
                <Link href={`/inventory/${c.entryId}`}>{c.category}</Link>{' '}
                <span className="muted">
                  ({c.purposeCount} purpose{c.purposeCount === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sector</th>
              <th>Template</th>
              <th>Elements</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td style={{ textTransform: 'capitalize' }}>{t.sector}</td>
                <td>{t.name}</td>
                <td>{t.elementCount}</td>
                <td>
                  {canManage && (
                    <button
                      className="primary"
                      disabled={applyingId === t.id}
                      onClick={() => void onApply(t)}
                    >
                      {applyingId === t.id ? 'Applying…' : 'Apply'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  No sector templates available.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
