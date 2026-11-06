/**
 * The unauthenticated door for the hosted consent-form link (`/forms/:slug`) —
 * same reasoning as portal-api.ts, kept as its own file for the same reason:
 * a stranger filling in a consent form has no staff session, and this must
 * never read or attach the bearer token api.ts keeps in localStorage.
 */

import { PUBLIC_FORM_UNAVAILABLE_REASONS, type PublicFormUnavailableReason } from '@dpdp/shared';
import { API_URL, SERVER_API_URL } from './api-base';

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

/**
 * Server-side fetch for the SSR form lookup.
 *
 * Returns a RESULT rather than `T | null`, because "there is no such form",
 * "the owner switched it off", "it has no consent items yet" and "the API did
 * not answer" are four different things to tell a visitor. The old contract
 * mapped every 404 to null and let an unreachable API throw a 500 page, so a
 * published-but-unfinished form was reported as a bad link.
 */
/** Never serve a stale form definition. Cast because this file is also loaded
 *  by the backend's jest (the frontend has no test runner of its own) and
 *  @types/node's RequestInit has no `cache` field — the value is correct for
 *  the Next.js runtime that actually executes it. */
const NO_STORE = { cache: 'no-store' } as unknown as RequestInit;

export type PublicFormLookup<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'unavailable'; reason: PublicFormUnavailableReason }
  | { ok: false; kind: 'error'; status: number };

export async function formPortalFetchServer<T>(path: string): Promise<PublicFormLookup<T>> {
  let res: Response;
  try {
    res = await fetch(`${SERVER_API_URL}${path}`, NO_STORE);
  } catch {
    // The API could not be reached at all. NOT a missing form.
    return { ok: false, kind: 'error', status: 0 };
  }

  if (res.ok) return { ok: true, data: (await res.json()) as T };

  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.status === 404) {
    return { ok: false, kind: 'unavailable', reason: unavailableReason(data) };
  }
  return { ok: false, kind: 'error', status: res.status };
}

/** The backend's stable reason, or the safest assumption if it sent none (an
 *  older backend): the link does not resolve. */
function unavailableReason(data: unknown): PublicFormUnavailableReason {
  const raw = data && typeof data === 'object' && 'reason' in data ? (data as { reason: unknown }).reason : null;
  return typeof raw === 'string' && (PUBLIC_FORM_UNAVAILABLE_REASONS as readonly string[]).includes(raw)
    ? (raw as PublicFormUnavailableReason)
    : 'FORM_NOT_FOUND';
}

function errorMessage(data: unknown): string | null {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
  }
  return null;
}
