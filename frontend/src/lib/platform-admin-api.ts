/**
 * The platform-admin tool's own door to the backend — deliberately separate
 * from `api.ts`'s `apiFetch`. That one attaches the normal tenant session
 * token (`dpdp.accessToken`) and is what every ordinary page uses; this one
 * attaches a `platform_admin` token (`dpdp.platformAdminToken`) that belongs
 * to no tenant at all (see the platform-admin migration). Keeping them
 * separate means signing in here never touches — and can never be confused
 * with — a normal tenant session in the same browser.
 */

import { API_URL } from './api';

const TOKEN_KEY = 'dpdp.platformAdminToken';

/** Fired on window when the admin session ends (sign-out, expiry, or a 401). */
export const PLATFORM_ADMIN_SIGNED_OUT_EVENT = 'dpdp:platform-admin-signed-out';

/**
 * The admin token lives in sessionStorage, not localStorage: it disappears
 * when the browser tab/window is closed instead of persisting on disk for
 * its whole lifetime, and it is dropped as soon as its `exp` has passed.
 * (A token left in localStorage by an older version is removed.)
 */
function tokenExpired(token: string): boolean {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof json.exp !== 'number' || json.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export function getPlatformAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
  let token: string | null = null;
  try {
    token = window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
  if (token && tokenExpired(token)) {
    clearPlatformAdminToken();
    return null;
  }
  return token;
}

export function setPlatformAdminToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearPlatformAdminToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class PlatformAdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAdminApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Defaults to true — attach the platform-admin bearer token if we have one. */
  auth?: boolean;
}

export async function platformAdminFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (options.auth !== false) {
    const token = getPlatformAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new PlatformAdminApiError(0, `Could not reach the API at ${API_URL}. Is it running?`);
  }

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    // An authenticated call refused as 401 means the admin session is over
    // (expired or invalid): drop the token and let the portal show sign-in.
    if (res.status === 401 && options.auth !== false) {
      clearPlatformAdminToken();
      window.dispatchEvent(new Event(PLATFORM_ADMIN_SIGNED_OUT_EVENT));
    }
    throw new PlatformAdminApiError(res.status, errorMessage(data) ?? res.statusText);
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
