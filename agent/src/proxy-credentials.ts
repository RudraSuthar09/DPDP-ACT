/**
 * Credentials for an authenticating outbound proxy (Basic authentication).
 *
 * Kept OUT of config.json, which every local user can read, and in the state
 * directory (Administrators + the service only). An administrator writes it
 * once in plain form:
 *
 *     { "username": "svc-gateway", "password": "..." }
 *
 * and the service, on its next start, re-writes it DPAPI-protected under its
 * own identity (the same model as sources.json):
 *
 *     { "format": "dpdp-gateway-proxy-credentials", "version": 2,
 *       "protected": { "scheme": "dpapi-user", "v": 1, "data": "<hex>" } }
 *
 * Without a protector (non-Windows development) the plain form is read as is.
 * Every failure is reported by code; the credentials never appear in a message.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write';
import { validateProxyCredentials, type ProxyCredentials } from './network-config';
import type { SecretProtector } from './sources-file';

export const PROXY_CREDENTIALS_FILE_NAME = 'proxy-credentials.json';
export const PROXY_CREDENTIALS_FORMAT = 'dpdp-gateway-proxy-credentials';
export const PROXY_CREDENTIALS_VERSION = 2;

export type ProxyCredentialsErrorCode = 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'UNDECRYPTABLE' | 'PROTECTION_UNAVAILABLE';

export class ProxyCredentialsError extends Error {
  constructor(
    public readonly code: ProxyCredentialsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyCredentialsError';
  }
}

export interface LoadedProxyCredentials {
  credentials: ProxyCredentials | null;
  /** The plain file was rewritten in protected form on this call. */
  migrated: boolean;
}

const LABEL = 'proxy-credentials.json';

/** Never throws for a missing file. Throws ProxyCredentialsError otherwise. */
export function loadProxyCredentials(stateDir: string, protector: SecretProtector | null): LoadedProxyCredentials {
  const file = path.join(stateDir, PROXY_CREDENTIALS_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { credentials: null, migrated: false };
    throw new ProxyCredentialsError('CORRUPT', `${LABEL} could not be read.`);
  }

  let parsed: unknown;
  try {
    // Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new ProxyCredentialsError('CORRUPT', `${LABEL} is not valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProxyCredentialsError('CORRUPT', `${LABEL} must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.format === PROXY_CREDENTIALS_FORMAT && obj.version !== undefined) {
    if (obj.version !== PROXY_CREDENTIALS_VERSION) {
      throw new ProxyCredentialsError('UNSUPPORTED_VERSION', `${LABEL} has an unsupported version; it was written by a newer Gateway.`);
    }
    return { credentials: unprotect(obj.protected, protector), migrated: false };
  }

  // Plain form, as written by an administrator.
  let credentials: ProxyCredentials;
  try {
    credentials = validateProxyCredentials({ username: obj.username, password: obj.password }, LABEL);
  } catch (err) {
    throw new ProxyCredentialsError('CORRUPT', err instanceof Error ? err.message : `${LABEL} is invalid.`);
  }
  if (!protector) return { credentials, migrated: false };

  let data: string;
  try {
    data = protector.protect(JSON.stringify(credentials));
  } catch {
    throw new ProxyCredentialsError('PROTECTION_UNAVAILABLE', `${LABEL} could not be protected with Windows DPAPI under the service account.`);
  }
  writeFileAtomic(
    file,
    JSON.stringify(
      { format: PROXY_CREDENTIALS_FORMAT, version: PROXY_CREDENTIALS_VERSION, protected: { scheme: protector.scheme, v: 1, data } },
      null,
      2,
    ),
  );
  return { credentials, migrated: true };
}

function unprotect(envelope: unknown, protector: SecretProtector | null): ProxyCredentials {
  const e = envelope as { scheme?: unknown; v?: unknown; data?: unknown } | null;
  if (!e || typeof e !== 'object' || e.v !== 1 || typeof e.data !== 'string' || typeof e.scheme !== 'string') {
    throw new ProxyCredentialsError('CORRUPT', `${LABEL} is damaged.`);
  }
  if (!protector || protector.scheme !== e.scheme) {
    throw new ProxyCredentialsError('PROTECTION_UNAVAILABLE', `${LABEL} is protected with a scheme this process cannot use.`);
  }
  let json: string;
  try {
    json = protector.unprotect(e.data);
  } catch {
    throw new ProxyCredentialsError(
      'UNDECRYPTABLE',
      `${LABEL} could not be decrypted under this service account. Replace it with the plain form and restart the service.`,
    );
  }
  try {
    const c = JSON.parse(json) as { username?: unknown; password?: unknown };
    return validateProxyCredentials({ username: c.username, password: c.password }, LABEL);
  } catch {
    throw new ProxyCredentialsError('CORRUPT', `${LABEL} decrypted to an invalid value.`);
  }
}
