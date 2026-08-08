/**
 * The consent FORMS widget — the tenant-wide website embed (new UX model). One
 * snippet per tenant: it calls GET /consent/public/active-forms with the
 * publishable key at render time and displays whichever forms/rows are
 * currently active. Toggling a form or row active/inactive on the platform
 * changes what this renders on the next load, with NO change to the embedded
 * code. Submitting posts through /consent/public/forms/:formId/submissions,
 * which records real consent_events via ConsentService (no new write path).
 *
 * Separate bundle from index.ts (the grant/withdraw SDK) — a page opts into this
 * larger, UI-rendering script only if it wants the pre-built forms.
 */

export interface ConsentFormsWidgetConfig {
  apiKey: string;
  /** An element, or a CSS selector for document.querySelector. */
  container: string | HTMLElement;
  /** The tenant's own internal id for this visitor — the host page already
   *  knows who it is (a logged-in user, a cart session), exactly like the
   *  grant/withdraw SDK's customerId. */
  customerId: string;
  apiBaseUrl?: string;
  onSubmitted?: (formId: string) => void;
}

interface PublicRow {
  consentPurposeId: string;
  label: string;
  noticeText: string;
}
interface ActiveForm {
  formId: string;
  name: string;
  description: string | null;
  rows: PublicRow[];
}

const scriptOrigin = detectScriptOrigin();

export class DPDPConsentForms {
  private readonly config: ConsentFormsWidgetConfig;
  private readonly baseUrl: string;

  constructor(config: ConsentFormsWidgetConfig) {
    if (!config?.apiKey || !config.container || !config.customerId) {
      throw new Error('DPDPConsentForms: apiKey, container and customerId are all required.');
    }
    const base = config.apiBaseUrl ?? scriptOrigin;
    if (!base) {
      throw new Error('DPDPConsentForms: apiBaseUrl is required when not loaded via a <script src="..."> tag.');
    }
    this.config = config;
    this.baseUrl = base.replace(/\/+$/, '');
  }

  /** Fetch every active form for the tenant and render them all. */
  async mount(): Promise<void> {
    const el = this.resolveContainer();
    el.textContent = 'Loading…';
    let forms: ActiveForm[];
    try {
      forms = await this.fetchActiveForms();
    } catch (err) {
      el.textContent = '';
      throw err;
    }
    el.innerHTML = '';
    if (forms.length === 0) {
      el.setAttribute('data-dpdp-consent-forms', 'empty');
      return;
    }
    el.setAttribute('data-dpdp-consent-forms', String(forms.length));
    for (const form of forms) {
      el.appendChild(this.renderForm(form));
    }
  }

  private resolveContainer(): HTMLElement {
    const el = typeof this.config.container === 'string' ? document.querySelector(this.config.container) : this.config.container;
    if (!(el instanceof HTMLElement)) {
      throw new Error('DPDPConsentForms: container element not found.');
    }
    return el;
  }

  private async fetchActiveForms(): Promise<ActiveForm[]> {
    const res = await fetch(`${this.baseUrl}/consent/public/active-forms`, {
      headers: { 'X-Consent-Api-Key': this.config.apiKey },
    });
    if (!res.ok) {
      throw new Error(`DPDPConsentForms: failed to load active forms (${res.status})`);
    }
    const data = (await res.json()) as { forms: ActiveForm[] };
    return data.forms ?? [];
  }

  private renderForm(form: ActiveForm): HTMLElement {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-dpdp-form', form.formId);

    const title = document.createElement('h3');
    title.textContent = form.name;
    wrap.appendChild(title);
    if (form.description) {
      const d = document.createElement('p');
      d.textContent = form.description;
      wrap.appendChild(d);
    }

    const formEl = document.createElement('form');
    const checks = new Map<string, HTMLInputElement>();
    for (const row of form.rows) {
      const label = document.createElement('label');
      label.style.display = 'block';
      label.style.margin = '0.5em 0';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = row.consentPurposeId;
      checks.set(row.consentPurposeId, input);
      const text = document.createElement('span');
      text.textContent = ` ${row.label} — ${row.noticeText}`;
      label.appendChild(input);
      label.appendChild(text);
      formEl.appendChild(label);
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Save my choices';
    formEl.appendChild(submit);
    const status = document.createElement('p');
    formEl.appendChild(status);

    formEl.addEventListener('submit', (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = 'Saving…';
      this.submit(form, checks)
        .then(() => {
          status.textContent = 'Saved. Thank you.';
          this.config.onSubmitted?.(form.formId);
        })
        .catch(() => {
          status.textContent = 'Something went wrong — please try again.';
          submit.disabled = false;
        });
    });

    wrap.appendChild(formEl);
    return wrap;
  }

  private async submit(form: ActiveForm, checks: Map<string, HTMLInputElement>): Promise<void> {
    const answers = form.rows.map((r) => ({
      consentPurposeId: r.consentPurposeId,
      granted: checks.get(r.consentPurposeId)?.checked ?? false,
    }));
    const res = await fetch(`${this.baseUrl}/consent/public/forms/${form.formId}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Consent-Api-Key': this.config.apiKey },
      body: JSON.stringify({ customerId: this.config.customerId, answers }),
    });
    if (!res.ok) {
      throw new Error(`DPDPConsentForms: submission failed (${res.status})`);
    }
  }
}

function detectScriptOrigin(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script?.src) return undefined;
  try {
    return new URL(script.src).origin;
  } catch {
    return undefined;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { DPDPConsentForms: typeof DPDPConsentForms }).DPDPConsentForms = DPDPConsentForms;
}
