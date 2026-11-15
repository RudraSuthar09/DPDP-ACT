'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlatformAdminLicensePanel } from '../../../components/PlatformAdminLicensePanel';
import {
  DEPLOYMENT_LABEL,
  fetchAllLicenses,
  fetchOrganisations,
  fmtDate,
  licenseBucket,
  PLAN_LABEL,
  type AdminLicenseView,
  type OrganisationSummary,
} from '../../../lib/admin-licenses';
import { PlatformAdminApiError } from '../../../lib/platform-admin-api';

/**
 * /admin/customers — the existing organisation list (moved here from the
 * original /admin/licenses page), with a licence summary per organisation,
 * and the existing PlatformAdminLicensePanel for the selected one.
 */
export default function AdminCustomersPage() {
  const [orgs, setOrgs] = useState<OrganisationSummary[] | null>(null);
  const [licenses, setLicenses] = useState<AdminLicenseView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<OrganisationSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, l] = await Promise.all([fetchOrganisations(), fetchAllLicenses()]);
      setOrgs(o);
      setLicenses(l);
      setError(null);
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load organisations.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const m = new Map<string, { total: number; pending: number; active: number }>();
    for (const l of licenses) {
      const s = m.get(l.tenantId) ?? { total: 0, pending: 0, active: 0 };
      s.total += 1;
      const b = licenseBucket(l);
      if (b === 'pending_approval') s.pending += 1;
      if (b === 'active') s.active += 1;
      m.set(l.tenantId, s);
    }
    return m;
  }, [licenses]);

  const q = query.trim().toLowerCase();
  const filtered = (orgs ?? []).filter(
    (o) => !q || o.name.toLowerCase().includes(q) || (o.ownerEmail ?? '').toLowerCase().includes(q),
  );

  return (
    <div>
      <h1>Customers</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Customer organisations and their licences. Plan and deployment shown here are the organisation&apos;s
        defaults; an active licence is what actually sets entitlements.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </p>
      )}

      {!selected && (
        <div className="panel">
          <input
            placeholder="Search by organisation name or owner email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%', marginBottom: 12 }}
            autoFocus
          />
          {orgs === null && !error && <p className="muted">Loading organisations…</p>}
          {orgs !== null && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>Owner email</th>
                    <th>Plan</th>
                    <th>Deployment</th>
                    <th>Created</th>
                    <th>Licences</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => {
                    const s = summary.get(o.id);
                    return (
                      <tr key={o.id}>
                        <td>{o.name}</td>
                        <td>{o.ownerEmail ?? '—'}</td>
                        <td>{PLAN_LABEL[o.plan] ?? o.plan}</td>
                        <td>{DEPLOYMENT_LABEL[o.deploymentType] ?? o.deploymentType}</td>
                        <td>{fmtDate(o.createdAt)}</td>
                        <td>
                          {s ? (
                            <>
                              {s.total} total
                              {s.pending > 0 && <span className="badge info" style={{ marginLeft: 6 }}>{s.pending} pending</span>}
                              {s.active > 0 && <span className="badge success" style={{ marginLeft: 6 }}>{s.active} active</span>}
                            </>
                          ) : (
                            <span className="muted">none</span>
                          )}
                        </td>
                        <td>
                          <button onClick={() => setSelected(o)} data-testid={`select-org-${o.id}`}>
                            Manage licences
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>No matching organisations.</p>}
            </div>
          )}
        </div>
      )}

      {selected && (
        <>
          <button className="link-button" onClick={() => setSelected(null)} style={{ marginTop: 4 }}>
            ← Back to customers
          </button>
          <p className="muted" style={{ marginBottom: 0 }}>
            {selected.name} · {selected.ownerEmail ?? 'no owner email'} · created {fmtDate(selected.createdAt)}
          </p>
          <PlatformAdminLicensePanel tenantId={selected.id} tenantName={selected.name} onChanged={load} />
        </>
      )}
    </div>
  );
}
