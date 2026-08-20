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
 *   login ─▶ verify    ├─▶ session (accessToken) ─▶ /dashboard
 *         └▶ enrol ─────┘
 *
 * No route hands back a session for a password alone — MFA is mandatory — so this
 * screen is a small state machine that walks the challenge → code → session steps.
 * The enrol step itself (QR code, confirm, recovery codes) is <MfaEnroll>,
 * shared with /accept-invite — both flows end the same way: a brand-new
 * account proving its authenticator works for the first time.
 */
type Step = 'login' | 'register' | 'license' | 'enroll' | 'verify';

interface LoginResult {
  outcome: 'mfa_required' | 'mfa_enrolment_required';
  challengeToken: string;
}
interface IssuedLicense {
  plan: 'saas' | 'enterprise';
  deploymentType: 'hosted' | 'client_server';
  licenseKeyPrefix: string;
  licenseKey: string;
}
interface RegisterResult {
  mfaEnrolmentToken: string;
  license: IssuedLicense;
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
  const [plan, setPlan] = useState<'saas' | 'enterprise'>('saas');
  const [code, setCode] = useState('');

  // carried between steps
  const [challengeToken, setChallengeToken] = useState('');
  const [issuedLicense, setIssuedLicense] = useState<IssuedLicense | null>(null);

  const canLogin = email.trim().length > 0 && password.length > 0;
  const canRegister =
    orgName.trim().length > 0 &&
    ownerName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 12;
  const canVerify = code.trim().length === 6;

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
        body: { organisationName: orgName, ownerName, ownerEmail: email, password, plan },
      });
      setChallengeToken(res.mfaEnrolmentToken);
      setIssuedLicense(res.license);
      // Show the license key BEFORE MFA enrolment — it is returned exactly
      // once, here, and never retrievable again (only its hash/prefix are
      // persisted). This is the key that activates DPDP's first installation.
      setStep('license');
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
      router.replace('/dashboard');
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
                <button className="primary" type="submit" disabled={busy || !canLogin}>
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
            <p className="muted">Create your workspace and Owner account.</p>
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
              <label>Plan</label>
              <select value={plan} onChange={(e) => setPlan(e.target.value as 'saas' | 'enterprise')}>
                <option value="saas">SaaS</option>
                <option value="enterprise">Enterprise</option>
              </select>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>
                A unique license for this organisation is issued automatically — you&apos;ll use it to
                activate DPDP on this computer.
              </p>
              {error && <div className="error">{error}</div>}
              <div style={{ marginTop: 16 }}>
                <button className="primary" type="submit" disabled={busy || !canRegister}>
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

        {step === 'license' && issuedLicense && (
          <>
            <h2>Your license</h2>
            <p className="notice">
              Shown once — it is not stored anywhere you can retrieve it again. Save it now; you&apos;ll
              enter it on DPDP&apos;s activation screen the first time you open this installation.
            </p>
            <p className="muted" style={{ marginBottom: 4 }}>
              Plan: <strong>{issuedLicense.plan === 'enterprise' ? 'Enterprise' : 'SaaS'}</strong>{' '}
              &middot; Deployment type: <strong>{issuedLicense.deploymentType}</strong>
            </p>
            <label>License key</label>
            <div className="mono panel" style={{ padding: 12, wordBreak: 'break-all' }}>
              {issuedLicense.licenseKey}
            </div>
            <div style={{ marginTop: 16 }}>
              <button
                className="primary"
                onClick={() => {
                  setIssuedLicense(null);
                  setStep('enroll');
                }}
              >
                I&apos;ve saved it — continue to MFA setup
              </button>
            </div>
          </>
        )}

        {step === 'enroll' && (
          <MfaEnroll challengeToken={challengeToken} onDone={() => router.replace('/dashboard')} />
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
                <button className="primary" type="submit" disabled={busy || !canVerify}>
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
