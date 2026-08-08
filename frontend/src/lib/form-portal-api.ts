/**
 * The unauthenticated door for the hosted consent-form link (`/forms/:slug`) —
 * same reasoning as portal-api.ts, kept as its own file for the same reason:
 * a stranger filling in a consent form has no staff session, and this must
 * never read or attach the bearer token api.ts keeps in localStorage.
 */

import { API_URL } from './api';

export class FormPortalApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FormPortalApiError';
  }
}

export async function formPortalFetch<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new FormPortalApiError(0, `Could not reach the API at ${API_URL}. Is it running?`);
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new FormPortalApiError(res.status, errorMessage(data) ?? res.statusText);
  }
  return data as T;
}

/** Server-side fetch for the SSR form lookup — returns null on a 404 so the
 *  page can call Next's `notFound()`, same contract as portalFetchServer. */
export async function formPortalFetchServer<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    throw new FormPortalApiError(res.status, errorMessage(data) ?? res.statusText);
  }
  return (await res.json()) as T;
}

function errorMessage(data: unknown): string | null {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
  }
  return null;
}
