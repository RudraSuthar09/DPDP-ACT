'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, ApiError } from '../../lib/api';
import { MfaEnroll } from '../../components/MfaEnroll';

/**
 * FR-IDN-05 — the invited person completing sign-up. Reached via the link an
 * Owner/DPO copies out of the Team screen (`/accept-invite?token=...`), NOT a
 * login screen: there is no existing account yet. On success this ends in the
 * exact same MfaEnroll component /login uses — accepting an invite and
 * self-registering both terminate in "prove your authenticator works."
 */
interface AcceptResult {
  organisationName: string;
  mfaEnrolmentToken: string;
}

function AcceptInviteForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptResult | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<AcceptResult>('/auth/invitations/accept', {
        method: 'POST',
        auth: false,
        body: { inviteToken: token, fullName, password },
      });
      setAccepted(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1>DPDP Compliance Platform</h1>
          <div className="error">
            This link is missing its invitation token. Ask whoever invited you for the full link.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>DPDP Compliance Platform</h1>

        {!accepted && (
          <>
            <p className="muted">You&apos;ve been invited to join a workspace. Set your name and a password.</p>
            <form onSubmit={onSubmit}>
              <label>Your name</label>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              <label>Password (min 12 characters)</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && <div className="error">{error}</div>}
              <div style={{ marginTop: 16 }}>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Joining…' : 'Accept invitation'}
                </button>
              </div>
            </form>
          </>
        )}

        {accepted && (
          <>
            <p className="muted">Joining {accepted.organisationName}.</p>
            <MfaEnroll
              challengeToken={accepted.mfaEnrolmentToken}
              onDone={() => router.replace('/dashboard')}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default function AcceptInvitePage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <AcceptInviteForm />
    </Suspense>
  );
}
