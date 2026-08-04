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
  systemCount: number;
  vendorCount: number;
}
interface AppliedResult {
  template: { id: string; sector: string; name: string };
  created: Array<{
    entryId: string;
    category: string;
    purposeCount: number;
    systemCount: number;
    vendorCount: number;
  }>;
  createdSystems: Array<{ systemId: string; name: string }>;
  createdVendors: Array<{ vendorId: string; name: string }>;
}

const MANAGE_ROLES = new Set(['owner', 'dpo', 'compliance_officer']);

/**
 * Sector labels. The `sector` column is a machine key ('ca_tax_practice'), so
 * it cannot simply be capitalised for display — an unmapped key falls back to
 * its own text rather than disappearing.
 */
const SECTOR_LABELS: Record<string, string> = {
  healthcare: 'Healthcare',
  retail: 'Retail / e-commerce',
  edtech: 'EdTech',
  fintech: 'Fintech / lending',
  ca_tax_practice: 'CA / tax practice',
};

/**
 * FR-INV-11: sector templates pre-seed data elements (+ purposes, legal basis,
 * retention), the systems those elements live on, and the vendors/recipients
 * they reach, via POST /inventory/sector-templates/:id/apply. Reachable from
 * settings/here for BOTH a fresh tenant at onboarding and an existing one
 * wanting a head start — there is no separate onboarding wizard in Stage 1 yet,
 * so this page serves both.
 *
 * The framing is deliberate and repeated: a template is a STARTING POINT, not a
 * locked list. Everything it writes is ordinary tenant data — editable,
 * removable, versioned exactly like a row typed by hand — and the retention
 * values it seeds are indicative, not advice.
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
        `Apply "${t.name}"?\n\n` +
          `This adds ${t.elementCount} data element(s), ${t.systemCount} system(s) and ` +
          `${t.vendorCount} vendor(s) to your registers as a STARTING POINT. Everything it ` +
          `adds is yours to edit, rename or remove — nothing is locked.\n\n` +
          `Retention periods are INDICATIVE. Confirm the exact statutory period before ` +
          `relying on any of them.\n\n` +
          `Nothing already in your registers is changed or removed.`,
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
        Pre-seed a starting register for your sector (FR-INV-11) — data elements with their
        processing purposes, legal basis and retention, the systems those elements live on, and the
        vendors and recipients they reach. Nothing already in your registers is changed.
      </p>

      <div className="notice" style={{ marginBottom: 16 }}>
        <strong>A starting point, not a locked list.</strong> These are the things a practice of this
        kind <em>typically</em> handles — the same &ldquo;such as&rdquo; sense your own SOP uses.
        Once applied, every row is ordinary data in your registers: edit it, rename it, add to it or
        remove it exactly as if you had typed it yourself, and every change is versioned and audited
        the same way.
        <br />
        <br />
        <strong>Retention periods are indicative.</strong> They are a place to start the
        conversation, not legal advice — confirm the exact statutory period that applies to your
        engagement before relying on any of them.
      </div>

      {error && <div className="error">{error}</div>}

      {applied && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <strong>{applied.template.name}</strong> applied — all of it now editable in your
          registers.
          <div style={{ marginTop: 8 }}>
            <strong>{applied.created.length} data element(s)</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {applied.created.map((c) => (
                <li key={c.entryId}>
                  <Link href={`/inventory/${c.entryId}`}>{c.category}</Link>{' '}
                  <span className="muted">
                    ({c.purposeCount} purpose{c.purposeCount === 1 ? '' : 's'}, {c.systemCount} system
                    {c.systemCount === 1 ? '' : 's'}, {c.vendorCount} vendor
                    {c.vendorCount === 1 ? '' : 's'})
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {applied.createdSystems.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>{applied.createdSystems.length} system(s)</strong>{' '}
              <span className="muted">
                {applied.createdSystems.map((s) => s.name).join(', ')} —{' '}
                <Link href="/inventory/systems">review in Systems &amp; assets</Link>
              </span>
            </div>
          )}
          {applied.createdVendors.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>{applied.createdVendors.length} vendor(s)</strong>{' '}
              <span className="muted">
                {applied.createdVendors.map((v) => v.name).join(', ')} —{' '}
                <Link href="/inventory/vendors">review in Vendors</Link>
              </span>
            </div>
          )}
          <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
            Next: check each retention period against the statute that actually applies to you, and
            replace the seeded access-control notes with this firm&apos;s real policy.
          </p>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sector</th>
              <th>Template</th>
              <th>Elements</th>
              <th>Systems</th>
              <th>Vendors</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td>{SECTOR_LABELS[t.sector] ?? t.sector}</td>
                <td>{t.name}</td>
                <td>{t.elementCount}</td>
                <td>{t.systemCount}</td>
                <td>{t.vendorCount}</td>
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
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
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
