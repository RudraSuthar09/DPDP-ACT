'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { LicenseDecisionButtons } from '../../components/admin/LicenseDecisionButtons';
import {
  DEPLOYMENT_LABEL,
  fetchAllLicenses,
  fetchOrganisations,
  fmtDate,
  licenseBucket,
  PLAN_LABEL,
  type AdminLicenseView,
  type LicenseBucket,
  type OrganisationSummary,
} from '../../lib/admin-licenses';
import { PlatformAdminApiError } from '../../lib/platform-admin-api';

/** /admin — overview counts and the queue of licence requests awaiting a decision. */
export default function AdminOverviewPage() {
  const [orgs, setOrgs] = useState<OrganisationSummary[] | null>(null);
  const [licenses, setLicenses] = useState<AdminLicenseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([fetchOrganisations(), fetchAllLicenses()]);
      setOrgs(o);
      setLicenses(l);
      setError(null);
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load the overview.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const count = (b: LicenseBucket | LicenseBucket[]) => {
    const set = new Set(Array.isArray(b) ? b : [b]);
    return licenses?.filter((l) => set.has(licenseBucket(l))).length ?? 0;
  };
  const pending = licenses?.filter((l) => licenseBucket(l) === 'pending_approval') ?? [];

  const tiles: { label: string; value: number | string; testId: string }[] = [
    { label: 'Organisations', value: orgs?.length ?? '—', testId: 'tile-organisations' },
    { label: 'Pending approval', value: licenses ? count('pending_approval') : '—', testId: 'tile-pending' },
    { label: 'Approved, awaiting activation', value: licenses ? count('approved') : '—', testId: 'tile-approved' },
    { label: 'Active', value: licenses ? count('active') : '—', testId: 'tile-active' },
    { label: 'Expired', value: licenses ? count('expired') : '—', testId: 'tile-expired' },
    { label: 'Revoked / rejected', value: licenses ? count(['revoked', 'rejected']) : '—', testId: 'tile-revoked' },
  ];

  return (
    <div>
      <h1>Overview</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Licence requests across every customer organisation.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, marginBottom: 24 }}>
        {tiles.map((t) => (
          <div key={t.label} className="panel" style={{ padding: 16 }}>
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              {t.label}
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700 }} data-testid={t.testId}>
              {t.value}
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Pending licence requests</h2>
        {licenses === null && !error && <p className="muted">Loading…</p>}
        {licenses !== null && pending.length === 0 && <p className="muted">Nothing is waiting for approval.</p>}
        {pending.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Owner email</th>
                  <th>Plan</th>
                  <th>Deployment</th>
                  <th>Key</th>
                  <th>Requested</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((l) => (
                  <tr key={l.id} data-testid={`pending-row-${l.id}`}>
                    <td>{l.organisationName}</td>
                    <td>{l.ownerEmail ?? '—'}</td>
                    <td>{PLAN_LABEL[l.plan] ?? l.plan}</td>
                    <td>{DEPLOYMENT_LABEL[l.deploymentType] ?? l.deploymentType}</td>
                    <td className="mono">{l.licenseKeyPrefix}…</td>
                    <td>{fmtDate(l.issuedAt)}</td>
                    <td>
                      <LicenseDecisionButtons tenantId={l.tenantId} licenseId={l.id} onDone={load} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>
          All licences: <Link href="/admin/licenses">Licence management</Link>.
        </p>
      </div>
    </div>
  );
}
