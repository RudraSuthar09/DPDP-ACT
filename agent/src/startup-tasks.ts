/**
 * Startup steps the service performs under its OWN Windows identity, before
 * it starts serving. They live here (not inline in index.ts's main()) so
 * each one is unit-testable with mocked clients/protectors.
 *
 * Every step fails SAFE: it reports a stable, secret-free code that the
 * local status endpoint exposes to the Gateway Setup app, logs an actionable
 * message, and never discards configuration it could not process.
 */
import { DpapiError } from './dpapi';
import { ControlPlaneHttpError, EnrollmentRequiredError, deenroll, type CredentialStore, type GatewayControlPlaneClient } from './enrollment';
import { clearDeenrollRequest, clearPendingEnrollment, hasDeenrollRequest } from './pending-enrollment';
import {
  SourcesFileError,
  applyPendingSources,
  loadEffectiveSourceConfig,
  migrateLegacySourcesFile,
  type SecretProtector,
  type SourcesFileErrorCode,
} from './sources-file';
import type { GatewaySourceConfig } from './connectors/registry';

type Log = (line: string) => void;

export type EnrollmentErrorCode =
  /** The backend refused the enrolment code (wrong, expired, already used, or the tenant already has an active Gateway). */
  | 'CODE_REJECTED'
  /** The backend could not be reached after bounded retries. */
  | 'BACKEND_UNREACHABLE'
  /** A device credential exists but cannot be decrypted/parsed under this identity. */
  | 'CREDENTIAL_UNREADABLE'
  /** The backend rejected the saved device credential (revoked or expired). */
  | 'CREDENTIAL_REVOKED';

export function classifyEnrollmentFailure(err: unknown): EnrollmentErrorCode | null {
  if (err instanceof EnrollmentRequiredError) return null; // not an error: simply not paired yet
  if (err instanceof ControlPlaneHttpError) return err.status >= 500 || err.status === 429 ? 'BACKEND_UNREACHABLE' : 'CODE_REJECTED';
  if (err instanceof DpapiError) return 'CREDENTIAL_UNREADABLE';
  if (err instanceof Error && /Corrupt Gateway credential/.test(err.message)) return 'CREDENTIAL_UNREADABLE';
  return 'BACKEND_UNREACHABLE';
}

/** Errors the enrolment retry loop must NOT retry: retrying cannot help. */
export function isRetryableEnrollmentError(err: unknown): boolean {
  if (err instanceof EnrollmentRequiredError || err instanceof DpapiError) return false;
  if (err instanceof Error && /Corrupt Gateway credential/.test(err.message)) return false;
  if (err instanceof ControlPlaneHttpError) return err.status >= 500 || err.status === 429;
  return true;
}

export interface DeenrollOutcome {
  requested: boolean;
  backendNotified: boolean;
}

/**
 * Honours a "Remove Gateway" request left by the elevated helper. The local
 * credential and any pending pairing code are cleared regardless of whether
 * the backend could be reached, so the device always ends up locally
 * unpaired; if the backend was unreachable the log says to revoke the device
 * from the dashboard.
 */
export async function processDeenrollRequest(opts: {
  stateDir: string;
  credentialStore: CredentialStore;
  client: GatewayControlPlaneClient | null;
  log: Log;
}): Promise<DeenrollOutcome> {
  if (!hasDeenrollRequest(opts.stateDir)) return { requested: false, backendNotified: false };

  let backendNotified = false;
  let credential = null;
  try {
    credential = opts.credentialStore.load();
  } catch {
    opts.log('Remove Gateway: the saved device credential could not be read; clearing it locally.');
  }
  if (credential && opts.client) {
    ({ backendNotified } = await deenroll(opts.client, credential, opts.stateDir, opts.credentialStore));
  }
  opts.credentialStore.clear();
  clearPendingEnrollment(opts.stateDir);
  clearDeenrollRequest(opts.stateDir);

  if (!credential) {
    opts.log('Remove Gateway: no device credential was present; local state cleared.');
  } else if (backendNotified) {
    opts.log('Remove Gateway: de-enrolled with DPDP and cleared the local credential.');
  } else {
    opts.log('Remove Gateway: DPDP could not be reached, but the local credential was cleared. Revoke this device from the DPDP dashboard.');
  }
  return { requested: true, backendNotified };
}

export interface PreparedSources {
  sources: GatewaySourceConfig[];
  error: SourcesFileErrorCode | null;
}

/**
 * Applies queued sources, migrates a legacy plaintext file to the protected
 * format (Windows only), then loads the effective list. On a sources-file
 * error the data plane starts with NO sources and the error code is
 * reported — the service keeps running (so status stays visible) instead of
 * crash-looping under the service manager. Invalid GATEWAY_SOURCES (an
 * operator-set env var) still throws, as before.
 */
export function prepareSources(opts: {
  stateDir: string;
  sourcesFilePath: string;
  env: NodeJS.ProcessEnv;
  protector: SecretProtector | null;
  log: Log;
}): PreparedSources {
  const usingEnv = Boolean(opts.env.GATEWAY_SOURCES?.trim());
  let error: SourcesFileErrorCode | null = null;

  if (!usingEnv) {
    try {
      const applied = applyPendingSources(opts.stateDir, opts.protector);
      if (applied > 0) opts.log(`Applied ${applied} queued source change(s).`);
    } catch (err) {
      if (!(err instanceof SourcesFileError)) throw err;
      error = err.code;
      opts.log(`Queued source changes were NOT applied and were kept for the next start: ${err.message}`);
    }

    if (opts.protector && !error) {
      try {
        const migrated = migrateLegacySourcesFile(opts.sourcesFilePath, opts.protector);
        if (migrated > 0) opts.log(`Migrated ${migrated} source(s) to the DPAPI-protected sources format.`);
      } catch (err) {
        if (!(err instanceof SourcesFileError)) throw err;
        error = err.code;
        opts.log(`The sources file could not be migrated and was left unchanged: ${err.message}`);
      }
    }
  }

  try {
    return { sources: loadEffectiveSourceConfig(opts.sourcesFilePath, opts.env, opts.protector), error };
  } catch (err) {
    if (!(err instanceof SourcesFileError)) throw err;
    opts.log(`Data sources are unavailable: ${err.message}`);
    return { sources: [], error: err.code };
  }
}
