'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  REQUEST_TYPES,
  CONTACT_CHANNELS,
  GRIEVANCE_CATEGORIES,
  GRIEVANCE_CATEGORY_LABELS,
  DPR_RIGHT_TYPES,
  DPR_RIGHT_TYPE_LABELS,
  type RequestType,
  type ContactChannel,
  type GrievanceCategory,
  type DprRightType,
} from '@dpdp/shared';
import { portalFetch, PortalApiError } from '../../../lib/portal-api';
import { portalTokenKey } from '../../../lib/portal-session';

/**
 * The three-step public intake (FR-GRV-01/03): submit → prove the contact
 * channel with a one-time code → confirmation with a reference number.
 *
 * A client component nested inside the server-rendered `page.tsx` — the
 * branding and page shell are already in the HTML the browser received; only
 * the interactive stepper needs to hydrate. Nothing here reads or writes the
 * staff bearer token in `localStorage` (see `portal-api.ts`); the only
 * credential this flow ever holds is the short-lived portal token OTP
 * verification hands back, kept in `sessionStorage` and never put in a URL.
 */

type Step = 'form' | 'otp' | 'confirmation';

interface SubmitResponse {
  ticketId: string;
  referenceCode: string;
  status: string;
  contactChannel: ContactChannel;
  maskedContact: string;
  otpExpiresAt: string;
  devOtp?: string;
  category?: GrievanceCategory;
  rightType?: DprRightType;
}

interface VerifyResponse {
  referenceCode: string;
  status: string;
  portalToken: string;
  slaDueAt: string;
}

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  grievance: 'Complaint / grievance',
  dprequest: 'Data principal (rights) request',
};

export function PortalIntake({ slug }: { slug: string }) {
  const [step, setStep] = useState<Step>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 fields
  const [requestType, setRequestType] = useState<RequestType>('grievance');
  const [category, setCategory] = useState<GrievanceCategory>('other');
  const [rightType, setRightType] = useState<DprRightType>('access');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [contactChannel, setContactChannel] = useState<ContactChannel>('email');
  const [contactValue, setContactValue] = useState('');

  // Carried between steps
  const [submitted, setSubmitted] = useState<SubmitResponse | null>(null);
  const [code, setCode] = useState('');
  const [devOtp, setDevOtp] = useState<string | undefined>(undefined);
  const [maskedContact, setMaskedContact] = useState('');
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  const [confirmation, setConfirmation] = useState<VerifyResponse | null>(null);

  function fail(err: unknown) {
    setError(err instanceof PortalApiError ? err.message : 'Something went wrong. Please try again.');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Each module has its own front door, and for the same reason: both
      // capture one module-specific fact in the SAME request/transaction as
      // the ticket (the complaint's category, the request's right), so it
      // lands in the same audit entry rather than in a follow-up call that
      // could fail on its own. Neither is a second submission path — both
      // routes run the identical RequestPortalService.submit underneath.
      //
      // The rights type is not cosmetic on this form: it selects which
      // versioned statutory-deadline record the request will be judged
      // under, which is why it is posted with the submission rather than
      // set by staff afterwards.
      const res =
        requestType === 'grievance'
          ? await portalFetch<SubmitResponse>(`/portal/${slug}/grievances`, {
              method: 'POST',
              body: { category, subject, body, contactChannel, contactValue },
            })
          : await portalFetch<SubmitResponse>(`/portal/${slug}/data-requests`, {
              method: 'POST',
              body: { rightType, subject, body, contactChannel, contactValue },
            });
      setSubmitted(res);
      setMaskedContact(res.maskedContact);
      setDevOtp(res.devOtp);
      setCode('');
      setStep('otp');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!submitted) return;
    setBusy(true);
    setError(null);
    try {
      const res = await portalFetch<VerifyResponse>(
        `/portal/${slug}/requests/${submitted.ticketId}/otp/verify`,
        { method: 'POST', body: { code } },
      );
      // Kept only for this tab's session — enough to view/reply to this one
      // request without turning the reference code into a bearer secret.
      window.sessionStorage.setItem(portalTokenKey(submitted.ticketId), res.portalToken);
      setConfirmation(res);
      setStep('confirmation');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    if (!submitted) return;
    setResendBusy(true);
    setResendMessage(null);
    setError(null);
    try {
      const res = await portalFetch<{ otpExpiresAt: string; maskedContact: string; devOtp?: string }>(
        `/portal/${slug}/requests/${submitted.ticketId}/otp`,
        { method: 'POST' },
      );
      setDevOtp(res.devOtp);
      setResendMessage('A new code has been sent.');
    } catch (err) {
      fail(err);
    } finally {
      setResendBusy(false);
    }
  }

  if (step === 'confirmation' && confirmation && submitted) {
    return (
      <div className="portal-confirmation" data-testid="portal-confirmation">
        <div className="portal-check">✓</div>
        <h2>Request received</h2>
        <p className="muted">
          The organisation must now confirm your identity against their own records before they can
          respond (this platform never sees or stores who you are). Save your reference number —
          quote it in any follow-up.
        </p>
        <div className="portal-reference" data-testid="reference-code">
          {confirmation.referenceCode}
        </div>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Response due by {new Date(confirmation.slaDueAt).toLocaleString()}.
        </p>
        <Link
          href={`/portal/${slug}/status/${submitted.ticketId}`}
          className="portal-status-link"
        >
          View status of this request →
        </Link>
      </div>
    );
  }

  if (step === 'otp' && submitted) {
    return (
      <form className="portal-form" onSubmit={onVerify} data-testid="portal-otp-form">
        <h2>Enter your code</h2>
        <p className="muted">
          We sent a 6-digit code to {maskedContact} ({submitted.contactChannel}). It expires at{' '}
          {new Date(submitted.otpExpiresAt).toLocaleTimeString()}.
        </p>

        {devOtp && (
          <div className="notice" data-testid="dev-otp">
            Development mode: your code is <strong>{devOtp}</strong>.
          </div>
        )}

        <label htmlFor="otp-code">6-digit code</label>
        <input
          id="otp-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
        />

        {error && <div className="error">{error}</div>}
        {resendMessage && <div className="notice">{resendMessage}</div>}

        <div className="portal-actions">
          <button className="primary" type="submit" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button type="button" onClick={() => void onResend()} disabled={resendBusy}>
            {resendBusy ? 'Sending…' : 'Resend code'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="portal-form" onSubmit={onSubmit} data-testid="portal-submit-form">
      <label htmlFor="request-type">What is this about?</label>
      <select
        id="request-type"
        value={requestType}
        onChange={(e) => setRequestType(e.target.value as RequestType)}
      >
        {REQUEST_TYPES.map((t) => (
          <option key={t} value={t}>
            {REQUEST_TYPE_LABELS[t]}
          </option>
        ))}
      </select>

      {requestType === 'dprequest' && (
        <>
          <label htmlFor="right-type">Which right are you exercising?</label>
          <select
            id="right-type"
            data-testid="right-type"
            value={rightType}
            onChange={(e) => setRightType(e.target.value as DprRightType)}
          >
            {DPR_RIGHT_TYPES.map((r) => (
              <option key={r} value={r}>
                {DPR_RIGHT_TYPE_LABELS[r]}
              </option>
            ))}
          </select>
        </>
      )}

      {requestType === 'grievance' && (
        <>
          <label htmlFor="category">What kind of complaint is this?</label>
          <select
            id="category"
            value={category}
            onChange={(e) => setCategory(e.target.value as GrievanceCategory)}
          >
            {GRIEVANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {GRIEVANCE_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </>
      )}

      <label htmlFor="subject">Subject</label>
      <input
        id="subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        minLength={3}
        maxLength={200}
        placeholder="A short summary"
        required
      />

      <label htmlFor="body">Details</label>
      <textarea
        id="body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        minLength={10}
        maxLength={10000}
        rows={6}
        placeholder="Describe your request or complaint"
        required
      />

      <label htmlFor="contact-channel">How should we reach you to verify it&apos;s you?</label>
      <select
        id="contact-channel"
        value={contactChannel}
        onChange={(e) => setContactChannel(e.target.value as ContactChannel)}
      >
        {CONTACT_CHANNELS.map((c) => (
          <option key={c} value={c}>
            {c === 'email' ? 'Email' : 'SMS'}
          </option>
        ))}
      </select>

      <label htmlFor="contact-value">{contactChannel === 'email' ? 'Email address' : 'Phone number'}</label>
      <input
        id="contact-value"
        type={contactChannel === 'email' ? 'email' : 'tel'}
        value={contactValue}
        onChange={(e) => setContactValue(e.target.value)}
        placeholder={contactChannel === 'email' ? 'you@example.com' : '+91XXXXXXXXXX'}
        required
      />

      {error && <div className="error">{error}</div>}

      <div className="portal-actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </div>
    </form>
  );
}
