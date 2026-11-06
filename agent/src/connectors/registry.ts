import type { DataConnector, DataSourceKind } from '@dpdp/shared';
import { ConnectorError, FilesystemConnector } from './filesystem-connector';
import { DatabaseConnector } from './db/database-connector';
import { dialectFor } from './db/dialect';
import { realDbClientFactory, type DbClientFactory, type DbConnection } from './db/db-client';

/**
 * Agent-local configuration of a source: which connector kind serves it, and
 * either the allowed filesystem roots (file kinds) OR the database connection
 * settings (db kinds). Set by the operator during the one-time integration, from
 * local config/env — NEVER a path/credential the browser sends, and NEVER tied to
 * a specific network address. Database CREDENTIALS live only here, inside the
 * Gateway (customer environment); they never leave it.
 */
export interface GatewaySourceConfig {
  sourceId: string;
  kind: DataSourceKind;
  roots?: string[];
  connection?: DbConnection;
  /**
   * Phase 3G-2: customer resolve/write/create configuration — entirely
   * agent-local, set by the operator, never sent by the browser and never
   * fetched from the central platform.
   */
  identityColumn?: string;
  allowCustomerCreate?: boolean;
  /** The explicit allowlist of columns writeCustomerFields/createCustomer may
   *  touch. Nothing outside this list is ever written, regardless of what a
   *  request asks for. */
  writableColumns?: string[];
  /** A SEPARATE, privileged credential for writes/schema changes. Absent means
   *  every write/create/column-create operation fails closed. */
  writeConnection?: DbConnection;
  /**
   * What the Gateway administrator explicitly allowed DPDP to do with this
   * entry's folder (Gateway Setup -> Manage sources):
   *   'read'  (DEFAULT, and what every entry saved before this field existed
   *           means) — a data source, served by the data plane only;
   *   'write' — a storage location ONLY: DPDP may write submitted consent data
   *           into it through the storage plane, and can never read it;
   *   'both'  — both, each through its own plane and its own DPDP record.
   * Read never implies write and write never implies read: each plane only
   * ever sees the entries canRead()/canWrite() let through.
   */
  access?: SourceAccess;
  /** The DPDP storage location (storage_roots.id, a Gateway-provider root)
   *  this folder is the writable destination for. Required with write access,
   *  forbidden without it. */
  storageRootId?: string;
}

export const SOURCE_ACCESS = ['read', 'write', 'both'] as const;
export type SourceAccess = (typeof SOURCE_ACCESS)[number];

/** Absent access is 'read' — existing entries keep exactly their old meaning. */
export function canRead(cfg: Pick<GatewaySourceConfig, 'access'>): boolean {
  return cfg.access === undefined || cfg.access === 'read' || cfg.access === 'both';
}
/** Only an EXPLICIT 'write'/'both' grants write — never a default. */
export function canWrite(cfg: Pick<GatewaySourceConfig, 'access'>): boolean {
  return cfg.access === 'write' || cfg.access === 'both';
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const FILE_KINDS = new Set<DataSourceKind>(['csv', 'excel', 'filesystem']);
const DB_KINDS = new Set<DataSourceKind>(['postgresql', 'mysql', 'sqlserver']);

/**
 * Maps a sourceId to its DataConnector. One connector instance per source
 * (cached, so opaque handles issued during discover survive to a later read).
 * The registry is the ONLY place that knows "which connector serves this source",
 * so a new connector kind is added here and nowhere else.
 */
export class ConnectorRegistry {
  private readonly cache = new Map<string, DataConnector>();

  /** `dbClientFactory` is injectable so tests can drive DB connectors without a
   *  live database; production uses the real driver-backed factory. */
  /** `revoked` is consulted on EVERY lookup, not just at construction: a
   *  folder the customer removes in DPDP must stop being served without
   *  waiting for a service restart. Absent = nothing revoked (tests, dev). */
  constructor(
    private readonly sources: readonly GatewaySourceConfig[],
    private readonly dbClientFactory: DbClientFactory = realDbClientFactory,
    private readonly revoked: { has(id: string): boolean } = { has: () => false },
  ) {}

  /** Fail closed: an unconfigured source has no connector. */
  get(sourceId: string): DataConnector {
    // Revoked beats configured. Checked first so a stale local entry can
    // never outlive the customer's decision to remove the folder.
    if (this.revoked.has(sourceId)) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    const cfg = this.sources.find((s) => s.sourceId === sourceId);
    // A write-only folder is never readable, whoever built this registry.
    if (!cfg || !canRead(cfg)) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    let connector = this.cache.get(sourceId);
    if (!connector) {
      connector = createConnector(cfg, this.dbClientFactory);
      this.cache.set(sourceId, connector);
    }
    return connector;
  }
}

function createConnector(cfg: GatewaySourceConfig, dbClientFactory: DbClientFactory): DataConnector {
  if (FILE_KINDS.has(cfg.kind)) {
    if (!cfg.roots || cfg.roots.length === 0) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    return new FilesystemConnector(cfg.kind, cfg.roots);
  }
  if (DB_KINDS.has(cfg.kind)) {
    const dialect = dialectFor(cfg.kind);
    if (!dialect || !cfg.connection) throw new ConnectorError('SOURCE_NOT_AUTHORIZED');
    const conn = cfg.connection;
    const writeConn = cfg.writeConnection;
    return new DatabaseConnector(dialect, () => dbClientFactory(cfg.kind, conn), {
      identityColumn: cfg.identityColumn,
      allowCustomerCreate: cfg.allowCustomerCreate,
      writableColumns: cfg.writableColumns,
      // A SEPARATE credential — never falls back to the read-only connection.
      makeWriteClient: writeConn ? () => dbClientFactory(cfg.kind, writeConn) : undefined,
    });
  }
  // Oracle / MongoDB / ERP / CRM etc. are not implemented — fail closed. Adding
  // one is a new dialect + client here; the browser and central platform never change.
  throw new ConnectorError('UNSUPPORTED_SOURCE');
}

/**
 * The shared validation body — used by BOTH the env-var path (loadSourceConfig,
 * unchanged, still the only thing Docker/dev ever sets) and the file-based
 * path (sources-file.ts, which also handles the encrypted on-disk format and
 * deliberately lives outside connectors/ so this directory never gains a
 * file-write path). One parser, two places entries can come from — not a
 * second, divergent implementation of "what a valid source entry looks
 * like". `label` is only used in error messages, so a failure names WHICH
 * source actually had the problem (the env var, or the exact file path).
 */
export function parseSourceConfigEntries(parsed: unknown, label: string): GatewaySourceConfig[] {
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed.map((entry) => {
    const e = entry as Record<string, unknown>;
    if (typeof e.sourceId !== 'string' || typeof e.kind !== 'string') {
      throw new Error(`Each entry in ${label} needs { sourceId, kind }.`);
    }
    const kind = e.kind as DataSourceKind;
    const cfg: GatewaySourceConfig = { sourceId: e.sourceId, kind };
    if (Array.isArray(e.roots)) cfg.roots = e.roots.map(String);
    // DB connection settings live locally, in this config, only. Never logged,
    // never sent to the browser or Azure.
    if (e.connection && typeof e.connection === 'object') {
      cfg.connection = parseConnection(e.connection as Record<string, unknown>);
    }
    // Phase 3G-2: identity/writable-column/creation config + the SEPARATE
    // privileged write credential — all agent-local, all optional.
    if (typeof e.identityColumn === 'string') cfg.identityColumn = e.identityColumn;
    if (e.allowCustomerCreate !== undefined) cfg.allowCustomerCreate = Boolean(e.allowCustomerCreate);
    if (Array.isArray(e.writableColumns)) cfg.writableColumns = e.writableColumns.map(String);
    if (e.writeConnection && typeof e.writeConnection === 'object') {
      cfg.writeConnection = parseConnection(e.writeConnection as Record<string, unknown>);
    }
    parseAccess(e, cfg, label);
    return cfg;
  });
}

/** Folder write authorization. Fails closed on anything ambiguous, so an
 *  entry can never end up writable by accident or by a typo. */
function parseAccess(e: Record<string, unknown>, cfg: GatewaySourceConfig, label: string): void {
  const where = `source "${cfg.sourceId}" in ${label}`;
  if (e.access !== undefined) {
    if (typeof e.access !== 'string' || !(SOURCE_ACCESS as readonly string[]).includes(e.access)) {
      throw new Error(`"access" for ${where} must be one of: ${SOURCE_ACCESS.join(', ')}.`);
    }
    cfg.access = e.access as SourceAccess;
  }
  if (!canWrite(cfg)) {
    if (e.storageRootId !== undefined) throw new Error(`"storageRootId" for ${where} is only allowed with write access.`);
    return;
  }
  if (!FILE_KINDS.has(cfg.kind)) throw new Error(`Write access for ${where} is only possible for a folder, not a database.`);
  if (!cfg.roots || cfg.roots.length !== 1 || !cfg.roots[0]!.trim()) {
    throw new Error(`Write access for ${where} needs exactly one folder.`);
  }
  if (typeof e.storageRootId !== 'string' || !ID_PATTERN.test(e.storageRootId)) {
    throw new Error(`Write access for ${where} needs the DPDP storage location ID ("storageRootId").`);
  }
  cfg.storageRootId = e.storageRootId;
}

/** Parse agent source config from an env var (JSON). Network-agnostic; the
 *  operator supplies sourceId/kind/roots. Empty if unset. Unchanged — still
 *  exactly what Docker/dev/CI have always set via GATEWAY_SOURCES. */
export function loadSourceConfig(env: NodeJS.ProcessEnv = process.env): GatewaySourceConfig[] {
  const raw = env.GATEWAY_SOURCES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GATEWAY_SOURCES must be valid JSON: [{ "sourceId", "kind", "roots": [] }].');
  }
  return parseSourceConfigEntries(parsed, 'GATEWAY_SOURCES');
}

function parseConnection(c: Record<string, unknown>): DbConnection {
  const conn: DbConnection = {
    host: String(c.host ?? ''),
    port: Number(c.port ?? 0),
    user: String(c.user ?? ''),
    password: String(c.password ?? ''),
    database: String(c.database ?? ''),
    ...(c.ssl !== undefined ? { ssl: Boolean(c.ssl) } : {}),
  };
  if (c.sslCaFile !== undefined) {
    if (typeof c.sslCaFile !== 'string' || !c.sslCaFile.trim() || c.sslCaFile.includes('\0')) {
      throw new Error('"sslCaFile" must be a non-empty file name.');
    }
    // A CA without TLS would be silently meaningless; refuse rather than guess.
    if (conn.ssl !== true) throw new Error('"sslCaFile" requires "ssl": true on the same connection.');
    conn.sslCaFile = c.sslCaFile.trim();
  }
  return conn;
}
