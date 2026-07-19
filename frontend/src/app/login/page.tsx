'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiFetch, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { MfaEnroll } from '../../components/MfaEnroll';

/**
 * The full authentication surface from Prompt 4, driven against the REAL endpoints:
 *
 *   register ─▶ enrol ─┐
 *   login ─▶ verify    ├─▶ session (accessToken) ─▶ /audit
 *         └▶ enrol ─────┘
 *
 * No route hands back a session for a password alone — MFA is mandatory — so this
 * screen is a small state machine that walks the challenge → code → session steps.
 * The enrol step itself (QR code, confirm, recovery codes) is <MfaEnroll>,
 * shared with /accept-invite — both flows end the same way: a brand-new
 * account proving its authenticator works for the first time.
 */
type Step = 'login' | 'register' | 'enroll' | 'verify';

interface LoginResult {
  outcome: 'mfa_required' | 'mfa_enrolment_required';
  challengeToken: string;
}
interface RegisterResult {
  mfaEnrolmentToken: string;
}
interface Session {
  accessToken: string;
}

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [step, setStep] = useState<Step>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [code, setCode] = useState('');

  // carried between steps
  const [challengeToken, setChallengeToken] = useState('');

  function fail(e: unknown) {
    setError(e instanceof ApiError ? e.message : 'Something went wrong.');
  }

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<LoginResult>('/auth/login', {
        method: 'POST',
        auth: false,
        body: { email, password },
      });
      setChallengeToken(res.challengeToken);
      setCode('');
      setStep(res.outcome === 'mfa_required' ? 'verify' : 'enroll');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onRegister(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<RegisterResult>('/auth/register', {
        method: 'POST',
        auth: false,
        body: { organisationName: orgName, ownerName, ownerEmail: email, password },
      });
      setChallengeToken(res.mfaEnrolmentToken);
      setStep('enroll');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await apiFetch<Session>('/auth/mfa/verify', {
        method: 'POST',
        auth: false,
        body: { challengeToken, code },
      });
      await signIn(session.accessToken);
      router.replace('/audit');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <h1>DPDP Compliance Platform</h1>

        {step === 'login' && (
          <>
            <p className="muted">Sign in to your workspace.</p>
            <form onSubmit={onLogin}>
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && <div className="error">{error}</div>}
              <div style={{ marginTop: 16 }}>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </div>
            </form>
            <p className="muted" style={{ marginTop: 18 }}>
              No workspace yet?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setError(null);
                  setStep('register');
                }}
              >
                Register your organisation
              </a>
            </p>
          </>
        )}

        {step === 'register' && (
          <>
            <p className="muted">Create your workspace and Owner account (FR-IDN-01).</p>
            <form onSubmit={onRegister}>
              <label>Organisation name</label>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
              <label>Your name</label>
              <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
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
                  {busy ? 'Creating…' : 'Create workspace'}
                </button>
              </div>
            </form>
            <p className="muted" style={{ marginTop: 18 }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setError(null);
                  setStep('login');
                }}
              >
                Back to sign in
              </a>
            </p>
          </>
        )}

        {step === 'enroll' && (
          <MfaEnroll challengeToken={challengeToken} onDone={() => router.replace('/audit')} />
        )}

        {step === 'verify' && (
          <>
            <p className="muted">Enter the 6-digit code from your authenticator app.</p>
            <form onSubmit={onVerify}>
              <label>6-digit code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
              />
              {error && <div className="error">{error}</div>}
              <div style={{ marginTop: 16 }}>
                <button className="primary" type="submit" disabled={busy}>
                  {busy ? 'Verifying…' : 'Verify'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
