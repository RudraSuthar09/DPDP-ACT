'use client';

import { useEffect, useState } from 'react';
import { platformAdminFetch, PlatformAdminApiError } from '../lib/platform-admin-api';

/**
 * The license list/issue panel for ONE chosen tenant, inside the
 * cross-tenant /admin/licenses tool. Sibling of the (now-removed) tenant-
 * facing LicensePanel, but scoped by an explicit tenantId instead of the
 * ambient session — this tool has no ambient tenant at all (see the
 * platform-admin migration) — and talks to /platform-admin/organisations/
 * :tenantId/licenses via platformAdminFetch, never the normal /licenses
 * endpoints.
 */

interface LicenseView {
  id: string;
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  licenseKeyPrefix: string;
  status: 'pending' | 'active' | 'expired' | 'revoked';
  issuedAt: string;
  expiresAt: string | null;
  issuedBy: 'tenant_owner' | 'platform_admin';
  /** Platform-admin approval gate — null until approved. Cannot activate an
   *  installation until then, regardless of status/expiry. */
  approvedAt: string | null;
}

const STATUS_BADGE: Record<LicenseView['status'], string> = {
  active: 'badge success',
  pending: 'badge info',
  expired: 'badge warning',
  revoked: 'badge denied',
};

const PLAN_LABEL: Record<string, string> = { saas: 'SaaS', enterprise: 'Enterprise' };
const DEPLOYMENT_LABEL: Record<string, string> = { hosted: 'Hosted', client_server: 'Client server' };
const ISSUED_BY_LABEL: Record<LicenseView['issuedBy'], string> = {
  tenant_owner: 'Tenant',
  platform_admin: 'Platform admin',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

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

export function PlatformAdminLicensePanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const [licenses, setLicenses] = useState<LicenseView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [plan, setPlan] = useState<'saas' | 'enterprise'>('enterprise');
  const [deploymentType, setDeploymentType] = useState<'hosted' | 'client_server'>('client_server');
  // Presets are a convenience, not a limit — 'custom' opens a plain months
  // input so this is never locked to exactly these four numbers (backend
  // already accepts any expiresAt; this is purely a UI control over it).
  const [validityPreset, setValidityPreset] = useState<'3' | '6' | '12' | '24' | 'custom'>('6');
  const [customMonths, setCustomMonths] = useState('6');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

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
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not issue a license key.');
    } finally {
      setIssuing(false);
    }
  }

  async function handleApprove(licenseId: string) {
    setApprovingId(licenseId);
    setError(null);
    try {
      await platformAdminFetch(`/platform-admin/organisations/${tenantId}/licenses/${licenseId}/approve`, {
        method: 'POST',
      });
      await refresh();
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not approve this license.');
    } finally {
      setApprovingId(null);
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
                  <td><span className={STATUS_BADGE[l.status]}>{l.status}</span></td>
                  <td>
                    {l.approvedAt ? (
                      <span className="badge success">Approved {fmt(l.approvedAt)}</span>
                    ) : (
                      <button
                        onClick={() => handleApprove(l.id)}
                        disabled={approvingId === l.id}
                        data-testid={`approve-license-${l.id}`}
                      >
                        {approvingId === l.id ? 'Approving…' : 'Approve'}
                      </button>
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
