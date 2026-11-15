'use client';

import { useEffect, useState } from 'react';
import { fetchOrganisations, fmtDateTime, type OrganisationSummary } from '../../../lib/admin-licenses';
import { platformAdminFetch, PlatformAdminApiError } from '../../../lib/platform-admin-api';

/**
 * /admin/audit — read-only licensing evidence from ONE customer's own
 * hash-chained audit log (registration, licence issued / approved / rejected /
 * revoked, installation activation). Each tenant's chain is separate, so the
 * view is per organisation. Platform-admin sign-ins have no tenant and are
 * recorded in the backend application log instead.
 */
interface AuditEntry {
  id: string;
  seq: number;
  occurredAt: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  hash: string;
}

const ACTION_LABEL: Record<string, string> = {
  'identity.organisation.registered': 'Organisation registered (licence requested)',
  'licensing.license.issued': 'Licence issued by customer staff',
  'licensing.license.issued_by_platform_admin': 'Licence issued by platform admin',
  'licensing.license.approved_by_platform_admin': 'Licence approved',
  'licensing.license.rejected_by_platform_admin': 'Licence rejected',
  'licensing.license.revoked': 'Licence revoked',
  'installation.installation.registered': 'Licence activated (installation registered)',
};

export default function AdminAuditPage() {
  const [orgs, setOrgs] = useState<OrganisationSummary[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOrganisations()
      .then(setOrgs)
      .catch((err) => setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load organisations.'));
  }, []);

  useEffect(() => {
    if (!tenantId) {
      setEntries(null);
      return;
    }
    setEntries(null);
    platformAdminFetch<{ entries: AuditEntry[] }>(`/platform-admin/organisations/${tenantId}/audit?limit=200`)
      .then((d) => {
        setEntries(d.entries);
        setError(null);
      })
      .catch((err) => setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load audit entries.'));
  }, [tenantId]);

  return (
    <div>
      <h1>Audit</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Licence lifecycle events from a customer&apos;s own tamper-evident audit chain (read-only).
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </p>
      )}
      <div className="panel">
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} data-testid="audit-org-select">
          <option value="">Choose an organisation…</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.ownerEmail ? ` — ${o.ownerEmail}` : ''}
            </option>
          ))}
        </select>

        {tenantId && entries === null && !error && <p className="muted">Loading…</p>}
        {entries && entries.length === 0 && <p className="muted">No licensing events recorded for this organisation.</p>}
        {entries && entries.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>When</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} data-testid={`audit-row-${e.action}`}>
                    <td className="mono">{e.seq}</td>
                    <td>{fmtDateTime(e.occurredAt)}</td>
                    <td>
                      {ACTION_LABEL[e.action] ?? e.action}
                      <div className="muted mono" style={{ fontSize: '0.72rem' }}>
                        {e.action}
                      </div>
                    </td>
                    <td>{e.actorLabel ?? (e.actorId ? 'customer user' : '—')}</td>
                    <td>{e.outcome}</td>
                    <td style={{ maxWidth: 360 }}>{e.reason ?? '—'}</td>
                    <td className="mono" title={e.hash}>
                      {e.hash.slice(0, 10)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
