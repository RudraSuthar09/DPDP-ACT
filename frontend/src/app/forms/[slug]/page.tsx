import type { ConsentFormFileKind } from '@dpdp/shared';
import { formPortalFetchServer } from '../../../lib/form-portal-api';
import { FormIntake } from './FormIntake';
import { FormTemporarilyUnavailable, FormUnavailable } from './FormUnavailable';

interface PublicFormRow {
  consentPurposeId: string;
  label: string;
  noticeText: string;
}
interface PublicFormField {
  id: string;
  label: string;
  fieldType: 'text' | 'file' | 'pdf' | 'excel';
  required: boolean;
  isIdentifier: boolean;
  isCustomerName: boolean;
  description: string | null;
  /** Upload configuration — what the respondent has to be told anyway. */
  allowedFileKinds: ConsentFormFileKind | null;
  maxFileBytes: number | null;
}
interface PublicFormDefinition {
  formId: string;
  name: string;
  description: string | null;
  /** Client-authored Notice/Terms & Conditions, shown once above the form's
   *  consent items. Plain text the client wrote — never generated here. */
  noticeText: string | null;
  /** Configuration only, for the local Customer Information/retention.json
   *  the browser writes on submit — never enforced/deleted here. */
  retentionMonths: number | null;
  rows: PublicFormRow[];
  /** Field CONFIGURATION only (label/type/required/isIdentifier) — never a value. */
  fields: PublicFormField[];
}

/**
 * The hosted consent form link (for a client with no website of their own) —
 * same server-component-first shape as the request portal's page.tsx: the
 * title, description and real purpose/notice text are all in the initial
 * HTML, with no client round trip needed just to see what the form asks.
 *
 * A link that does not open is NOT one situation. `formPortalFetchServer`
 * hands back which of the four it is — the slug resolves to nothing, the form
 * is switched off, the form has no consent item yet, or our own API failed —
 * and each gets its own honest page. Collapsing them (as the old blanket not-found page on
 * every 404 did) told visitors their link was wrong when the form was simply
 * unfinished, or when the backend was down.
 */
export default async function FormPortalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lookup = await formPortalFetchServer<PublicFormDefinition>(`/forms/${encodeURIComponent(slug)}`);
  if (!lookup.ok) {
    return lookup.kind === 'unavailable' ? (
      <FormUnavailable reason={lookup.reason} />
    ) : (
      <FormTemporarilyUnavailable />
    );
  }
  const def = lookup.data;

  return (
    <div className="portal-wrap">
      <div className="portal-card">
        <div className="portal-kicker">Consent form</div>
        <h1>{def.name}</h1>
        {def.description && <p className="muted">{def.description}</p>}
        {def.noticeText && <p style={{ whiteSpace: 'pre-wrap' }}>{def.noticeText}</p>}
        <FormIntake
          slug={slug}
          formId={def.formId}
          templateName={def.name}
          retentionMonths={def.retentionMonths}
          rows={def.rows}
          fields={def.fields}
        />
      </div>
    </div>
  );
}
