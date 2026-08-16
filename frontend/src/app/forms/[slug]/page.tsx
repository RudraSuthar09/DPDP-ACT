import { notFound } from 'next/navigation';
import { formPortalFetchServer } from '../../../lib/form-portal-api';
import { FormIntake } from './FormIntake';

interface PublicFormRow {
  consentPurposeId: string;
  label: string;
  noticeText: string;
}
interface PublicFormDefinition {
  formId: string;
  name: string;
  description: string | null;
  /** Client-authored Notice/Terms & Conditions, shown once above the form's
   *  consent items. Plain text the client wrote — never generated here. */
  noticeText: string | null;
  rows: PublicFormRow[];
}

/**
 * The hosted consent form link (for a client with no website of their own) —
 * same server-component-first shape as the request portal's page.tsx: the
 * title, description and real purpose/notice text are all in the initial
 * HTML, with no client round trip needed just to see what the form asks.
 *
 * An unresolvable or unpublished slug (`formPortalFetchServer` returns null on
 * a 404 from `app.resolve_consent_form_slug` / an archived-or-draft form)
 * calls Next's `notFound()` here, server-side.
 */
export default async function FormPortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const def = await formPortalFetchServer<PublicFormDefinition>(`/forms/${encodeURIComponent(slug)}`);
  if (!def) notFound();

  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <div className="portal-kicker">Consent form</div>
        <h1>{def.name}</h1>
        {def.description && <p className="muted">{def.description}</p>}
        {def.noticeText && <p style={{ whiteSpace: 'pre-wrap' }}>{def.noticeText}</p>}
        <FormIntake slug={slug} rows={def.rows} />
      </div>
    </div>
  );
}
