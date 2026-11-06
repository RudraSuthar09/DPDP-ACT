import type { PublicFormUnavailableReason } from '@dpdp/shared';

/**
 * What a visitor is told when a hosted consent-form link does not open.
 *
 * Four distinct situations, deliberately NOT collapsed into one message: a
 * mistyped link, a form the organisation switched off, a form nobody has
 * finished building, and our own API failing. The last one in particular must
 * never be reported as a bad link — the visitor would blame the link they were
 * given and give up, when retrying in a minute is the right advice.
 *
 * None of the copy below names the organisation, the form, or any id.
 */
const COPY: Record<PublicFormUnavailableReason, { title: string; body: string }> = {
  FORM_NOT_FOUND: {
    title: "We couldn't find that form",
    body: "This link doesn't match a consent form on this platform. Check the link you were given, or contact the organisation directly.",
  },
  FORM_NOT_LIVE: {
    title: 'This form is not accepting responses',
    body: 'The organisation has switched this form off. If you were asked to fill it in, please contact them for a current link.',
  },
  FORM_NOT_READY: {
    title: 'This form is not ready yet',
    body: "The organisation is still setting this form up, so there is nothing to consent to yet. Please try again later or contact them directly.",
  },
};

export function FormUnavailable({ reason }: { reason: PublicFormUnavailableReason }) {
  const { title, body } = COPY[reason];
  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <h1>{title}</h1>
        <p className="muted">{body}</p>
      </div>
    </div>
  );
}

/** Our side failed, not the link. Says so, and invites a retry. */
export function FormTemporarilyUnavailable() {
  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <h1>This form can&apos;t be loaded right now</h1>
        <p className="muted">
          Something went wrong on our side, so we couldn&apos;t load the form. The link is fine —
          please reload this page in a minute. If it keeps happening, contact the organisation that
          sent it to you.
        </p>
      </div>
    </div>
  );
}
