'use client';

import { useState } from 'react';
import { platformAdminFetch, PlatformAdminApiError, setPlatformAdminToken } from '../../lib/platform-admin-api';

/**
 * Platform-admin sign-in (moved unchanged in behaviour from the original
 * /admin/licenses page): email + password against POST /platform-admin/login,
 * which returns a platform_admin token that belongs to no tenant.
 */
export function AdminLoginForm({ onSignedIn }: { onSignedIn: () => void }) {
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
      setPassword('');
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
        <h1 style={{ marginTop: 0 }}>DPDP Admin</h1>
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Internal tool for DPDP platform administrators. Not linked from the customer app. Sign in with a
          platform-admin credential.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem' }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {error && (
          <p className="muted" role="alert" style={{ color: 'var(--color-danger, #b91c1c)', fontSize: '0.85rem' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
