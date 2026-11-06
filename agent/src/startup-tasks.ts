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
import {
  ControlPlaneHttpError,
  EnrollmentRequiredError,
  UnexpectedServerResponseError,
  deenroll,
  type CredentialStore,
  type GatewayControlPlaneClient,
} from './enrollment';
import { clearDeenrollRequest, clearPendingEnrollment, hasDeenrollRequest } from './pending-enrollment';
import {
  SourcesFileError,
  applyPendingSources,
  applyRevocations,
  loadEffectiveSourceConfig,
  migrateLegacySourcesFile,
  upsertSourceConfig,
  type SecretProtector,
  type SourcesFileErrorCode,
} from './sources-file';
import {
  appendPendingAuthorization,
  clearPendingAuthorizations,
  readPendingAuthorizations,
  type PendingFolderAuthorization,
} from './pending-authorizations';
import type { GatewaySourceConfig } from './connectors/registry';
import { TransportError } from './transport';

type Log = (line: string) => void;

export type EnrollmentErrorCode =
  /** The backend refused the enrolment code (wrong, expired, already used, or the tenant already has an active Gateway). */
  | 'CODE_REJECTED'
  /** The backend could not be reached after bounded retries. */
  | 'BACKEND_UNREACHABLE'
  /** A device credential exists but cannot be decrypted/parsed under this identity. */
  | 'CREDENTIAL_UNREADABLE'
  /** The backend rejected the saved device credential (revoked or expired). */
  | 'CREDENTIAL_REVOKED'
  /** The outbound proxy answered 407: missing or wrong proxy credentials. */
  | 'PROXY_AUTH_FAILED'
  /** A proxy is configured but could not be reached or refused the tunnel (never bypassed). */
  | 'PROXY_UNREACHABLE'
  /** The server (or TLS-inspecting proxy) certificate failed verification. */
  | 'TLS_CERTIFICATE_REJECTED'
  /** The address answered, but it is not the DPDP API (non-JSON reply, or no
   *  enrolment route: 404/405) -- typically the dashboard's web address. */
  | 'WRONG_SERVER';

/** DPDP always has POST /gateway/enroll and answers in JSON, so these mean
 *  "wrong address", never "bad code". */
function isWrongServer(err: unknown): boolean {
  return err instanceof UnexpectedServerResponseError || (err instanceof ControlPlaneHttpError && (err.status === 404 || err.status === 405));
}

function classifyTransport(err: TransportError): EnrollmentErrorCode {
  switch (err.code) {
    case 'PROXY_AUTH_FAILED':
      return 'PROXY_AUTH_FAILED';
    case 'PROXY_REFUSED':
    case 'PROXY_UNREACHABLE':
      return 'PROXY_UNREACHABLE';
    case 'TLS_UNTRUSTED':
    case 'TLS_HOSTNAME_MISMATCH':
    case 'TLS_FAILED':
      return 'TLS_CERTIFICATE_REJECTED';
    default:
      return 'BACKEND_UNREACHABLE';
  }
}

export function classifyEnrollmentFailure(err: unknown): EnrollmentErrorCode | null {
  if (err instanceof EnrollmentRequiredError) return null; // not an error: simply not paired yet
  if (err instanceof TransportError) return classifyTransport(err);
  if (isWrongServer(err)) return 'WRONG_SERVER';
  if (err instanceof ControlPlaneHttpError) return err.status >= 500 || err.status === 429 ? 'BACKEND_UNREACHABLE' : 'CODE_REJECTED';
  if (err instanceof DpapiError) return 'CREDENTIAL_UNREADABLE';
  if (err instanceof Error && /Corrupt Gateway credential/.test(err.message)) return 'CREDENTIAL_UNREADABLE';
  return 'BACKEND_UNREACHABLE';
}

/** Errors the enrolment retry loop must NOT retry: retrying cannot help. */
export function isRetryableEnrollmentError(err: unknown): boolean {
  if (err instanceof EnrollmentRequiredError || err instanceof DpapiError) return false;
  if (err instanceof TransportError) return err.retryable;
  if (isWrongServer(err)) return false;
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

export interface AppliedAuthorizations {
  /** Folders registered with DPDP on this start. */
  applied: number;
  /** Still queued: DPDP could not be reached, or it refused them. */
  pending: number;
}

/**
 * Exchanges each folder an administrator approved in Gateway Setup for its
 * DPDP record ids (POST /gateway/folders), then writes a complete source
 * entry — which is what removes hand-copied ids from the wizard.
 *
 * Runs under the SERVICE's identity, because only it can decrypt the device
 * credential. Fails safe in every direction:
 *   - not enrolled yet, or no control plane: nothing is attempted and the
 *     queue is kept for a later start;
 *   - DPDP unreachable or refusing: that folder stays queued (reported as
 *     `pending`), never silently dropped and never half-written;
 *   - a folder DPDP accepts is written to sources.json immediately, so a
 *     later failure for another folder cannot undo it.
 * The local folder PATH is never sent — only the label and the permission.
 */
export async function applyPendingAuthorizations(opts: {
  stateDir: string;
  sourcesFilePath: string;
  protector: SecretProtector | null;
  client: GatewayControlPlaneClient | null;
  deviceToken: string | null;
  log: Log;
}): Promise<AppliedAuthorizations> {
  let queued: PendingFolderAuthorization[];
  try {
    queued = readPendingAuthorizations(opts.stateDir);
  } catch (err) {
    opts.log(`Queued folder approvals could not be read and were left in place: ${(err as Error).message}`);
    return { applied: 0, pending: 0 };
  }
  if (queued.length === 0) return { applied: 0, pending: 0 };
  if (!opts.client || !opts.deviceToken) {
    opts.log(`${queued.length} approved folder(s) are waiting until this Gateway is paired with DPDP.`);
    return { applied: 0, pending: queued.length };
  }

  const stillQueued: PendingFolderAuthorization[] = [];
  let applied = 0;
  for (const entry of queued) {
    try {
      const ids = await opts.client.authorizeFolder(opts.deviceToken, { label: entry.label, access: entry.access });
      const source: GatewaySourceConfig = {
        // Read access is served under the id DPDP generated; a write-only
        // folder is keyed by its storage location id, exactly as the manual
        // flow did — the agent never invents an id of its own.
        sourceId: ids.sourceId ?? ids.storageRootId!,
        kind: 'filesystem',
        roots: [entry.root],
        access: entry.access,
        ...(ids.storageRootId ? { storageRootId: ids.storageRootId } : {}),
      };
      upsertSourceConfig(opts.sourcesFilePath, source, opts.protector);
      applied += 1;
      opts.log(`Registered folder "${entry.label}" with DPDP (${entry.access}).`);
    } catch (err) {
      stillQueued.push(entry);
      opts.log(`Folder "${entry.label}" could not be registered with DPDP yet and stays queued: ${describeRegistrationFailure(err)}`);
    }
  }

  // Rewrite the queue with only what is still outstanding.
  try {
    clearPendingAuthorizations(opts.stateDir);
    for (const entry of stillQueued) appendPendingAuthorization(opts.stateDir, entry);
  } catch (err) {
    opts.log(`The approved-folder queue could not be updated: ${(err as Error).message}`);
  }
  return { applied, pending: stillQueued.length };
}

/**
 * Applies the folders DPDP has revoked ("Remove folder" in Sources &
 * Storage) to this Gateway's local source list, so it stops offering them.
 *
 * Runs on start AND after each successful check-in, which is what makes an
 * OFFLINE revocation work: DPDP records it immediately and refuses to use the
 * folder centrally from that moment; this Gateway finds out whenever it next
 * manages to reach DPDP, and needs no instruction to have been delivered at
 * the time.
 *
 * Fails safe in every direction:
 *   - not paired, no control plane, or DPDP unreachable: nothing is changed
 *     and nothing is lost — it is retried on the next check-in;
 *   - the sources file cannot be read or written: it is left exactly as it
 *     was and the failure is logged (a revocation that cannot be applied
 *     locally still holds centrally, so no write can reach the folder);
 *   - idempotent: an already-applied revocation changes nothing and rewrites
 *     nothing.
 * It only ever REMOVES or DOWNGRADES local entries, so it can never grant
 * this Gateway access to anything.
 */
export async function applyFolderRevocations(opts: {
  sourcesFilePath: string;
  protector: SecretProtector | null;
  client: GatewayControlPlaneClient | null;
  deviceToken: string | null;
  log: Log;
}): Promise<{ applied: number }> {
  if (!opts.client || !opts.deviceToken) return { applied: 0 };
  let revoked: { revokedSourceIds: string[]; revokedStorageRootIds: string[] };
  try {
    revoked = await opts.client.listFolderRevocations(opts.deviceToken);
  } catch (err) {
    opts.log(`Removed-folder list could not be fetched from DPDP (will retry): ${describeRegistrationFailure(err)}`);
    return { applied: 0 };
  }
  try {
    const applied = applyRevocations(
      opts.sourcesFilePath,
      { sourceIds: revoked.revokedSourceIds, storageRootIds: revoked.revokedStorageRootIds },
      opts.protector,
    );
    if (applied > 0) opts.log(`${applied} folder(s) removed in DPDP are no longer offered by this Gateway.`);
    return { applied };
  } catch (err) {
    opts.log(`Removed folders could not be applied locally and the list was left unchanged: ${(err as Error).message}`);
    return { applied: 0 };
  }
}

/** A stable, secret-free reason — never a token, never a path. */
function describeRegistrationFailure(err: unknown): string {
  if (err instanceof ControlPlaneHttpError) return `DPDP answered ${err.status}`;
  if (err instanceof TransportError) return 'DPDP could not be reached';
  if (err instanceof UnexpectedServerResponseError) return 'the address did not answer as DPDP';
  return err instanceof Error ? err.name : 'unknown error';
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
