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

export function getPlatformAdminToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setPlatformAdminToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearPlatformAdminToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
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
