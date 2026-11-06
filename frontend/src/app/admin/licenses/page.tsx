'use client';

import { useEffect, useState } from 'react';
import {
  clearPlatformAdminToken,
  getPlatformAdminToken,
  platformAdminFetch,
  PlatformAdminApiError,
  setPlatformAdminToken,
} from '../../../lib/platform-admin-api';
import { PlatformAdminLicensePanel } from '../../../components/PlatformAdminLicensePanel';

/**
 * Standalone admin utility, deliberately OUTSIDE the (app) shell — no
 * sidebar, no main nav entry, reached only by knowing this URL
 * (/admin/licenses). A genuinely CROSS-TENANT tool: its own login (a
 * platform_admin credential that belongs to no tenant at all — see the
 * platform-admin migration), its own token (dpdp.platformAdminToken, never
 * mixed with a normal tenant session), and a picker across every client org
 * rather than whatever org the caller happens to belong to.
 */

interface OrganisationSummary {
  id: string;
  name: string;
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  ownerEmail: string | null;
  createdAt: string;
}

function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const data = await platformAdminFetch<{ accessToken: string }>('/platform-admin/login', {
        method: 'POST',
        body: { email, password },
        auth: false,
      });
      setPlatformAdminToken(data.accessToken);
      onSignedIn();
    } catch (err) {
      setError(err instanceof PlatformAdminApiError ? err.message : 'Could not sign in.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="panel" style={{ maxWidth: 420, width: '100%' }}>
        <h1 style={{ marginTop: 0 }}>License administration</h1>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Internal tool, not linked from the main app. Sign in with a platform-admin credential.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && (
          <p className="muted" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function OrganisationPicker() {
  const [orgs, setOrgs] = useState<OrganisationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<OrganisationSummary | null>(null);

  useEffect(() => {
    platformAdminFetch<{ organisations: OrganisationSummary[] }>('/platform-admin/organisations')
      .then((data) => setOrgs(data.organisations))
      .catch((err) => {
        if (err instanceof PlatformAdminApiError && err.status === 401) {
          clearPlatformAdminToken();
          window.location.reload();
          return;
        }
        setError(err instanceof PlatformAdminApiError ? err.message : 'Could not load organisations.');
      });
  }, []);

  function handleSignOut() {
    clearPlatformAdminToken();
    window.location.reload();
  }

  const filtered =
    orgs?.filter((o) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return o.name.toLowerCase().includes(q) || (o.ownerEmail ?? '').toLowerCase().includes(q);
    }) ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>License administration</h1>
        <button className="link-button" onClick={handleSignOut}>
          Sign out
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Pick a client organisation to manage its license keys.</p>

      {error && <p className="muted" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }}>{error}</p>}

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
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((o) => (
                    <tr key={o.id}>
                      <td>{o.name}</td>
                      <td>{o.ownerEmail ?? '—'}</td>
                      <td>{o.plan}</td>
                      <td>{o.deploymentType}</td>
                      <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                      <td>
                        <button onClick={() => setSelected(o)} data-testid={`select-org-${o.id}`}>
                          Manage licenses
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="muted" style={{ fontSize: '0.85rem' }}>No matching organisations.</p>}
            </div>
          )}
        </div>
      )}

      {selected && (
        <>
          <button className="link-button" onClick={() => setSelected(null)} style={{ marginTop: 16 }}>
            ← Back to organisation list
          </button>
          <PlatformAdminLicensePanel tenantId={selected.id} tenantName={selected.name} />
        </>
      )}
    </div>
  );
}

export default function AdminLicensesPage() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    setSignedIn(getPlatformAdminToken() !== null);
  }, []);

  if (signedIn === null) return null;
  if (!signedIn) return <LoginForm onSignedIn={() => setSignedIn(true)} />;
  return <OrganisationPicker />;
}
