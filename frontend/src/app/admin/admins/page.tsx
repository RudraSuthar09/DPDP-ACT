'use client';

import { useEffect, useState } from 'react';
import { fmtDateTime } from '../../../lib/admin-licenses';
import { platformAdminFetch, PlatformAdminApiError } from '../../../lib/platform-admin-api';

/**
 * /admin/admins — read-only list of platform administrators. All have equal
 * permissions. Admins are created or have their password reset only with
 * scripts/create-platform-admin.mjs on the server (no sign-up endpoint).
 */
interface AdminSummary {
  id: string;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export default function AdminUsersPage() {
  const [admins, setAdmins] = useState<AdminSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    platformAdminFetch<{ admins: AdminSummary[] }>('/platform-admin/admins')
      .then((d) => setAdmins(d.admins))
      .catch((err) => setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load administrators.'));
  }, []);

  return (
    <div>
      <h1>Admin users</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Platform administrators. Every administrator has the same permissions. Accounts are created on the server
        with <span className="mono">scripts/create-platform-admin.mjs</span>; there is no sign-up page.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>
          {error}
        </p>
      )}
      <div className="panel">
        {admins === null && !error && <p className="muted">Loading…</p>}
        {admins && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Created</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.id} data-testid="admin-row">
                    <td>{a.email}</td>
                    <td>{fmtDateTime(a.createdAt)}</td>
                    <td>{fmtDateTime(a.lastLoginAt)}</td>
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
