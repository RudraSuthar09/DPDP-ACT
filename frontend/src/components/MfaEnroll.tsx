'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiFetch, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * The MFA-enrolment flow: fetch a fresh secret for the given challenge token,
 * render it as a scannable QR code (falls back to a manual key), confirm a
 * code, show the one-time recovery codes, then hand control back via `onDone`.
 *
 * Shared by two callers that both end in "a brand-new account enrols MFA for
 * the first time": registration (`/login`) and invitation acceptance
 * (`/accept-invite`). Each only differs in how it got the challenge token —
 * this component does not care which.
 */
interface EnrolResult {
  otpauthUri: string;
  secret: string;
}
interface Session {
  accessToken: string;
  recoveryCodes?: string[];
}

export function MfaEnroll({
  challengeToken,
  onDone,
}: {
  challengeToken: string;
  onDone: () => void;
}) {
  const { signIn } = useAuth();

  const [enrolment, setEnrolment] = useState<EnrolResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Start enrolment as soon as we have a challenge token.
  useEffect(() => {
    let cancelled = false;
    apiFetch<EnrolResult>('/auth/mfa/enroll', {
      method: 'POST',
      auth: false,
      body: { challengeToken },
    })
      .then((res) => {
        if (!cancelled) setEnrolment(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not start MFA enrolment.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [challengeToken]);

  // Render the otpauth:// URI as a scannable PNG. Every standard authenticator
  // — Google Authenticator, Authy, and iOS's own Passwords app — reads this
  // format directly, so nothing here is platform-specific.
  useEffect(() => {
    if (!enrolment) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(enrolment.otpauthUri, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null); // falls back to the manual key below
      });
    return () => {
      cancelled = true;
    };
  }, [enrolment]);

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await apiFetch<Session>('/auth/mfa/confirm', {
        method: 'POST',
        auth: false,
        body: { challengeToken, code },
      });
      await signIn(session.accessToken);
      setRecoveryCodes(session.recoveryCodes ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <>
        <h2>Save your recovery codes</h2>
        <p className="notice">
          These are shown once and cannot be retrieved — store them somewhere safe. Each works once
          if you lose your authenticator.
        </p>
        <div className="mono panel" style={{ marginTop: 12 }}>
          {recoveryCodes.length ? (
            recoveryCodes.map((c) => <div key={c}>{c}</div>)
          ) : (
            <span className="muted">No recovery codes returned.</span>
          )}
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="primary" onClick={onDone}>
            Continue
          </button>
        </div>
      </>
    );
  }

  if (!enrolment) {
    return (
      <>
        <p className="muted">Preparing MFA enrolment…</p>
        {error && <div className="error">{error}</div>}
      </>
    );
  }

  return (
    <>
      <p className="muted">
        Set up two-factor authentication. Scan this QR code with an authenticator app — Google
        Authenticator, Authy, Microsoft Authenticator, or on iOS the built-in <strong>Passwords</strong>{' '}
        app (Settings → Passwords → tap “+” → Set Up Verification Code) — then enter the 6-digit
        code it shows.
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', margin: '16px 0' }}>
        {qrDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qrDataUrl}
            alt="Scan with your authenticator app"
            width={220}
            height={220}
            style={{ border: '1px solid var(--border)', borderRadius: 8 }}
          />
        ) : (
          <div
            className="panel muted"
            style={{
              width: 220,
              height: 220,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
            }}
          >
            Generating QR code…
          </div>
        )}
      </div>

      <details>
        <summary className="muted" style={{ cursor: 'pointer' }}>
          Can’t scan it? Enter the key manually
        </summary>
        <label>Setup key</label>
        <div className="mono panel" style={{ padding: 12 }}>
          {enrolment.secret}
        </div>
        <p className="muted" style={{ fontSize: '0.8rem' }}>
          In your authenticator app choose “Enter a setup key” and paste this. Time-based, 6 digits,
          30-second interval — the defaults every app expects.
        </p>
      </details>

      <form onSubmit={onConfirm}>
        <label>6-digit code</label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
        />
        {error && <div className="error">{error}</div>}
        <div style={{ marginTop: 16 }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Confirming…' : 'Confirm & finish'}
          </button>
        </div>
      </form>
    </>
  );
}
