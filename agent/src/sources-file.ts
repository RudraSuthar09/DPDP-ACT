/**
 * sources.json — the on-disk source configuration, including database
 * credentials. Lives outside connectors/ on purpose: connectors never gain
 * a file-write path (see data-plane.spec.ts's raw-data boundary guard).
 *
 * ON-DISK FORMATS
 *   v1 (legacy, Phase 1/2): a bare JSON array of GatewaySourceConfig, with
 *       passwords in clear text. Still READ everywhere. On Windows the service
 *       migrates it to v2 at startup; elsewhere (dev/CI) it is still WRITTEN,
 *       because DPAPI does not exist there and pretending otherwise would be
 *       worse than an honest plaintext dev file.
 *   v2: { "format": "dpdp-gateway-sources", "version": 2, "sources": [...] }
 *       Every source keeps its non-secret fields in clear (sourceId, kind,
 *       host, port, user, database, roots, column config); each connection's
 *       secret fields are moved into `secrets`, one envelope per field:
 *         "secrets": { "password": { "scheme": "dpapi-user", "v": 1, "data": "<hex>" } }
 *       A v2 file containing a clear-text secret field is rejected as corrupt.
 *
 * WHO ENCRYPTS: only the service, under its own identity
 * (NT SERVICE\DPDPGatewayAgent). The Gateway Setup wizard's elevated helper
 * runs as a different Windows account and cannot decrypt the service's
 * blobs, so it never reads or writes sources.json. It drops new entries into
 * pending-sources.json (state directory, ACL'd to the service account,
 * Administrators and SYSTEM) and restarts the service; the service merges
 * them under its own identity, rewrites sources.json, then scrubs and deletes
 * the pending file. That file holds plaintext for the seconds between the
 * helper writing it and the service restarting — readable only by the same
 * principals who could already run code as the service and decrypt anyway.
 *
 * FAILURES never discard data: a corrupt, newer-version or undecryptable
 * sources.json is left untouched and reported with a stable code, and a
 * pending file that cannot be applied is kept for the next attempt. Error
 * messages name the file and the sourceId, never a secret value.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canRead, canWrite, loadSourceConfig, parseSourceConfigEntries, type GatewaySourceConfig } from './connectors/registry';
import type { DbConnection } from './connectors/db/db-client';
import { scrubAndRemove, writeFileAtomic } from './atomic-write';
import { DpapiError, dpapiProtect, dpapiUnprotect, runPowerShellReal, type PowerShellRunner } from './dpapi';

export const SOURCES_FILE_NAME = 'sources.json';
export const PENDING_SOURCES_FILE_NAME = 'pending-sources.json';
export const SOURCES_FORMAT = 'dpdp-gateway-sources';
export const SOURCES_VERSION = 2;
export const PENDING_SOURCES_FORMAT = 'dpdp-gateway-pending-sources';
export const PENDING_SOURCES_VERSION = 1;

/** Connection fields that are authentication secrets. DbConnection only has
 *  `password` today; a new credential field must be added here deliberately,
 *  and sources-file.spec.ts fails if a secret-looking field is stored clear. */
export const CONNECTION_SECRET_FIELDS = ['password'] as const;
type SecretField = (typeof CONNECTION_SECRET_FIELDS)[number];

export type SourcesFileErrorCode = 'CORRUPT' | 'UNSUPPORTED_VERSION' | 'UNDECRYPTABLE' | 'PROTECTION_UNAVAILABLE';

export class SourcesFileError extends Error {
  constructor(
    public readonly code: SourcesFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SourcesFileError';
  }
}

export interface SecretProtector {
  readonly scheme: string;
  protect(plaintext: string): string;
  unprotect(data: string): string;
}

export function createDpapiSecretProtector(run: PowerShellRunner = runPowerShellReal): SecretProtector {
  return {
    scheme: 'dpapi-user',
    protect: (plaintext) => dpapiProtect(plaintext, run),
    unprotect: (data) => dpapiUnprotect(data, run),
  };
}

export type SourcesStorage = 'none' | 'legacy-plaintext' | 'protected';

export interface LoadedSources {
  sources: GatewaySourceConfig[];
  storage: SourcesStorage;
}

interface StoredSecret {
  scheme: string;
  v: 1;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protectConnection(conn: DbConnection, protector: SecretProtector): Record<string, unknown> {
  const out: Record<string, unknown> = { ...conn };
  const secrets: Partial<Record<SecretField, StoredSecret>> = {};
  for (const field of CONNECTION_SECRET_FIELDS) {
    const value = conn[field];
    delete out[field];
    if (typeof value === 'string' && value.length > 0) {
      secrets[field] = { scheme: protector.scheme, v: 1, data: protector.protect(value) };
    }
  }
  out.secrets = secrets;
  return out;
}

function unprotectConnection(
  stored: unknown,
  protector: SecretProtector | null,
  sourceId: string,
  filePath: string,
): Record<string, unknown> {
  if (!isRecord(stored)) throw new SourcesFileError('CORRUPT', `Source "${sourceId}" in ${filePath} has a malformed connection.`);
  const { secrets, ...rest } = stored;
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (field in rest) {
      throw new SourcesFileError('CORRUPT', `Source "${sourceId}" in ${filePath} stores "${field}" unencrypted inside a protected file.`);
    }
  }
  const out: Record<string, unknown> = { ...rest };
  if (secrets === undefined) return out;
  if (!isRecord(secrets)) throw new SourcesFileError('CORRUPT', `Source "${sourceId}" in ${filePath} has malformed secrets.`);

  for (const [field, envelope] of Object.entries(secrets)) {
    if (!(CONNECTION_SECRET_FIELDS as readonly string[]).includes(field)) {
      throw new SourcesFileError('CORRUPT', `Source "${sourceId}" in ${filePath} has an unknown secret field "${field}".`);
    }
    if (!isRecord(envelope) || typeof envelope.scheme !== 'string' || typeof envelope.data !== 'string') {
      throw new SourcesFileError('CORRUPT', `Source "${sourceId}" in ${filePath} has a malformed "${field}" envelope.`);
    }
    if (envelope.v !== 1) {
      throw new SourcesFileError('UNSUPPORTED_VERSION', `Source "${sourceId}" in ${filePath} uses secret envelope version ${String(envelope.v)}, which this Gateway version cannot read. Upgrade the Gateway.`);
    }
    if (!protector) {
      throw new SourcesFileError('PROTECTION_UNAVAILABLE', `${filePath} contains encrypted credentials, but OS credential protection is not available on this platform.`);
    }
    if (envelope.scheme !== protector.scheme) {
      throw new SourcesFileError('UNSUPPORTED_VERSION', `Source "${sourceId}" in ${filePath} uses protection scheme "${envelope.scheme}", which this Gateway cannot read.`);
    }
    try {
      out[field] = protector.unprotect(envelope.data);
    } catch (err) {
      if (err instanceof DpapiError) {
        throw new SourcesFileError(
          'UNDECRYPTABLE',
          `The saved credential for source "${sourceId}" could not be decrypted. It is bound to the Windows service account ` +
            `(NT SERVICE\\DPDPGatewayAgent); this happens if that account or its profile was recreated. ` +
            `Re-enter the source in Gateway Setup -> Manage sources. ${filePath} was left unchanged.`,
        );
      }
      throw err;
    }
  }
  return out;
}

/** Reads sources.json in either format. Never modifies the file. */
export function readSourcesFile(filePath: string, protector: SecretProtector | null): LoadedSources {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sources: [], storage: 'none' };
    throw new SourcesFileError('CORRUPT', `Could not read the Gateway sources file at ${filePath} (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourcesFileError('CORRUPT', `The Gateway sources file at ${filePath} is not valid JSON.`);
  }

  const label = `the Gateway sources file at ${filePath}`;

  if (Array.isArray(parsed)) {
    try {
      return { sources: parseSourceConfigEntries(parsed, label), storage: 'legacy-plaintext' };
    } catch (err) {
      throw new SourcesFileError('CORRUPT', (err as Error).message);
    }
  }

  if (!isRecord(parsed) || parsed.format !== SOURCES_FORMAT) {
    throw new SourcesFileError('CORRUPT', `The Gateway sources file at ${filePath} is not a recognised format.`);
  }
  if (parsed.version !== SOURCES_VERSION) {
    throw new SourcesFileError(
      'UNSUPPORTED_VERSION',
      `The Gateway sources file at ${filePath} is format version ${String(parsed.version)}; this Gateway reads version ${SOURCES_VERSION}. ` +
        'It was probably written by a newer Gateway — upgrade instead of downgrading. The file was left unchanged.',
    );
  }
  if (!Array.isArray(parsed.sources)) {
    throw new SourcesFileError('CORRUPT', `The Gateway sources file at ${filePath} has no "sources" list.`);
  }

  const plain = parsed.sources.map((entry) => {
    if (!isRecord(entry) || typeof entry.sourceId !== 'string') {
      throw new SourcesFileError('CORRUPT', `An entry in ${filePath} has no sourceId.`);
    }
    const out: Record<string, unknown> = { ...entry };
    if (entry.connection !== undefined) out.connection = unprotectConnection(entry.connection, protector, entry.sourceId, filePath);
    if (entry.writeConnection !== undefined) {
      out.writeConnection = unprotectConnection(entry.writeConnection, protector, entry.sourceId, filePath);
    }
    return out;
  });

  try {
    return { sources: parseSourceConfigEntries(plain, label), storage: 'protected' };
  } catch (err) {
    throw new SourcesFileError('CORRUPT', (err as Error).message);
  }
}

/** Validates, then writes atomically: v2 (encrypted) when a protector is
 *  available, v1 plaintext otherwise (non-Windows development only). */
export function writeSourcesFile(filePath: string, sources: readonly GatewaySourceConfig[], protector: SecretProtector | null): void {
  const validated = parseSourceConfigEntries(JSON.parse(JSON.stringify(sources)) as unknown, `the Gateway sources file at ${filePath}`);

  if (!protector) {
    writeFileAtomic(filePath, JSON.stringify(validated, null, 2));
    return;
  }

  const stored = validated.map((s) => {
    const out: Record<string, unknown> = { ...s };
    if (s.connection) out.connection = protectConnection(s.connection, protector);
    if (s.writeConnection) out.writeConnection = protectConnection(s.writeConnection, protector);
    return out;
  });
  writeFileAtomic(filePath, JSON.stringify({ format: SOURCES_FORMAT, version: SOURCES_VERSION, sources: stored }, null, 2));
}

function upsertInto(existing: GatewaySourceConfig[], additions: readonly GatewaySourceConfig[]): GatewaySourceConfig[] {
  const ids = new Set(additions.map((a) => a.sourceId));
  return [...existing.filter((s) => !ids.has(s.sourceId)), ...additions];
}

/** Rewrites a legacy plaintext file in the protected format. Returns the
 *  number of sources migrated (0 if there was nothing to migrate). No
 *  plaintext backup is kept; the atomic rename replaces the old file. */
export function migrateLegacySourcesFile(filePath: string, protector: SecretProtector): number {
  const loaded = readSourcesFile(filePath, protector);
  if (loaded.storage !== 'legacy-plaintext') return 0;
  writeSourcesFile(filePath, loaded.sources, protector);
  return loaded.sources.length;
}

// --- pending-sources.json: the elevated helper's hand-off to the service ---

export function readPendingSources(stateDir: string): GatewaySourceConfig[] | null {
  const file = path.join(stateDir, PENDING_SOURCES_FILE_NAME);
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
    throw new SourcesFileError('CORRUPT', `The pending sources file at ${file} is not valid JSON.`);
  }
  if (!isRecord(parsed) || parsed.format !== PENDING_SOURCES_FORMAT || parsed.version !== PENDING_SOURCES_VERSION) {
    throw new SourcesFileError('CORRUPT', `The pending sources file at ${file} is not a recognised format.`);
  }
  try {
    return parseSourceConfigEntries(parsed.upserts, `the pending sources file at ${file}`);
  } catch (err) {
    throw new SourcesFileError('CORRUPT', (err as Error).message);
  }
}

/** Called by cli-pair.ts under the elevated helper. Adds/replaces one entry
 *  in the pending file and returns how many entries are now pending. Never
 *  touches sources.json. */
export function appendPendingSource(stateDir: string, source: GatewaySourceConfig): number {
  const [validated] = parseSourceConfigEntries([JSON.parse(JSON.stringify(source)) as unknown], 'the new source');
  const pending = upsertInto(readPendingSources(stateDir) ?? [], [validated!]);
  writeFileAtomic(
    path.join(stateDir, PENDING_SOURCES_FILE_NAME),
    JSON.stringify({ format: PENDING_SOURCES_FORMAT, version: PENDING_SOURCES_VERSION, upserts: pending }, null, 2),
  );
  return pending.length;
}

/** Called by the service at startup, under its own identity. Merges pending
 *  entries into sources.json and removes the pending file only after the
 *  merged file has been written. Throws (leaving everything in place) if
 *  sources.json cannot be read or written. */
export function applyPendingSources(stateDir: string, protector: SecretProtector | null): number {
  const pendingFile = path.join(stateDir, PENDING_SOURCES_FILE_NAME);
  const pending = readPendingSources(stateDir);
  if (!pending) return 0;
  const sourcesFile = path.join(stateDir, SOURCES_FILE_NAME);
  const current = readSourcesFile(sourcesFile, protector).sources;
  writeSourcesFile(sourcesFile, upsertInto(current, pending), protector);
  scrubAndRemove(pendingFile);
  return pending.length;
}

// --- compatibility entry points (Phase 1/2 signatures) ---------------------

export function loadSourceConfigFromFile(filePath: string, protector: SecretProtector | null = null): GatewaySourceConfig[] {
  return readSourcesFile(filePath, protector).sources;
}

export function writeSourceConfigFile(
  filePath: string,
  sources: readonly GatewaySourceConfig[],
  protector: SecretProtector | null = null,
): void {
  writeSourcesFile(filePath, sources, protector);
}

export function upsertSourceConfig(
  filePath: string,
  source: GatewaySourceConfig,
  protector: SecretProtector | null = null,
): GatewaySourceConfig[] {
  const next = upsertInto(readSourcesFile(filePath, protector).sources, [source]);
  writeSourcesFile(filePath, next, protector);
  return next;
}

/**
 * Applies central revocations to the local source list: the "Remove folder"
 * action in DPDP, arriving here.
 *
 * Takes an EXPLICIT list of revoked ids, never an "active set" to reconcile
 * against. This file also holds entries an operator configured by hand (and,
 * in dev, entries that come from GATEWAY_SOURCES), and deleting whatever the
 * central platform did not recognise would silently throw those away.
 *
 * For an entry with both permissions where only one was revoked, the entry is
 * DOWNGRADED rather than dropped: losing write must not quietly cost the
 * administrator their read grant, or the reverse. An entry whose every
 * permission is gone is removed outright.
 *
 * Returns the number of entries changed; 0 means there was nothing to do, and
 * the file is not rewritten.
 */
export function applyRevocations(
  filePath: string,
  revoked: { sourceIds: readonly string[]; storageRootIds: readonly string[] },
  protector: SecretProtector | null = null,
): number {
  const revokedSources = new Set(revoked.sourceIds);
  const revokedRoots = new Set(revoked.storageRootIds);
  if (revokedSources.size === 0 && revokedRoots.size === 0) return 0;

  const current = readSourcesFile(filePath, protector).sources;
  const next: GatewaySourceConfig[] = [];
  let changed = 0;

  for (const cfg of current) {
    // Read is served under sourceId; write under storageRootId. A write-only
    // folder is KEYED by its storage root id (see applyPendingAuthorizations),
    // so that id can appear in either field — both are checked.
    const lostRead = revokedSources.has(cfg.sourceId);
    const lostWrite =
      (cfg.storageRootId !== undefined && revokedRoots.has(cfg.storageRootId)) ||
      (cfg.storageRootId === undefined && revokedRoots.has(cfg.sourceId));
    if (!lostRead && !lostWrite) {
      next.push(cfg);
      continue;
    }

    const keepsRead = canRead(cfg) && !lostRead;
    const keepsWrite = canWrite(cfg) && !lostWrite;
    changed += 1;
    if (!keepsRead && !keepsWrite) continue; // nothing left: the entry goes
    const { storageRootId: _dropped, ...rest } = cfg;
    next.push({
      ...rest,
      access: keepsRead && keepsWrite ? 'both' : keepsRead ? 'read' : 'write',
      ...(keepsWrite && cfg.storageRootId !== undefined ? { storageRootId: cfg.storageRootId } : {}),
    });
  }

  if (changed > 0) writeSourcesFile(filePath, next, protector);
  return changed;
}

/** Env (GATEWAY_SOURCES, Docker/dev/CI) wins when set; otherwise the file. */
export function loadEffectiveSourceConfig(
  sourcesFilePath: string,
  env: NodeJS.ProcessEnv = process.env,
  protector: SecretProtector | null = null,
): GatewaySourceConfig[] {
  if (env.GATEWAY_SOURCES?.trim()) return loadSourceConfig(env);
  return loadSourceConfigFromFile(sourcesFilePath, protector);
}
