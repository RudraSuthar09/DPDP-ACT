import { createHash, randomBytes } from 'node:crypto';

/**
 * License-key generation + hashing. Same discipline as the Gateway's
 * enrolment-code helper (gateway.service.ts randomToken/sha256): a
 * high-entropy opaque secret, shown to staff exactly once, and never stored —
 * only its SHA-256 hash (+ a short display-only prefix) persists.
 */

export interface GeneratedLicenseKey {
  key: string;
  hash: string;
  prefix: string;
}

export function generateLicenseKey(): GeneratedLicenseKey {
  const key = `DPDP-${randomBytes(24).toString('base64url')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 13) };
}

export function hashLicenseKey(key: string): string {
  return sha256(key.trim());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
