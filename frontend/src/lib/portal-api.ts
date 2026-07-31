/**
 * The unauthenticated door, for the public request portal (FR-GRV-01/03) —
 * `/portal/:slug/...`. Deliberately separate from `api.ts`: that file attaches
 * a staff bearer token from `localStorage` on every call, which is exactly
 * wrong here. A stranger filing a complaint has no staff session, and even a
 * staff member browsing their own tenant's public portal in another tab must
 * not have their session token leak onto a route `PortalGuard` doesn't expect
 * it on.
 *
 * The two routes that DO require a bearer — viewing a ticket and replying to
 * it — need the short-lived portal token minted by OTP verification, not the
 * staff token, so it is passed explicitly per call rather than read from
 * storage.
 */

import { API_URL } from './api';

export class PortalApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PortalApiError';
  }
}

interface PortalRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** The portal token from OTP verification — only the ticket-view and
   *  reply routes need it. */
  portalToken?: string;
}

export async function portalFetch<T>(path: string, options: PortalRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.portalToken) headers.Authorization = `Bearer ${options.portalToken}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new PortalApiError(0, `Could not reach the API at ${API_URL}. Is it running?`);
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new PortalApiError(res.status, errorMessage(data) ?? res.statusText);
  }
  return data as T;
}

function errorMessage(data: unknown): string | null {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
  }
  return null;
}

/**
 * Server-side fetch for the SSR org lookup in `page.tsx` — same wire contract
 * as `portalFetch`, but returns null on a 404 instead of throwing, so the page
 * can call Next's `notFound()` with a clean signal rather than parsing an
 * error message.
 */
export async function portalFetchServer<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : null;
    throw new PortalApiError(res.status, errorMessage(data) ?? res.statusText);
  }
  return (await res.json()) as T;
}
