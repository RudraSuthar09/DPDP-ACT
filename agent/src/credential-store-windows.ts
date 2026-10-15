/**
 * Windows DPAPI-backed device credential storage — the Windows
 * implementation of enrollment.ts's `CredentialStore` interface. On Windows
 * this replaces the plain-file store; Linux/dev keep the plain-file store.
 *
 * THREAT MODEL:
 *   - Protects against: another local account reading the file; the file
 *     being copied to another machine (the DPAPI master key stays behind);
 *     casual inspection of a backup.
 *   - Does NOT protect against: a local Administrator or SYSTEM process on
 *     the same machine, which can run code as the service account. No
 *     on-host-only mechanism can.
 *   - Only the service itself (NT SERVICE\DPDPGatewayAgent) ever calls
 *     save()/load() in the installed product — see dpapi.ts's header for why
 *     the wizard and its elevated helper never touch this file's contents.
 *
 * File format: `{ "dpapi": "<hex ciphertext>" }`, written atomically.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CredentialStore, PersistedCredential } from './enrollment';
import { DpapiError, dpapiProtect, dpapiUnprotect, type PowerShellRunner, runPowerShellReal } from './dpapi';
import { writeFileAtomic } from './atomic-write';

export { DpapiError, type PowerShellRunner } from './dpapi';

function credentialFilePath(stateDir: string): string {
  return path.join(stateDir, 'device-credential.json');
}

interface DpapiEnvelope {
  dpapi: string;
}

function isDpapiEnvelope(value: unknown): value is DpapiEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).dpapi === 'string';
}

export function createDpapiCredentialStore(stateDir: string, run: PowerShellRunner = runPowerShellReal): CredentialStore {
  const file = credentialFilePath(stateDir);

  return {
    load(): PersistedCredential | null {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Corrupt Gateway credential file at ${file} (not JSON) — remove the Gateway and pair it again.`);
      }
      if (!isDpapiEnvelope(parsed)) {
        throw new Error(`Corrupt Gateway credential file at ${file} (not a DPAPI envelope) — remove the Gateway and pair it again.`);
      }
      const plaintext = dpapiUnprotect(parsed.dpapi, run);
      let cred: Partial<PersistedCredential>;
      try {
        cred = JSON.parse(plaintext) as Partial<PersistedCredential>;
      } catch {
        throw new DpapiError(`Gateway credential at ${file} decrypted to unreadable data — remove the Gateway and pair it again.`);
      }
      if (
        typeof cred.tenantId !== 'string' ||
        typeof cred.deviceId !== 'string' ||
        typeof cred.deviceToken !== 'string' ||
        typeof cred.enrolledAt !== 'string'
      ) {
        throw new Error(`Corrupt Gateway credential file at ${file} — remove the Gateway and pair it again.`);
      }
      return cred as PersistedCredential;
    },

    save(cred: PersistedCredential): void {
      const envelope: DpapiEnvelope = { dpapi: dpapiProtect(JSON.stringify(cred), run) };
      writeFileAtomic(file, JSON.stringify(envelope, null, 2));
    },

    clear(): void {
      try {
        rmSync(file, { force: true });
      } catch {
        // Best-effort — de-enrollment must not fail just because local cleanup did.
      }
    },
  };
}
