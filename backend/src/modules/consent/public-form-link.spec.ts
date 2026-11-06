import { NotFoundException } from '@nestjs/common';
import { PUBLIC_FORM_UNAVAILABLE_REASONS } from '@dpdp/shared';
import { ConsentFormsService } from './consent-forms.service';
import { FormTenantMiddleware, type RequestWithFormTenant } from '../../tenancy/form-tenant.middleware';

/**
 * The hosted consent-form link, end to end through the two places that can
 * refuse it: the slug door (FormTenantMiddleware) and the form lookup
 * (publicFormForLink).
 *
 * The bug these tests pin down: a form that was switched on but had no active
 * consent row answered 404 with the same shape as a slug that does not exist,
 * and the public page turned every 404 into "we couldn't find that form". The
 * owner had a real, published link and was told it was wrong. So each refusal
 * now carries a distinct, non-leaky `reason`, and these tests assert the
 * reasons as a contract — the public page branches on them.
 */

const FORM = 'form-1';
const TENANT = 'tenant-1';
const SLUG = 'try-form-a5b403';

function reasonOf(err: unknown): string {
  expect(err).toBeInstanceOf(NotFoundException);
  const body = (err as NotFoundException).getResponse() as { reason?: string; message?: string };
  // Whatever we send must be one of the reasons the frontend knows.
  expect(PUBLIC_FORM_UNAVAILABLE_REASONS).toContain(body.reason);
  return body.reason!;
}

function service(opts: { form: unknown; activeRows: number }) {
  const repo = {
    getForm: async () => opts.form,
    // `true` = active rows only; the real repository filters on it.
    listRows: async (_id: string, activeOnly: boolean) => {
      expect(activeOnly).toBe(true);
      return Array.from({ length: opts.activeRows }, (_v, i) => ({
        consent_purpose_id: `p${i}`,
        notice_version_id: `n${i}`,
        label: 'Marketing',
        notice_text: 'We will email you offers.',
      }));
    },
    listCustomerFields: async () => [],
  };
  return new ConsentFormsService(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { hasActiveServerRoot: async () => false } as never,
    {} as never,
    { getOrThrow: () => ({ tenantId: TENANT, userId: 'u' }) } as never,
    { annotate: jest.fn() } as never,
  );
}

const liveForm = {
  id: FORM,
  name: 'Try form',
  description: null,
  notice_text: null,
  retention_months: null,
  is_active: true,
};

describe('publicFormForLink', () => {
  it('serves a published form with at least one active consent item', async () => {
    const def = await service({ form: liveForm, activeRows: 1 }).publicFormForLink(FORM);
    expect(def.formId).toBe(FORM);
    expect(def.name).toBe('Try form');
    expect(def.rows).toHaveLength(1);
  });

  it('refuses a form that is switched off, as FORM_NOT_LIVE', async () => {
    const svc = service({ form: { ...liveForm, is_active: false }, activeRows: 3 });
    const err = await svc.publicFormForLink(FORM).catch((e: unknown) => e);
    expect(reasonOf(err)).toBe('FORM_NOT_LIVE');
  });

  it('refuses a form with no active consent item, as FORM_NOT_READY — not as a missing form', async () => {
    const svc = service({ form: liveForm, activeRows: 0 });
    const err = await svc.publicFormForLink(FORM).catch((e: unknown) => e);
    expect(reasonOf(err)).toBe('FORM_NOT_READY');
  });

  it('leaks nothing about the tenant or the form in a refusal', async () => {
    const svc = service({ form: { ...liveForm, is_active: false }, activeRows: 0 });
    const err = (await svc.publicFormForLink(FORM).catch((e: unknown) => e)) as NotFoundException;
    const body = JSON.stringify(err.getResponse());
    expect(body).not.toContain(TENANT);
    expect(body).not.toContain(FORM);
  });
});

describe('FormTenantMiddleware (the unauthenticated slug door)', () => {
  function middleware(resolved: { tenantId: string; formId: string; title: string } | null) {
    const ran: Array<{ tenantId: string; anonymous?: boolean }> = [];
    const tenantContext = {
      run: (ctx: { tenantId: string; anonymous?: boolean }, fn: () => void) => {
        ran.push(ctx);
        fn();
      },
    };
    const db = { resolveConsentFormSlug: async () => resolved };
    return { mw: new FormTenantMiddleware(tenantContext as never, db as never), ran };
  }

  const request = (path: string) =>
    ({
      originalUrl: path,
      url: path,
      ip: '203.0.113.9',
      header: () => undefined,
    }) as unknown as RequestWithFormTenant;

  it('resolves a dashboard-generated slug with no authentication at all', async () => {
    const { mw, ran } = middleware({ tenantId: TENANT, formId: FORM, title: 'Try form' });
    const req = request(`/forms/${SLUG}`);
    const next = jest.fn();

    await mw.use(req, {} as never, next);

    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.formTenant).toEqual({ tenantId: TENANT, slug: SLUG, formId: FORM, formTitle: 'Try form' });
    // The request runs as an anonymous visitor of that tenant, never as a user.
    expect(ran[0]?.tenantId).toBe(TENANT);
    expect(ran[0]?.anonymous).toBe(true);
  });

  it('refuses an unknown slug as FORM_NOT_FOUND, distinctly from an existing form', async () => {
    const { mw } = middleware(null);
    const next = jest.fn();

    await mw.use(request('/forms/definitely-not-a-form'), {} as never, next);

    expect(reasonOf(next.mock.calls[0][0])).toBe('FORM_NOT_FOUND');
  });

  it('ignores paths outside /forms/', async () => {
    const { mw, ran } = middleware({ tenantId: TENANT, formId: FORM, title: 'Try form' });
    const req = request('/consent/forms');
    const next = jest.fn();

    await mw.use(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.formTenant).toBeUndefined();
    expect(ran).toHaveLength(0);
  });
});
