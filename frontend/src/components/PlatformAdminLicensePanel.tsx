'use client';

import { useEffect, useState } from 'react';
import { platformAdminFetch, PlatformAdminApiError } from '../lib/platform-admin-api';
import {
  BUCKET_BADGE,
  BUCKET_LABEL,
  DEPLOYMENT_LABEL,
  fmtDate as fmt,
  licenseBucket,
  PLAN_LABEL,
  type LicenseView,
} from '../lib/admin-licenses';
import { LicenseDecisionButtons } from './admin/LicenseDecisionButtons';

/**
 * The license list/issue panel for ONE chosen tenant, inside the
 * cross-tenant /admin/licenses tool. Sibling of the (now-removed) tenant-
 * facing LicensePanel, but scoped by an explicit tenantId instead of the
 * ambient session — this tool has no ambient tenant at all (see the
 * platform-admin migration) — and talks to /platform-admin/organisations/
 * :tenantId/licenses via platformAdminFetch, never the normal /licenses
 * endpoints.
 */

const ISSUED_BY_LABEL: Record<LicenseView['issuedBy'], string> = {
  tenant_owner: 'Tenant',
  platform_admin: 'Platform admin',
};

const VALIDITY_PRESETS: { value: '3' | '6' | '12' | '24'; label: string }[] = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '1 year' },
  { value: '24', label: '2 years' },
];

/** Months -> an ISO expiresAt, counted from now. Mirrors the backend's own
 *  defaultExpiry() month arithmetic (licensing.service.ts) so a preset here
 *  lands on the same date the backend would have picked on its own. */
function expiresAtFromMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

export function PlatformAdminLicensePanel({
  tenantId,
  tenantName,
  onChanged,
}: {
  tenantId: string;
  tenantName: string;
  /** Called after this panel issued, approved or rejected a licence. */
  onChanged?: () => void;
}) {
  const [licenses, setLicenses] = useState<LicenseView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  // Enterprise + Hosted is the production model (DPDP hosted centrally,
  // customers run their own Gateway agents) — the default here.
  const [plan, setPlan] = useState<'saas' | 'enterprise'>('enterprise');
  const [deploymentType, setDeploymentType] = useState<'hosted' | 'client_server'>('hosted');
  // Presets are a convenience, not a limit — 'custom' opens a plain months
  // input so this is never locked to exactly these four numbers (backend
  // already accepts any expiresAt; this is purely a UI control over it).
  const [validityPreset, setValidityPreset] = useState<'3' | '6' | '12' | '24' | 'custom'>('6');
  const [customMonths, setCustomMonths] = useState('6');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const data = await platformAdminFetch<{ licenses: LicenseView[] }>(
        `/platform-admin/organisations/${tenantId}/licenses`,
      );
      setLicenses(data.licenses);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof PlatformAdminApiError ? err.message : 'Could not load licenses.');
    }
  }

  useEffect(() => {
    setLicenses(null);
    setNewKey(null);
    setError(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function handleIssue(e: React.FormEvent) {
    e.preventDefault();
    const months = validityPreset === 'custom' ? Number(customMonths) : Number(validityPreset);
    if (!Number.isInteger(months) || months < 1) {
      setError('Validity must be a whole number of months, 1 or more.');
      return;
    }
    setIssuing(true);
    setError(null);
    setCopied(false);
    try {
      const data = await platformAdminFetch<{ licenseKey: string }>(
        `/platform-admin/organisations/${tenantId}/licenses`,
        { method: 'POST', body: { plan, deploymentType, features: {}, expiresAt: expiresAtFromMonths(months) } },
      );
      setNewKey(data.licenseKey);
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not issue a license key.');
    } finally {
      setIssuing(false);
    }
  }

  async function handleCopy() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      // Clipboard access can fail — the key is still visible on screen.
    }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>License keys — {tenantName}</h2>
      <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
        Issue a license key to activate an installation (e.g. the Electron app) for this organisation. Each
        key is shown exactly once, right after issuing it — it is never stored and can&apos;t be retrieved
        later. If this client lost theirs, issue a new one here; it works the same way.
        A license cannot activate anything until you approve it below, regardless of who issued it.
      </p>

      {loadError && <p className="muted" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }}>{loadError}</p>}

      {licenses && licenses.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Plan</th>
                <th>Deployment</th>
                <th>Status</th>
                <th>Approval</th>
                <th>Issued</th>
                <th>Expires</th>
                <th>Issued by</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.licenseKeyPrefix}…</td>
                  <td>{PLAN_LABEL[l.plan] ?? l.plan}</td>
                  <td>{DEPLOYMENT_LABEL[l.deploymentType] ?? l.deploymentType}</td>
                  <td>
                    <span className={BUCKET_BADGE[licenseBucket(l)]}>{BUCKET_LABEL[licenseBucket(l)]}</span>
                    {l.revokeReason && (
                      <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
                        {l.revokeReason}
                      </div>
                    )}
                  </td>
                  <td>
                    {l.approvedAt ? (
                      <span className="badge success">Approved {fmt(l.approvedAt)}</span>
                    ) : l.status === 'pending' ? (
                      <LicenseDecisionButtons
                        tenantId={tenantId}
                        licenseId={l.id}
                        onDone={async () => {
                          await refresh();
                          onChanged?.();
                        }}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{fmt(l.issuedAt)}</td>
                  <td>{fmt(l.expiresAt)}</td>
                  <td>{ISSUED_BY_LABEL[l.issuedBy]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {licenses && licenses.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>No licenses issued yet.</p>}

      <form onSubmit={handleIssue} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value as 'saas' | 'enterprise')}>
            <option value="saas">SaaS</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Deployment type
          <select value={deploymentType} onChange={(e) => setDeploymentType(e.target.value as 'hosted' | 'client_server')}>
            <option value="hosted">Hosted</option>
            <option value="client_server">Client server</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
          Validity
          <select
            value={validityPreset}
            onChange={(e) => setValidityPreset(e.target.value as typeof validityPreset)}
            data-testid="license-validity-preset"
          >
            {VALIDITY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {validityPreset === 'custom' && (
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
            Months
            <input
              type="number"
              min={1}
              step={1}
              value={customMonths}
              onChange={(e) => setCustomMonths(e.target.value)}
              style={{ width: 90 }}
              data-testid="license-validity-custom-months"
            />
          </label>
        )}
        <button type="submit" className="primary" disabled={issuing} data-testid="license-issue-submit">
          {issuing ? 'Issuing…' : 'Issue new license key'}
        </button>
      </form>
      {error && (
        <p className="muted" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }}>
          {error}
        </p>
      )}

      {newKey && (
        <div className="notice" style={{ marginTop: 16, borderRadius: 6 }}>
          <strong>New license key — copy it now, it won&apos;t be shown again:</strong>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <code className="mono" style={{ padding: '4px 8px', background: 'var(--color-surface-2, #f1f5f9)', borderRadius: 4 }} data-testid="license-new-key">
              {newKey}
            </code>
            <button type="button" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
