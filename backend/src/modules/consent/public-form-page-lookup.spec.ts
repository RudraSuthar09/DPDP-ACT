import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_FORM_UNAVAILABLE_REASONS } from '@dpdp/shared';

/**
 * The public form page's half of the same bug (frontend logic, run here
 * because the frontend has no unit-test runner — same pattern as
 * connected-locations.spec.ts).
 *
 * `formPortalFetchServer` used to return `T | null` and the page called
 * Next's `notFound()` on null, so EVERY failure — including the backend being
 * unreachable — was shown to the visitor as "we couldn't find that form".
 * These tests pin the discriminated result: a 404 carries the backend's
 * reason, and anything else is an error the page must report as our problem,
 * not a bad link.
 */
const FRONTEND = join(__dirname, '..', '..', '..', '..', 'frontend', 'src');

type Lookup<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'unavailable'; reason: string }
  | { ok: false; kind: 'error'; status: number };

const lib = jest.requireActual(join(FRONTEND, 'lib', 'form-portal-api.ts')) as {
  formPortalFetchServer: <T>(path: string) => Promise<Lookup<T>>;
};

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function respond(status: number, body: unknown) {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    text: async () => text,
    json: async () => JSON.parse(text),
  })) as unknown as typeof global.fetch;
}

describe('formPortalFetchServer', () => {
  it('returns the form definition on success', async () => {
    respond(200, { formId: 'f1', name: 'Try form' });
    const res = await lib.formPortalFetchServer<{ name: string }>('/forms/try-form-a5b403');
    expect(res).toEqual({ ok: true, data: { formId: 'f1', name: 'Try form' } });
  });

  it.each(PUBLIC_FORM_UNAVAILABLE_REASONS)('carries the backend reason %s through a 404', async (reason) => {
    respond(404, { message: 'This form is not currently available.', reason });
    const res = await lib.formPortalFetchServer('/forms/try-form-a5b403');
    expect(res).toEqual({ ok: false, kind: 'unavailable', reason });
  });

  it('treats a 404 with no reason (older backend) as a link that does not resolve', async () => {
    respond(404, { message: 'Not Found' });
    expect(await lib.formPortalFetchServer('/forms/x')).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'FORM_NOT_FOUND',
    });
  });

  it('does NOT report an unreachable API as a missing form', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof global.fetch;
    expect(await lib.formPortalFetchServer('/forms/try-form-a5b403')).toEqual({
      ok: false,
      kind: 'error',
      status: 0,
    });
  });

  it('does NOT report a 500 as a missing form', async () => {
    respond(500, { message: 'boom' });
    expect(await lib.formPortalFetchServer('/forms/try-form-a5b403')).toEqual({
      ok: false,
      kind: 'error',
      status: 500,
    });
  });

  it('survives a non-JSON error body', async () => {
    respond(404, '<html>gateway</html>');
    expect(await lib.formPortalFetchServer('/forms/x')).toEqual({
      ok: false,
      kind: 'unavailable',
      reason: 'FORM_NOT_FOUND',
    });
  });
});

describe('the public form page', () => {
  const page = readFileSync(join(FRONTEND, 'app', 'forms', '[slug]', 'page.tsx'), 'utf8');
  const unavailable = readFileSync(join(FRONTEND, 'app', 'forms', '[slug]', 'FormUnavailable.tsx'), 'utf8');

  it('branches on the lookup result instead of collapsing everything into notFound()', () => {
    expect(page).toContain('lookup.kind === \'unavailable\'');
    expect(page).toContain('<FormTemporarilyUnavailable />');
    expect(page).not.toContain('notFound()');
  });

  it('has its own wording for every reason the backend can send', () => {
    for (const reason of PUBLIC_FORM_UNAVAILABLE_REASONS) {
      expect(unavailable).toContain(reason);
    }
  });

  it('never tells a visitor the link is wrong when our API failed', () => {
    const apiError = unavailable.slice(unavailable.indexOf('FormTemporarilyUnavailable'));
    expect(apiError).toMatch(/on our side/);
    expect(apiError).not.toMatch(/couldn't find|couldn&apos;t find/);
  });
});
