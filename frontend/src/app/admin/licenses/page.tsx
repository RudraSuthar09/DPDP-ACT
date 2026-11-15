'use client';

import { useCallback, useEffect, useState } from 'react';
import { LicenseDecisionButtons } from '../../../components/admin/LicenseDecisionButtons';
import { PlatformAdminLicensePanel } from '../../../components/PlatformAdminLicensePanel';
import {
  BUCKET_BADGE,
  BUCKET_LABEL,
  DEPLOYMENT_LABEL,
  fetchAllLicenses,
  fetchOrganisations,
  fmtDate,
  licenseBucket,
  PLAN_LABEL,
  type AdminLicenseView,
  type LicenseBucket,
  type OrganisationSummary,
} from '../../../lib/admin-licenses';
import { PlatformAdminApiError } from '../../../lib/platform-admin-api';

/**
 * /admin/licenses (same URL as before) — every licence of every customer,
 * searchable and filterable by lifecycle state, with Approve / Reject for
 * pending requests and the existing issuance panel for a chosen customer.
 *
 * Licence keys are never shown here: only their prefix. A full key is shown
 * exactly once — to the customer at registration, or to the admin right after
 * issuing one in the panel below. A lost key is replaced by issuing and
 * approving a new licence; activating it supersedes the old one.
 */
const FILTERS: { value: 'all' | LicenseBucket; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending_approval', label: BUCKET_LABEL.pending_approval },
  { value: 'approved', label: 'Approved (awaiting activation)' },
  { value: 'active', label: BUCKET_LABEL.active },
  { value: 'expired', label: BUCKET_LABEL.expired },
  { value: 'rejected', label: BUCKET_LABEL.rejected },
  { value: 'revoked', label: BUCKET_LABEL.revoked },
];

export default function AdminLicensesPage() {
  const [licenses, setLicenses] = useState<AdminLicenseView[] | null>(null);
  const [orgs, setOrgs] = useState<OrganisationSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | LicenseBucket>('all');
  const [issueFor, setIssueFor] = useState<string>('');

  const load = useCallback(async () => {
    try {
      const [l, o] = await Promise.all([fetchAllLicenses(), fetchOrganisations()]);
      setLicenses(l);
      setOrgs(o);
      setError(null);
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load licences.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const q = query.trim().toLowerCase();
  const rows = (licenses ?? []).filter((l) => {
    if (filter !== 'all' && licenseBucket(l) !== filter) return false;
    if (!q) return true;
    return (
      l.organisationName.toLowerCase().includes(q) ||
      (l.ownerEmail ?? '').toLowerCase().includes(q) ||
      l.licenseKeyPrefix.toLowerCase().includes(q)
    );
  });
  const issueOrg = orgs.find((o) => o.id === issueFor) ?? null;

  return (
    <div>
      <h1>Licence management</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Review, approve or reject licence requests. A customer activates an approved key in Settings →
        Installation &amp; licensing; full keys are never stored or shown again after issuance.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </p>
      )}

      <div className="panel">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            placeholder="Search organisation, owner email or key prefix…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: '1 1 260px' }}
            data-testid="licenses-search"
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} data-testid="licenses-filter">
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>

        {licenses === null && !error && <p className="muted">Loading licences…</p>}
        {licenses !== null && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Owner email</th>
                  <th>Plan</th>
                  <th>Deployment</th>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Issued</th>
                  <th>Expires</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const bucket = licenseBucket(l);
                  return (
                    <tr key={l.id} data-testid={`license-row-${l.id}`}>
                      <td>{l.organisationName}</td>
                      <td>{l.ownerEmail ?? '—'}</td>
                      <td>{PLAN_LABEL[l.plan] ?? l.plan}</td>
                      <td>{DEPLOYMENT_LABEL[l.deploymentType] ?? l.deploymentType}</td>
                      <td className="mono">{l.licenseKeyPrefix}…</td>
                      <td>
                        <span className={BUCKET_BADGE[bucket]} data-testid={`license-status-${l.id}`}>
                          {BUCKET_LABEL[bucket]}
                        </span>
                        {l.revokeReason && (
                          <div className="muted" style={{ fontSize: '0.75rem', marginTop: 4 }}>
                            {l.revokeReason}
                          </div>
                        )}
                      </td>
                      <td>{fmtDate(l.issuedAt)}</td>
                      <td>{fmtDate(l.expiresAt)}</td>
                      <td>
                        {bucket === 'pending_approval' ? (
                          <LicenseDecisionButtons tenantId={l.tenantId} licenseId={l.id} onDone={load} />
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>No licences match.</p>}
          </div>
        )}
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Issue a licence</h2>
        <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
          For a new entitlement or a lost key. Choose the customer; the key is shown once after issuing, and it
          still needs your approval before it can be activated.
        </p>
        <select value={issueFor} onChange={(e) => setIssueFor(e.target.value)} data-testid="issue-org-select">
          <option value="">Choose an organisation…</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.ownerEmail ? ` — ${o.ownerEmail}` : ''}
            </option>
          ))}
        </select>
        {issueOrg && <PlatformAdminLicensePanel tenantId={issueOrg.id} tenantName={issueOrg.name} onChanged={load} />}
      </div>
    </div>
  );
}
